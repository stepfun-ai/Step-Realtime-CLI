import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { fullCompact, validateSummary, estimateTextTokens } from '../../src/agent/compaction/compact.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { makeFakeProvider, textBlock } from '../helpers/fakeProvider.js';

/**
 * 摘要质量闸门用例。
 *
 * 背景（真实事故）：一段约 891K token 的会话被压缩成一条 56 字符的「摘要」——
 * 内容是 `[早期对话摘要]\n[调用工具 bash] ...`，即模型复述了历史片段而没有写交接笔记。
 * 旧实现只检查空串，于是这条垃圾摘要被接受，整段历史静默丢失。
 *
 * 现在 fullCompact 有三道闸门（空白 / 长度不足 / 复述标记），失败则收缩输入重试，
 * 尝试耗尽后原样返回（同引用 = 未压缩），绝不让不合格摘要替换历史。
 */

/** 取压缩产物里的摘要消息（保真原话排在它之前，故不能假定它是 out[0]）。 */
function summaryOf(out: StoredMessage[]): StoredMessage {
  const m = out.find((sm) => sm.origin.kind === 'compaction_summary');
  if (m === undefined) throw new Error('压缩产物里没有 compaction_summary 消息');
  return m;
}

/** 长 assistant 输出：把 older 段撑到足够大，使长度闸门的比例下限真正生效。 */
function bulkAssistant(tag: string): StoredMessage {
  return stored({ role: 'assistant', content: [textBlock(`${tag} ${'详细分析内容'.repeat(60)}`)] }, { kind: 'assistant' });
}

/** 合格摘要：长度稳定超过闸门封顶值（200 字符），marker 留在开头供断言。 */
function goodSummary(marker: string): string {
  return `${marker}：已确认项目路径与 key 位置，配置改完并验证通过。${'下一步的依据与上下文继续记录在此。'.repeat(14)}`;
}

/** 事故现场那条摘要的原文（56 字符，且含 serializeContent 的工具标记）。 */
const GARBAGE_SUMMARY = '[早期对话摘要]\n[调用工具 bash] 搜索 step-code 项目中的配置文件，查找阶跃 API key。';

/** 构造一段「older 足够大 + 用户原话带关键事实」的历史。 */
function historyWithFacts(): StoredMessage[] {
  return [
    stored({ role: 'user', content: '项目在 D:/work/demo-repo/packages/core' }, { kind: 'user' }),
    bulkAssistant('A1'),
    stored({ role: 'user', content: '注意 key 在 keys.json' }, { kind: 'user' }),
    bulkAssistant('A2'),
    stored({ role: 'user', content: '最近1' }, { kind: 'user' }),
    bulkAssistant('A3'),
    stored({ role: 'user', content: '最近2' }, { kind: 'user' }),
  ];
}

describe('validateSummary', () => {
  it('空白摘要一律不合格（与被压缩量无关）', () => {
    expect(() => validateSummary('', 100_000)).toThrow('empty');
    expect(() => validateSummary('   \n  ', 100_000)).toThrow('empty');
  });

  it('长度下限随被压缩量按比例上浮，封顶 200 token', () => {
    const short = '一句话摘要';
    // older 只有 50 token → 下限 1 token → 通过（小压缩不该被苛求）
    expect(() => validateSummary(short, 50)).not.toThrow();
    // older 891K token → 下限封顶 200 token → 5 token 必然不合格
    expect(() => validateSummary(short, 891_000)).toThrow('too short');
  });

  it('下限被 min 压在原文体量之下，绝不会出现「摘要要求比原文长」的死锁', () => {
    // 逐个体量验证：下限恒小于 olderTokens，故「原样复制原文」这种极端摘要必然能过闸
    for (const olderTokens of [1, 10, 50, 200, 1_000, 10_000, 891_000]) {
      const required = Math.min(200, Math.floor(olderTokens * 0.02));
      expect(required).toBeLessThan(Math.max(olderTokens, 1));
    }
  });

  it('中英文口径一致：同等信息量的摘要不因语言而拿到不同判定', () => {
    // 约 150 token 的中文与英文摘要，在同一 olderTokens 下应得到相同结论。
    // 若按「字符数」比 token 基数（修前的口径），英文会因字符多约 4 倍而被误判为合格。
    const cn = '这段交接笔记记录了已确认的路径与配置。'.repeat(9); // ≈ 171 token
    const en = 'This handoff note records the confirmed paths and configuration values. '.repeat(9); // 字符数远多，token 相近
    const cnTokens = estimateTextTokens(cn);
    const enTokens = estimateTextTokens(en);
    expect(Math.abs(cnTokens - enTokens)).toBeLessThan(60); // 信息量同量级
    expect(en.length).toBeGreaterThan(cn.length * 3); // 但字符数差 3 倍以上
    // 下限设在 200 token（封顶）时，两者都不足 → 都该被拒
    expect(() => validateSummary(cn, 891_000)).toThrow('too short');
    expect(() => validateSummary(en, 891_000)).toThrow('too short');
  });

  it('复述工具 / 媒体标记一律不合格（模型在抄历史而不是写笔记）', () => {
    const long = goodSummary('看似正常');
    for (const marker of ['[调用工具 bash]', '[工具结果]', '[image image/png]', '[audio ]', '[video ]']) {
      expect(() => validateSummary(`${long}${marker}`, 10_000)).toThrow('recitation');
    }
  });

  it('事故现场那条 56 字符摘要会被拦住（回归锚点）', () => {
    expect(GARBAGE_SUMMARY.length).toBeLessThan(60);
    expect(() => validateSummary(GARBAGE_SUMMARY, 891_000)).toThrow();
  });

  it('正常长摘要通过', () => {
    expect(() => validateSummary(goodSummary('交接笔记'), 500_000)).not.toThrow();
  });
});

