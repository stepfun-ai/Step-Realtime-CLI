import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  billedTokens,
  createElisionMessage,
  estimateTextTokens,
  estimateTokens,
  fullCompact,
  isAckOnlyText,
  isCompactableUserOrigin,
  microCompact,
  selectCompactionUserMessages,
  serializeContent,
  shouldCompact,
  usageTotalTokens,
} from '../../src/agent/compaction/compact.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { makeFakeProvider, textBlock } from '../helpers/fakeProvider.js';

/** 取压缩产物里的摘要消息（保真消息排在它之前，故不能再假定它是 out[0]）。 */
function summaryOf(out: StoredMessage[]): StoredMessage {
  const m = out.find((sm) => sm.origin.kind === 'compaction_summary');
  if (m === undefined) throw new Error('压缩产物里没有 compaction_summary 消息');
  return m;
}

function toolResultMsg(id: string, content: string): StoredMessage {
  return stored({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, { kind: 'tool' });
}

/**
 * 构造正文足够长（≥ MICRO_MIN_CONTENT_TOKENS）的 tool_result，用于验证 micro 清理行为。
 * micro 压缩有净收益门槛：短结果不清，故验证「会清」的用例必须用大结果。
 */
function bigToolResultMsg(id: string, marker = 'DATA'): StoredMessage {
  return toolResultMsg(id, `${marker} `.repeat(200));
}

/** 构造一条「文本 + 图片」的用户消息，图片 source.data 取传入值（base64 或 stepref）。 */
function imageMsg(data: string): StoredMessage {
  return stored(
    {
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
      ],
    },
    { kind: 'user' },
  );
}

describe('estimateTextTokens', () => {
  it('空串为 0', () => {
    expect(estimateTextTokens('')).toBe(0);
  });

  it('纯 ASCII 按 ÷4 向上取整', () => {
    expect(estimateTextTokens('abcd')).toBe(1); // 4/4
    expect(estimateTextTokens('abcdefgh')).toBe(2); // 8/4
    expect(estimateTextTokens('abcde')).toBe(2); // ceil(5/4)
  });

  it('纯中文（非 ASCII）每字符 1 token', () => {
    expect(estimateTextTokens('你好')).toBe(2);
    expect(estimateTextTokens('中文测试字符')).toBe(6);
  });

  it('中英混合 = ceil(ascii/4) + 非 ASCII 数', () => {
    // 'ab你好cd'：ascii=4 → 1，非 ascii=2 → 2，合计 3
    expect(estimateTextTokens('ab你好cd')).toBe(3);
  });

  it('emoji 等代理对按单个非 ASCII 字符计（for..of 按 code point 迭代）', () => {
    expect(estimateTextTokens('😀')).toBe(1);
    expect(estimateTextTokens('hi😀')).toBe(estimateTextTokens('hi') + 1);
  });

  it('中文估算比旧 chars/3 口径更高（不再对中文偏低）', () => {
    const cn = '这是一段中文文本用于对比估算口径';
    // 旧口径 ceil(len/3)，新分桶对纯中文 = len，必然更大
    expect(estimateTextTokens(cn)).toBeGreaterThan(Math.ceil(cn.length / 3));
    expect(estimateTextTokens(cn)).toBe(cn.length);
  });
});

describe('estimateTokens', () => {
  it('随内容增大而增大，空历史为 0', () => {
    expect(estimateTokens([])).toBe(0);
    const small = estimateTokens([stored({ role: 'user', content: 'hi' }, { kind: 'user' })]);
    const big = estimateTokens([stored({ role: 'user', content: 'x'.repeat(3000) }, { kind: 'user' })]);
    expect(big).toBeGreaterThan(small);
  });

  it('图片块按固定常数（1500）估算，与 base64/stepref 字符数无关', () => {
    const textOnly = estimateTokens([
      stored({ role: 'user', content: [{ type: 'text', text: '看图' }] }, { kind: 'user' }),
    ]);
    const expected = textOnly + 1500; // PER_IMAGE_TOKENS（compact.ts 内部常数）
    const big = imageMsg(Buffer.alloc(4000, 7).toString('base64'));
    const small = imageMsg(Buffer.alloc(10, 7).toString('base64'));
    const ref = imageMsg(`stepref:${'a'.repeat(64)}`);
    expect(estimateTokens([big])).toBe(expected);
    expect(estimateTokens([small])).toBe(expected);
    expect(estimateTokens([ref])).toBe(expected);
    // 反向锚定：若退回按 base64 字符数估算，4000 字节图会被估到 1700+ 字符/3 ≈ 数倍于此
    expect(estimateTokens([big])).toBeLessThan(2000);
  });
});

