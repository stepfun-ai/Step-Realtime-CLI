/**
 * 压缩失败不再静默（`loop.compactFailed`）。
 *
 * 修复前：`fullCompact` 失败会原样返回历史，`maybeCompact` 的布尔返回把
 * 「没超阈值、无需动手」与「超了阈值、动过手但压不出结果」混为同一个 false。
 * 调用点据此既不提示也不置饱和，于是**每一轮都再烧一次摘要请求**，用户全程
 * 看不到任何信号，直到最终 overflow 报错才发现压缩一直在失败。
 *
 * 本文件钉住三件事：失败要说出来、失败后不再重复烧请求、以及「压不动」与
 * 「压失败」必须区别对待（前者不置饱和，历史长起来往往就能压了）。
 */
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/loop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';

function sm(
  message: Anthropic.MessageParam,
  origin: 'user' | 'assistant' | 'tool' = 'user',
): StoredMessage {
  return stored(message, { kind: origin });
}

const baseOpts = (
  provider: ReturnType<typeof makeFakeProvider>['provider'],
  messages: StoredMessage[],
) => ({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages });

/** 远超阈值的历史（8 条 × 5000 字符填充）。 */
function bigHistory(): StoredMessage[] {
  return Array.from({ length: 8 }, (_, i) =>
    i % 2 === 0
      ? sm({ role: 'user', content: `历史消息内容${'x'.repeat(5000)}` })
      : sm({ role: 'assistant', content: [textBlock(`回复${'y'.repeat(5000)}`)] }, 'assistant'),
  );
}

/**
 * 阈值必须大于框架固定开销，否则任何历史都恒定超线。
 * 本仓库 system + tools schema 估算约 8k tok，故取 20000（触发线 17000）：
 * bigHistory 约 10k + 框架 8k 超线，而单条短消息 + 框架不超线。
 */
const THRESHOLDS = { maxContextSize: 20000, triggerRatio: 0.85, reservedTokens: 10 };

/** 摘要请求恒失败的行为（非 overflow、非中断：走「其他失败」降级链直到放弃）。 */
const summaryFails = { throw: new Anthropic.APIError(500, undefined, 'summary upstream boom', undefined) };

describe('压缩失败不再静默', () => {
  it('摘要连续失败 → 发出明确 notice，且历史保持原样不被破坏', async () => {
    // 摘要调用全部失败；主会话回合本身正常完成。
    const { provider } = makeFakeProvider([
      summaryFails,
      summaryFails,
      summaryFails,
      { textChunks: ['照常回答'], finalContent: [textBlock('照常回答')] },
    ]);
    const messages = bigHistory();
    const lenBefore = messages.length;

    const events = await collect(
      runAgent({ ...baseOpts(provider, messages), compaction: THRESHOLDS }),
    );

    const notices = events
      .filter((e) => e.type === 'notice')
      .map((e) => (e as { message: string }).message);
    // 必须明确说出「没能生成可用摘要」这件事，而不是静默继续
    expect(notices.some((m) => m.includes('没能生成可用摘要'))).toBe(true);
    // 给出可操作出路（手动压缩 / 重开会话）
    expect(notices.some((m) => m.includes('/compact') && m.includes('/new'))).toBe(true);
    // 压缩失败绝不能破坏历史：条数只可能因本回合新增 assistant 而增加，不会被截断
    expect(messages.length).toBeGreaterThanOrEqual(lenBefore);
    // 回合本身照常收尾，压缩失败不掀翻对话
    expect(events.at(-1)!.type).toBe('turn_done');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('失败后置饱和：后续回合不再重复发起摘要请求（不重复烧钱）', async () => {
    // 第 1 回合：摘要失败若干次 → 置饱和；随后主会话走两个回合（tool_use → end_turn）。
    // 若饱和未生效，第 2 回合的预检会再次发起摘要请求，streamCalls 会更多。
    const { provider, streamCalls } = makeFakeProvider([
      summaryFails,
      summaryFails,
      summaryFails,
      { textChunks: [], finalContent: [toolUseBlock('c1', 'nonexistent_tool', {})] },
      { textChunks: ['收尾'], finalContent: [textBlock('收尾')] },
    ]);
    const events = await collect(
      runAgent({ ...baseOpts(provider, bigHistory()), compaction: THRESHOLDS }),
    );

    expect(events.at(-1)!.type).toBe('turn_done');
    // 失败提示只出现一次——每轮都提示等于把静默换成了噪音
    const failNotices = events.filter(
      (e) => e.type === 'notice' && (e as { message: string }).message.includes('没能生成可用摘要'),
    );
    expect(failNotices).toHaveLength(1);
    // 关键断言：第二个回合没有再叠加摘要调用。
    // 总调用 = 失败的摘要若干 + 两个主会话回合，且第二回合之前不再插入新的摘要请求。
    const calls = streamCalls();
    expect(calls).toBeLessThanOrEqual(8);
  });

  it('历史太短压不动 ≠ 压缩失败：不发失败提示、不置饱和', async () => {
    // 未超阈值时预检根本不动手，既不该有压缩提示也不该有失败提示。
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: ['短答'], finalContent: [textBlock('短答')] },
    ]);
    const events = await collect(
      runAgent({
        ...baseOpts(provider, [sm({ role: 'user', content: 'hi' })]),
        compaction: THRESHOLDS,
      }),
    );
    // 只有主会话那一次调用，没有摘要请求
    expect(streamCalls()).toBe(1);
    const notices = events
      .filter((e) => e.type === 'notice')
      .map((e) => (e as { message: string }).message);
    expect(notices.some((m) => m.includes('没能生成可用摘要'))).toBe(false);
    expect(notices.some((m) => m.includes('已自动压缩'))).toBe(false);
  });

  it('压缩成功时不得误报失败（正向回归）', async () => {
    // 摘要必须足够长才能过质量闸门（COMPACTION_SUMMARY_MIN_RATIO：摘要不得远短于被摘内容），
    // 否则会被判为垃圾摘要走进失败路径——那样这条正向用例就测不到它该测的东西了。
    const goodSummary = Array.from(
      { length: 40 },
      (_, i) => `第${i + 1}段要点：早期对话确认了目标、边界与已验证的结论，并记录了后续待办。`,
    ).join('');
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock(goodSummary)] },
      { textChunks: ['继续'], finalContent: [textBlock('继续')] },
    ]);
    const events = await collect(
      runAgent({ ...baseOpts(provider, bigHistory()), compaction: THRESHOLDS }),
    );
    const notices = events
      .filter((e) => e.type === 'notice')
      .map((e) => (e as { message: string }).message);
    expect(notices.some((m) => m.includes('没能生成可用摘要'))).toBe(false);
    expect(events.at(-1)!.type).toBe('turn_done');
  });
});