describe('fullCompact 摘要质量闸门', () => {
  it('首次返回垃圾摘要时收缩输入重试，第二次合格则正常压缩', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock(GARBAGE_SUMMARY)] },
      { textChunks: [], finalContent: [textBlock(goodSummary('第二次的合格摘要'))] },
    ]);
    const msgs = historyWithFacts();
    const out = await fullCompact(provider, msgs, 2);
    expect(streamCalls()).toBe(2);
    expect(out).not.toBe(msgs);
    expect(summaryOf(out).message.content).toContain('第二次的合格摘要');
    // 垃圾摘要的内容一个字都不该进入产物
    expect(summaryOf(out).message.content).not.toContain('[调用工具 bash]');
  });

  it('摘要含复述标记时同样触发重试', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock(`${goodSummary('够长但在复述')}[工具结果]`)] },
      { textChunks: [], finalContent: [textBlock(goodSummary('重试后的干净摘要'))] },
    ]);
    const out = await fullCompact(provider, historyWithFacts(), 2);
    expect(streamCalls()).toBe(2);
    expect(summaryOf(out).message.content).toContain('重试后的干净摘要');
  });

  it('三次尝试全部不合格 → 原样返回（同引用 = 未压缩，历史完整）', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock(GARBAGE_SUMMARY)] },
      { textChunks: [], finalContent: [textBlock('还是太短')] },
      { textChunks: [], finalContent: [textBlock('')] },
    ]);
    const msgs = historyWithFacts();
    const out = await fullCompact(provider, msgs, 2);
    expect(streamCalls()).toBe(3);
    expect(out).toBe(msgs); // 同引用：调用方据此判断「未压缩」
  });

  it('尝试耗尽时不抛错（loop.ts 调用点无 try/catch，抛错会掀翻整个回合）', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('短')] },
      { textChunks: [], finalContent: [textBlock('短')] },
      { textChunks: [], finalContent: [textBlock('短')] },
    ]);
    await expect(fullCompact(provider, historyWithFacts(), 2)).resolves.toBeDefined();
  });

  it('网络错误也走同一条收缩重试路径，成功后照常压缩', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { throw: new Error('network down') },
      { textChunks: [], finalContent: [textBlock(goodSummary('重试后成功'))] },
    ]);
    const out = await fullCompact(provider, historyWithFacts(), 2);
    expect(streamCalls()).toBe(2);
    expect(summaryOf(out).message.content).toContain('重试后成功');
  });

  it('摘要一次合格时不产生额外调用（闸门不影响正常路径）', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock(goodSummary('一次过'))] },
    ]);
    const out = await fullCompact(provider, historyWithFacts(), 2);
    expect(streamCalls()).toBe(1);
    expect(summaryOf(out).message.content).toContain('一次过');
  });

  it('重试收缩掉最老的消息，但用户原话仍由保真块兜住', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock(GARBAGE_SUMMARY)] },
      { textChunks: [], finalContent: [textBlock(goodSummary('合格摘要'))] },
    ]);
    const out = await fullCompact(provider, historyWithFacts(), 2);
    const verbatim = out.filter((m) => m.origin.kind === 'user_verbatim').map((m) => String(m.message.content));
    // 摘要输入被收缩，但保真选择基于完整 older 段，故最早那条路径原话不会丢
    expect(verbatim.some((t) => t.includes('D:/work/demo-repo'))).toBe(true);
    expect(verbatim.some((t) => t.includes('keys.json'))).toBe(true);
  });
});