describe('usageTotalTokens', () => {
  it('累加输入 / 输出 / 缓存读写 token', () => {
    expect(
      usageTotalTokens({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 3,
      } as Anthropic.Usage),
    ).toBe(128);
  });

  it('缺失字段按 0 处理', () => {
    expect(usageTotalTokens({ input_tokens: 10, output_tokens: 5 } as Anthropic.Usage)).toBe(15);
  });
});

describe('billedTokens（计费口径：input + output；input_tokens 本身已排除缓存命中部分）', () => {
  it('cache_read 存在时仍只计 input + output（不重复减去缓存读）', () => {
    expect(
      billedTokens({
        input_tokens: 100,
        cache_read_input_tokens: 100,
        output_tokens: 20,
      } as Anthropic.Usage),
    ).toBe(120);
  });

  it('无 cache 字段：input + output', () => {
    expect(billedTokens({ input_tokens: 100, output_tokens: 20 } as Anthropic.Usage)).toBe(120);
  });

  it('全缓存命中（input_tokens=0）：增量只剩 output', () => {
    expect(
      billedTokens({
        input_tokens: 0,
        cache_read_input_tokens: 100,
        output_tokens: 20,
      } as Anthropic.Usage),
    ).toBe(20);
  });

  it('cache_creation 不计入计费（仅 input + output）', () => {
    expect(
      billedTokens({
        input_tokens: 100,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 25,
        output_tokens: 10,
      } as Anthropic.Usage),
    ).toBe(110);
  });

  it('缺失字段按 0 处理，结果恒为非负', () => {
    expect(billedTokens({} as Anthropic.Usage)).toBe(0);
    expect(billedTokens({ output_tokens: 5 } as Anthropic.Usage)).toBe(5);
  });
});

describe('shouldCompact', () => {
  const t = { maxContextSize: 1000, triggerRatio: 0.85, reservedTokens: 100 };
  it('低于比例阈值且剩余充足 → 不压', () => {
    expect(shouldCompact(800, t)).toBe(false);
  });
  it('超过比例阈值 → 压', () => {
    expect(shouldCompact(860, t)).toBe(true);
  });
  it('剩余窗口不足预留量 → 压', () => {
    expect(shouldCompact(905, t)).toBe(true); // 905 + 100 >= 1000
  });
  it('maxContextSize <= 0 → 从不压（避免误判）', () => {
    expect(shouldCompact(999, { ...t, maxContextSize: 0 })).toBe(false);
  });
});

describe('microCompact', () => {
  it('清空较旧 tool_result 正文，保留最近 keepRecent 条', () => {
    const msgs: StoredMessage[] = [
      bigToolResultMsg('a', 'OLD-A'),
      bigToolResultMsg('b', 'OLD-B'),
      stored({ role: 'assistant', content: [textBlock('中间')] }, { kind: 'assistant' }),
      toolResultMsg('c', 'RECENT-C'),
    ];
    const { messages, clearedCount } = microCompact(msgs, 2);
    expect(clearedCount).toBe(2);
    const first = messages[0]!.message.content as Anthropic.ToolResultBlockParam[];
    expect(first[0]!.content).toContain('已清理');
    const last = messages[3]!.message.content as Anthropic.ToolResultBlockParam[];
    expect(last[0]!.content).toBe('RECENT-C');
  });

  it('不改动入参，且重复压缩不重复计数', () => {
    const msgs: StoredMessage[] = [
      bigToolResultMsg('a'),
      bigToolResultMsg('b'),
      bigToolResultMsg('c'),
    ];
    const before = JSON.stringify(msgs);
    const first = microCompact(msgs, 1);
    expect(JSON.stringify(msgs)).toBe(before);
    const second = microCompact(first.messages, 1);
    expect(second.clearedCount).toBe(0);
  });

  it('净收益门槛：小于 minContentTokens 的 tool_result 不清（省不下 token 还丢信息）', () => {
    const msgs: StoredMessage[] = [
      toolResultMsg('a', 'exit 0'),
      toolResultMsg('b', '/tmp/x.log'),
      toolResultMsg('c', 'RECENT'),
    ];
    const r = microCompact(msgs, 1);
    expect(r.clearedCount).toBe(0);
    expect(r.messages).toEqual(msgs); // 内容一字未改（数组本身是 map 产物，非同引用）
  });

  it('净收益门槛可下调：显式 minContentTokens=1 时小结果也清（溢出保命路径口径）', () => {
    const msgs: StoredMessage[] = [
      toolResultMsg('a', 'exit 0'),
      toolResultMsg('b', '/tmp/x.log'),
      toolResultMsg('c', 'RECENT'),
    ];
    const r = microCompact(msgs, 1, undefined, 1);
    expect(r.clearedCount).toBe(2);
  });

  it('缓存冷 gate：缓存仍热时跳过改写（clearedCount 0，原样返回）', () => {
    const msgs: StoredMessage[] = [
      bigToolResultMsg('a', 'OLD-A'),
      bigToolResultMsg('b', 'OLD-B'),
      toolResultMsg('c', 'RECENT'),
    ];
    const now = 1_000_000_000_000;
    // 上次活动就在 1 分钟前 → 缓存热 → 跳过
    const hot = microCompact(msgs, 1, { lastActivityMs: now - 60_000, nowMs: now });
    expect(hot.clearedCount).toBe(0);
    expect(hot.messages).toBe(msgs); // 原样返回同引用
  });

  it('缓存冷 gate：距上次活动超阈值时照常改写', () => {
    const msgs: StoredMessage[] = [
      bigToolResultMsg('a', 'OLD-A'),
      bigToolResultMsg('b', 'OLD-B'),
      toolResultMsg('c', 'RECENT'),
    ];
    const now = 1_000_000_000_000;
    // 上次活动在 2 小时前 → 缓存冷 → 照常清理旧 tool_result
    const cold = microCompact(msgs, 1, { lastActivityMs: now - 2 * 60 * 60 * 1000, nowMs: now });
    expect(cold.clearedCount).toBe(2);
  });

  it('不传 cacheGate 时无条件改写（溢出保命路径）', () => {
    const msgs: StoredMessage[] = [bigToolResultMsg('a'), bigToolResultMsg('b'), toolResultMsg('c', 'X')];
    const r = microCompact(msgs, 1);
    expect(r.clearedCount).toBe(2);
  });
});

describe('fullCompact', () => {
  it('把较旧对话替换为模型摘要 + 保留最近消息', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('摘要：用户建了文件 X，代号 ORION。')] },
    ]);
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: '建文件' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('好的')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '代号 ORION' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('记住了')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '最近1' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('最近2')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '最近3' }, { kind: 'user' }),
    ];
    const out = await fullCompact(provider, msgs, 2);
    const summary = summaryOf(out);
    expect(summary.message.content).toContain('早期对话摘要');
    expect(summary.message.content).toContain('ORION');
    expect(out.at(-1)!.message.content).toBe('最近3');
  });

  it('切点安全：遇 tool_result 边界往后挪，不产生孤儿 tool_result', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('早期摘要正文')] },
    ]);
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: '开始任务' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] }, { kind: 'assistant' }),
      stored({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r1' }] }, { kind: 'tool' }),
      stored({ role: 'assistant', content: [textBlock('读完了')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '继续' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('好')] }, { kind: 'assistant' }),
    ];
    // keepRecent=4 → desired cutoff = 2，正落在 tool_result 上 → safeCutoff 挪到 3
    const out = await fullCompact(provider, msgs, 4);
    const orphan = out.some(
      (sm) =>
        sm.message.role === 'user' &&
        Array.isArray(sm.message.content) &&
        sm.message.content.some((b) => b.type === 'tool_result'),
    );
    expect(orphan).toBe(false); // tool_result 已随其 tool_use 一起被摘要吞掉
    expect(summaryOf(out).message.content).toContain('早期对话摘要');
  });

  it('历史过短时原样返回', async () => {
    const { provider } = makeFakeProvider([]);
    const msgs: StoredMessage[] = [stored({ role: 'user', content: 'hi' }, { kind: 'user' })];
    const out = await fullCompact(provider, msgs, 6);
    expect(out).toEqual(msgs);
  });

  it('摘要失败时原样返回（不丢历史）', async () => {
    const { provider } = makeFakeProvider([{ throw: new Error('boom') }]);
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: 'a' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('b')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: 'c' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('d')] }, { kind: 'assistant' }),
    ];
    const out = await fullCompact(provider, msgs, 2);
    expect(out).toBe(msgs); // 同引用 = 未压缩
  });

  it('提供 todos 时把清单拼进摘要尾部', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('摘要正文')] },
    ]);
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: '开始' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('好')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '最近1' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('最近2')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '最近3' }, { kind: 'user' }),
    ];
    const out = await fullCompact(provider, msgs, 2, [
      { title: '实现登录', status: 'in_progress' },
      { title: '写测试', status: 'pending' },
    ]);
    const content = summaryOf(out).message.content as string;
    expect(content).toContain('## TODO List');
    expect(content).toContain('实现登录');
  });

  it('摘要 prompt 里图片渲染为带 hash 的 marker（不降级成字面 [image]、不内联 base64）', async () => {
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('摘要')] },
    ]);
    const msgs: StoredMessage[] = [
      imageMsg('stepref:abcd1234ef567890'),
      stored({ role: 'assistant', content: [textBlock('看到了')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '最近1' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('最近2')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '最近3' }, { kind: 'user' }),
    ];
    await fullCompact(provider, msgs, 2);
    const prompt = (streamParams()[0]!['messages'] as Array<{ content: string }>)[0]!.content;
    expect(prompt).toContain('[image image/png abcd1234]');
    expect(prompt).not.toContain('stepref:abcd1234ef567890');
  });

  it('传入 model 时摘要调用带 model 覆盖（大小模型协同）', async () => {
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('早期摘要')] },
    ]);
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: '开始' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('好')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '最近1' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('最近2')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '最近3' }, { kind: 'user' }),
    ];
    const out = await fullCompact(provider, msgs, 2, undefined, 'step-flash');
    expect(summaryOf(out).origin.kind).toBe('compaction_summary');
    expect(streamParams()[0]!['model']).toBe('step-flash');
  });

  it('不传 model 时摘要调用不带 model（行为与之前一致）', async () => {
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('早期摘要')] },
    ]);
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: '开始' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('好')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '最近1' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('最近2')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '最近3' }, { kind: 'user' }),
    ];
    await fullCompact(provider, msgs, 2);
    expect(streamParams()[0]!['model']).toBeUndefined();
  });
});