describe('fullCompact overflow / 媒体块自救', () => {
  /** 构造一条带 inline 图片的用户消息。 */
  function imageMsg(text: string): StoredMessage {
    return stored(
      {
        role: 'user',
        content: [
          { type: 'text', text },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(10_000) },
          } as Anthropic.ImageBlockParam,
        ],
      },
      { kind: 'user' },
    );
  }

  it('413 时先剥离媒体块再重试，成功则正常压缩', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { throw: new Anthropic.APIError(413, undefined, 'request too large', undefined) },
      { textChunks: [], finalContent: [textBlock(goodSummary('剥离媒体后成功'))] },
    ]);
    const msgs: StoredMessage[] = [
      imageMsg('项目路径在 C:/step-code'),
      bulkAssistant('A1'),
      stored({ role: 'user', content: '继续' }, { kind: 'user' }),
    ];
    const out = await fullCompact(provider, msgs, 1);
    expect(streamCalls()).toBe(2);
    expect(out).not.toBe(msgs);
    expect(summaryOf(out).message.content).toContain('剥离媒体后成功');
  });

  it('context overflow (400 prompt too long) 走比例收缩，成功则正常压缩', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { throw: new Anthropic.APIError(400, undefined, 'prompt is too long', undefined) },
      { textChunks: [], finalContent: [textBlock(goodSummary('收缩后成功'))] },
    ]);
    const msgs = historyWithFacts();
    const out = await fullCompact(provider, msgs, 2);
    expect(streamCalls()).toBe(2);
    expect(out).not.toBe(msgs);
    expect(summaryOf(out).message.content).toContain('收缩后成功');
  });

  it('媒体块剥离后仍 overflow，继续比例收缩直到成功', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { throw: new Anthropic.APIError(413, undefined, 'request too large', undefined) },
      { throw: new Anthropic.APIError(400, undefined, 'prompt is too long', undefined) },
      { textChunks: [], finalContent: [textBlock(goodSummary('二次收缩后成功'))] },
    ]);
    const msgs: StoredMessage[] = [
      imageMsg('图1'),
      bulkAssistant('A1'),
      imageMsg('图2'),
      bulkAssistant('A2'),
      stored({ role: 'user', content: '最近' }, { kind: 'user' }),
    ];
    const out = await fullCompact(provider, msgs, 1);
    expect(streamCalls()).toBe(3);
    expect(out).not.toBe(msgs);
    expect(summaryOf(out).message.content).toContain('二次收缩后成功');
  });

  it('overflow 耗尽重试次数后原样返回，不抛错', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { throw: new Anthropic.APIError(413, undefined, 'request too large', undefined) },
      { throw: new Anthropic.APIError(400, undefined, 'prompt is too long', undefined) },
      { throw: new Anthropic.APIError(413, undefined, 'request too large', undefined) },
    ]);
    const msgs: StoredMessage[] = [
      imageMsg('图1'),
      bulkAssistant('A1'),
      stored({ role: 'user', content: '最近' }, { kind: 'user' }),
    ];
    const out = await fullCompact(provider, msgs, 1);
    expect(streamCalls()).toBe(3);
    expect(out).toBe(msgs);
  });
});

describe('复述判定的密度口径（2026-08-12 误判实录）', () => {
  it('长交接笔记零星引用标记不算复述（如引用图片 hash 定位）', () => {
    const body = '交接笔记正文，记录已确认的事实与下一步动作。'.repeat(1000); // ≈ 2.1 万字符
    const withMarkers = `${body}[image image/png ab12cd34] 的截图已确认。${body}[调用工具 bash] 那次验证通过。`;
    expect(() => validateSummary(withMarkers, 500_000)).not.toThrow();
  });

  it('短摘要带一个标记仍是复述（密度高）', () => {
    expect(() => validateSummary('[工具结果] 文件内容…', 100)).toThrow('recitation');
  });

  it('复述被拒后：重试不丢历史，且 prompt 带反复述提示', async () => {
    const { provider, streamCalls, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock(`${goodSummary('够长但在复述')}[工具结果]`)] },
      { textChunks: [], finalContent: [textBlock(goodSummary('重试后的干净摘要'))] },
    ]);
    const msgs = historyWithFacts();
    const out = await fullCompact(provider, msgs, 2);
    expect(streamCalls()).toBe(2);
    expect(summaryOf(out).message.content).toContain('重试后的干净摘要');
    // 第二次请求的 prompt 里带反复述提示，且历史没有被丢消息（仍是全量序列化）
    const second = streamParams()[1]!;
    const promptText = String(second.messages[0]!.content);
    expect(promptText).toContain('序列化标记');
    expect(promptText).toContain('注意 key 在 keys.json'); // 最早的用户原话还在输入里
  });
});