describe('isAckOnlyText', () => {
  it('纯确认语命中（含尾部标点与大小写归一）', () => {
    for (const s of ['继续', '继续。', '好的', '好的！', ' 嗯 ', 'OK', 'ok.', 'Yes', '收到', 'thanks']) {
      expect(isAckOnlyText(s)).toBe(true);
    }
  });

  it('只有标点或空白也算无信息', () => {
    for (const s of ['', '   ', '。。。', '!!!']) expect(isAckOnlyText(s)).toBe(true);
  });

  it('载有信息的短消息不被误判（宁可留噪音，不可丢信号）', () => {
    for (const s of ['用方案 B', '改用 GPT', '继续用旧的', '好的方案是 A', 'ok 但要加超时', '路径是 /tmp/x']) {
      expect(isAckOnlyText(s)).toBe(false);
    }
  });
});

describe('isCompactableUserOrigin（对象 origin 的 kind 判定表）', () => {
  it('只收 user 与 user_verbatim，其余 kind 一律不收', () => {
    expect(isCompactableUserOrigin({ kind: 'user' })).toBe(true);
    expect(isCompactableUserOrigin({ kind: 'user_verbatim' })).toBe(true);
    expect(isCompactableUserOrigin({ kind: 'tool' })).toBe(false);
    expect(isCompactableUserOrigin({ kind: 'injection' })).toBe(false);
    expect(isCompactableUserOrigin({ kind: 'compaction_summary' })).toBe(false);
    expect(isCompactableUserOrigin({ kind: 'assistant' })).toBe(false);
    // background_task 通知不算用户真实输入，压缩时随普通内容进摘要
    expect(isCompactableUserOrigin({ kind: 'background_task', taskId: 't1' })).toBe(false);
  });
});

describe('selectCompactionUserMessages', () => {
  it('预算充足时全留在 tail，且 origin 落成 user_verbatim（可跨轮继承）', () => {
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: '第一条' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('回应')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '第二条' }, { kind: 'user' }),
    ];
    const sel = selectCompactionUserMessages(msgs);
    expect(sel.head).toEqual([]);
    expect(sel.tail.map((m) => m.message.content)).toEqual(['第一条', '第二条']);
    expect(sel.tail.every((m) => m.origin.kind === 'user_verbatim')).toBe(true);
    expect(sel.elided).toBe(false);
    expect(sel.omittedTokens).toBe(0);
  });

  it('收 user 与 user_verbatim，排除 tool / injection / 摘要 / assistant', () => {
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: '真实输入' }, { kind: 'user' }),
      stored({ role: 'user', content: '上一轮保真下来的原话' }, { kind: 'user_verbatim' }),
      toolResultMsg('t1', '工具结果'),
      stored({ role: 'user', content: '<system-reminder>注入</system-reminder>' }, { kind: 'injection' }),
      stored({ role: 'user', content: '[早期对话摘要] 旧摘要' }, { kind: 'compaction_summary' }),
      stored({ role: 'assistant', content: [textBlock('模型的话')] }, { kind: 'assistant' }),
    ];
    const sel = selectCompactionUserMessages(msgs);
    expect(sel.tail.map((m) => m.message.content)).toEqual(['真实输入', '上一轮保真下来的原话']);
  });

  it('纯确认语不占预算（避免稀释注意力）', () => {
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: '关键请求：路径在 /tmp/x' }, { kind: 'user' }),
      stored({ role: 'user', content: '继续' }, { kind: 'user' }),
      stored({ role: 'user', content: '好的' }, { kind: 'user' }),
      stored({ role: 'user', content: '再继续' }, { kind: 'user' }),
    ];
    const sel = selectCompactionUserMessages(msgs);
    // 「再继续」不在词表里（只有「继续」是），故保留；「继续」「好的」被滤掉
    expect(sel.tail.map((m) => m.message.content)).toEqual(['关键请求：路径在 /tmp/x', '再继续']);
  });

  it('预算不足时保最早 + 最近，中段丢弃并计入 omittedTokens', () => {
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: `A${'a'.repeat(399)}` }, { kind: 'user' }), // 每条 ≈100 token
      stored({ role: 'user', content: `B${'b'.repeat(399)}` }, { kind: 'user' }),
      stored({ role: 'user', content: `C${'c'.repeat(399)}` }, { kind: 'user' }),
      stored({ role: 'user', content: `D${'d'.repeat(399)}` }, { kind: 'user' }),
    ];
    const sel = selectCompactionUserMessages(msgs, 250, 100);
    expect(sel.elided).toBe(true);
    // 最早那条进 head、最近那条进 tail，中段被丢或截断
    expect((sel.head[0]!.message.content as string).startsWith('A')).toBe(true);
    expect((sel.tail.at(-1)!.message.content as string).endsWith('d')).toBe(true);
    expect(sel.omittedTokens).toBeGreaterThan(0);
  });

  it('单条超预算时按方向截断：最近消息留结尾并带截断标记', () => {
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: `${'X'.repeat(400)}关键收尾诉求` }, { kind: 'user' }),
    ];
    const sel = selectCompactionUserMessages(msgs, 40, 0);
    expect(sel.tail).toHaveLength(1);
    const text = sel.tail[0]!.message.content as string;
    expect(text.endsWith('关键收尾诉求')).toBe(true);
    expect(text).toContain('本条前半已截断');
  });

  it('大 paste 的丢弃前缀回收进 head：头尾都保住，只丢中间', () => {
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: `任务定义在开头${'M'.repeat(2000)}关键收尾在结尾` }, { kind: 'user' }),
    ];
    // 单条远超预算：tail 留结尾、被截掉的前缀回收进 head 留开头
    const sel = selectCompactionUserMessages(msgs, 100, 40);
    const headText = sel.head.map((m) => m.message.content as string).join('');
    const tailText = sel.tail.map((m) => m.message.content as string).join('');
    expect(headText).toContain('任务定义在开头');
    expect(tailText).toContain('关键收尾在结尾');
    expect(sel.omittedTokens).toBeGreaterThan(0);
  });

  it('预算为 0 时返回空选择（等于关闭保真）', () => {
    const msgs: StoredMessage[] = [stored({ role: 'user', content: '任何内容' }, { kind: 'user' })];
    const sel = selectCompactionUserMessages(msgs, 0);
    expect(sel).toEqual({ head: [], tail: [], elided: false, omittedTokens: 0 });
  });
});

describe('createElisionMessage', () => {
  it('用 injection origin（下一轮不当用户输入收集，故不层层累积）并写明省略规模', () => {
    const m = createElisionMessage(1234);
    expect(m.origin.kind).toBe('injection');
    const text = m.message.content as string;
    expect(text).toContain('<system-reminder>');
    expect(text).toContain('1234');
    expect(text).toContain('不要臆测');
  });
});

describe('fullCompact 用户原话保真', () => {
  /** 模拟真实历史里的长 assistant 输出（让 older 段以模型产出为主，用户原话占比低于守卫阈值）。 */
  function bulkAssistant(tag: string): StoredMessage {
    return stored({ role: 'assistant', content: [textBlock(`${tag} ${'详细分析内容'.repeat(40)}`)] }, { kind: 'assistant' });
  }

  /**
   * 构造能过摘要质量闸门的摘要文本：闸门下限随被压缩量按比例上浮（封顶 200 字符），
   * 本组用例的 older 段是 bulk 消息，故摘要必须够长。marker 保留在开头供断言。
   */
  function longSummary(marker: string): string {
    return `${marker}：已确认路径与配置，关键结论与下一步都记在案。${'继续补充这一步的依据与上下文。'.repeat(14)}`;
  }

  it('用户原话以独立 user_verbatim 消息保留，排在摘要之前', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('我已经确认了路径并改完了配置。')] },
    ]);
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: '项目在 C:/proj/step-code-suite 这个哈' }, { kind: 'user' }),
      bulkAssistant('A1'),
      stored({ role: 'user', content: '代号 ORION，别写成 ORLON' }, { kind: 'user' }),
      bulkAssistant('A2'),
      stored({ role: 'user', content: '最近1' }, { kind: 'user' }),
      bulkAssistant('A3'),
      stored({ role: 'user', content: '最近3' }, { kind: 'user' }),
    ];
    const out = await fullCompact(provider, msgs, 2);
    const verbatim = out.filter((m) => m.origin.kind === 'user_verbatim');
    const texts = verbatim.map((m) => m.message.content as string);
    // 原话保真：路径与代号原样在场，不是摘要转述
    expect(texts.some((t) => t.includes('C:/proj/step-code-suite'))).toBe(true);
    expect(texts.some((t) => t.includes('代号 ORION，别写成 ORLON'))).toBe(true);
    // 顺序：保真消息全部排在摘要之前
    const summaryIdx = out.findIndex((m) => m.origin.kind === 'compaction_summary');
    const lastVerbatimIdx = out.reduce((acc, m, i) => (m.origin.kind === 'user_verbatim' ? i : acc), -1);
    expect(lastVerbatimIdx).toBeLessThan(summaryIdx);
    expect(out.at(-1)!.message.content).toBe('最近3');
  });

  it('跨轮继承：连续两次压缩后，第一轮的原话仍以原文在场', async () => {
    const mkProvider = () =>
      makeFakeProvider([{ textChunks: [], finalContent: [textBlock('细节我已了解，继续推进。')] }]).provider;
    const SECRET = 'C:/proj/very-specific-path';
    let history: StoredMessage[] = [
      stored({ role: 'user', content: `项目在 ${SECRET} 这个哈` }, { kind: 'user' }),
      bulkAssistant('A1'),
      stored({ role: 'user', content: '注意 key 在 keys.json' }, { kind: 'user' }),
      bulkAssistant('A2'),
      bulkAssistant('A3'),
      stored({ role: 'user', content: '第一轮末尾' }, { kind: 'user' }),
    ];
    history = await fullCompact(mkProvider(), history, 2);
    expect(history.some((m) => (m.message.content as string).includes?.(SECRET))).toBe(true);

    // 会话继续堆内容，触发第二次压缩
    history = [
      ...history,
      bulkAssistant('B1'),
      stored({ role: 'user', content: '现在改压缩逻辑' }, { kind: 'user' }),
      bulkAssistant('B2'),
      stored({ role: 'user', content: '第二轮末尾' }, { kind: 'user' }),
    ];
    history = await fullCompact(mkProvider(), history, 2);

    const allText = history.map((m) => JSON.stringify(m.message.content)).join('\n');
    expect(allText).toContain(SECRET); // 关键：跨轮不丢
    expect(allText).toContain('keys.json');
    expect(allText).toContain('现在改压缩逻辑');
  });

  it('保真占被压缩段比例过高时退回纯摘要（压缩不该退化成原地搬运）', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock(longSummary('摘要正文'))] },
    ]);
    // older 段几乎全是用户原话（assistant 极短）→ 占比超阈值 → 不保真
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: `长请求 ${'内容'.repeat(80)}` }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('好')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: `再一条 ${'内容'.repeat(80)}` }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('嗯')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '最近' }, { kind: 'user' }),
    ];
    const out = await fullCompact(provider, msgs, 2);
    expect(out.some((m) => m.origin.kind === 'user_verbatim')).toBe(false);
    expect(summaryOf(out).message.content).toContain('摘要正文');
  });

  it('保真预算为 0 时退回纯摘要形态', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('纯摘要正文')] },
    ]);
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: '早期请求' }, { kind: 'user' }),
      bulkAssistant('A1'),
      stored({ role: 'user', content: '最近1' }, { kind: 'user' }),
      bulkAssistant('A2'),
      stored({ role: 'user', content: '最近3' }, { kind: 'user' }),
    ];
    const out = await fullCompact(provider, msgs, 2, undefined, undefined, { maxTokens: 0 });
    expect(out.some((m) => m.origin.kind === 'user_verbatim')).toBe(false);
    expect(summaryOf(out).message.content).toContain('纯摘要正文');
  });

  it('recent 段的用户消息不进保真（避免与保留的原消息重复）', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock(longSummary('摘要'))] },
    ]);
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: 'OLD-ONLY-IN-VERBATIM' }, { kind: 'user' }),
      bulkAssistant('A1'),
      bulkAssistant('A2'),
      stored({ role: 'user', content: 'RECENT-KEPT-AS-IS' }, { kind: 'user' }),
      bulkAssistant('A3'),
      stored({ role: 'user', content: 'RECENT-LAST' }, { kind: 'user' }),
    ];
    const out = await fullCompact(provider, msgs, 3);
    const verbatimTexts = out.filter((m) => m.origin.kind === 'user_verbatim').map((m) => m.message.content);
    expect(verbatimTexts).toContain('OLD-ONLY-IN-VERBATIM');
    expect(verbatimTexts).not.toContain('RECENT-KEPT-AS-IS');
    // recent 段那条仍以原 origin 在场
    expect(out.some((m) => m.origin.kind === 'user' && m.message.content === 'RECENT-KEPT-AS-IS')).toBe(true);
  });

  it('保真消息不参与轮次计数与回退编辑（origin 与真人输入区分开）', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock(longSummary('摘要'))] },
    ]);
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: '早期关键请求：路径 /tmp/x' }, { kind: 'user' }),
      bulkAssistant('A1'),
      bulkAssistant('A2'),
      stored({ role: 'user', content: '最近的真人输入' }, { kind: 'user' }),
    ];
    const out = await fullCompact(provider, msgs, 1);
    // 保真消息用 user_verbatim，故 turns.ts / backtrack.ts 的 `=== 'user'` 判断不会命中它
    expect(out.filter((m) => m.origin.kind === 'user_verbatim').length).toBeGreaterThan(0);
    expect(out.filter((m) => m.origin.kind === 'user').length).toBe(1);
  });

  it('摘要 prompt 带上 handoff 认知要求（已决/未决分离、未验证标注）', async () => {
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('摘要')] },
    ]);
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: '开始' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('好')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '最近1' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('最近2')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '最近3' }, { kind: 'user' }),
    ];
    await fullCompact(provider, msgs, 2);
    const params = streamParams()[0]!;
    const prompt = (params['messages'] as Array<{ content: string }>)[0]!.content;
    expect(prompt).toContain('仍然待定');
    expect(prompt).toContain('未验证');
    expect(prompt).toContain('你仍然不知道什么');
    expect(params['system']).toContain('第一人称');
  });
});

describe('serializeContent 摘要输入保真（2026-08-13 A/B/C/D 探针定稿）', () => {
  it('thinking 块整块丢弃、不留标记（[thinking] 标记诱导摘要模型模仿）', () => {
    const out = serializeContent([
      { type: 'thinking', thinking: '很长的思考过程……', signature: 's' } as Anthropic.ContentBlockParam,
      textBlock('正文'),
    ]);
    expect(out).toBe('正文');
    expect(out).not.toContain('[thinking]');
  });

  it('tool_use 带截断参数：命令与路径对摘要模型可见', () => {
    const out = serializeContent([
      { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'git status' } } as unknown as Anthropic.ContentBlockParam,
    ]);
    expect(out).toContain('[调用工具 bash]');
    expect(out).toContain('git status');
  });

  it('tool_use 参数超预算按头截断并标注', () => {
    const out = serializeContent([
      {
        type: 'tool_use',
        id: 't1',
        name: 'write_file',
        input: { path: 'a.md', content: 'x'.repeat(2000) },
      } as unknown as Anthropic.ContentBlockParam,
    ]);
    expect(out.length).toBeLessThan(500);
    expect(out).toContain('…[截断]');
  });

  it('tool_result 内嵌文本超预算按头截断', () => {
    const out = serializeContent([
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: [{ type: 'text', text: 'r'.repeat(3000) }],
      } as unknown as Anthropic.ContentBlockParam,
    ]);
    expect(out).toContain('[工具结果]');
    expect(out.length).toBeLessThan(1100);
    expect(out).toContain('…[截断]');
  });
});

describe('fullCompact 闸门层失败的重试策略（2026-08-13 修复）', () => {
  it('摘要过短 → 追加提示、原输入重试（不丢消息）', async () => {
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: '用户提了一个很长的需求'.repeat(50) }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('好的，我分几步做'.repeat(50))] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '继续' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('做完了第一步')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '最近1' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('最近2')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '最近3' }, { kind: 'user' }),
    ];
    const longSummary = '这是一份足够长的交接摘要。'.repeat(30);
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('太短')] },
      { textChunks: [], finalContent: [textBlock(longSummary)] },
    ]);
    const out = await fullCompact(provider as never, msgs, 3);
    // 第二次尝试成功了：压缩产物里有摘要
    expect(summaryOf(out).message.content).toContain('早期对话摘要');
    // 两次 stream 调用：第一次无提示，第二次带「过短」提示；且两次输入等长（未丢消息）
    expect(streamParams()).toHaveLength(2);
    const first = (streamParams()[0]!.messages as Array<{ content: string }>)[0]!.content;
    const second = (streamParams()[1]!.messages as Array<{ content: string }>)[0]!.content;
    expect(first).not.toContain('上一次产出的摘要被判不合格');
    expect(second).toContain('上一次产出的摘要被判不合格');
    const strip = (s: string) => s.replace(/\n\n注意：上一次产出的摘要[\s\S]*?(?=\n\n---)/, '');
    expect(strip(second)).toBe(strip(first));
  });

  it('历史含大量 thinking 块时闸门按序列化后输入判分（原始体量不再把及格线抬爆）', async () => {
    // 原始历史体量大（thinking 全文），但序列化后很小——按原始体量判分会把 15 token 摘要判死
    const thinkingHeavy: StoredMessage[] = [
      stored({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '思'.repeat(20000), signature: 's' } as Anthropic.ContentBlockParam,
          textBlock('做了一点事'),
        ],
      }, { kind: 'assistant' }),
      stored({ role: 'user', content: '继续' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('最近1')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '最近2' }, { kind: 'user' }),
    ];
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('摘要：做了一点事并继续推进。')] },
    ]);
    const out = await fullCompact(provider as never, thinkingHeavy, 2);
    expect(summaryOf(out).message.content).toContain('早期对话摘要');
  });

  it('3 次均过短但候选达门槛 → 降级接受精简交接（不放弃压缩）', async () => {
    // 长历史让闸门门槛 = 200（硬上限生效，inputTokens ≥ 10000）；候选约 90 token，3 次都过不了
    // 闸门但 ≥ 50 降级门槛。中文 1 字 ≈ 1 token，故历史需 ≥ 10000 中文字。
    const longText = '用户提了一个很长的需求，需要仔细讨论很多细节，包括架构选型、边界条件与测试策略。';
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: longText.repeat(120) }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('好的，我分几步做，先调研再落地。'.repeat(120))] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '继续' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('做完了第一步')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '最近1' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('最近2')] }, { kind: 'assistant' }),
    ];
    // 3 次都返回同一个偏短但非噪音的交接（≥50 token 但 <200）
    const short = '用户要建代号 ORION 的系统，已定方案 B，下一步写集成测试。'.repeat(3);
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock(short)] },
      { textChunks: [], finalContent: [textBlock(short)] },
      { textChunks: [], finalContent: [textBlock(short)] },
    ]);
    const out = await fullCompact(provider as never, msgs, 2);
    // 不放弃：产物里有 compaction_summary（而非原样返回 = 无摘要）
    const s = summaryOf(out);
    expect(s.message.content).toContain('早期对话摘要');
    // 带精简交接标注：诚实告知模型这次交接偏薄
    expect(s.message.content).toContain('精简交接');
    expect(s.message.content).toContain('ORION');
    // 3 次都调了（耗尽重试后才降级）
    expect(streamParams()).toHaveLength(3);
  });

  it('3 次过短且候选是噪音短串（<50 token）→ 仍放弃压缩', async () => {
    const longText = '用户提了一个很长的需求，需要仔细讨论很多细节，包括架构选型、边界条件与测试策略。';
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: longText.repeat(120) }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('好的，我分几步做，先调研再落地。'.repeat(120))] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '继续' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('做完了第一步')] }, { kind: 'assistant' }),
      stored({ role: 'user', content: '最近1' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [textBlock('最近2')] }, { kind: 'assistant' }),
    ];
    // 纯噪音短串，trim 后远不到 50 token
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('好的')] },
      { textChunks: [], finalContent: [textBlock('继续')] },
      { textChunks: [], finalContent: [textBlock('嗯')] },
    ]);
    const out = await fullCompact(provider as never, msgs, 2);
    // 无降级 → 无 compaction_summary（原样返回）
    expect(out.some((sm) => sm.origin.kind === 'compaction_summary')).toBe(false);
  });
});
