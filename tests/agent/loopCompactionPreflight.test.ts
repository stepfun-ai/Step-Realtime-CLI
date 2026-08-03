import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/loop.js';
import { estimateTokens } from '../../src/agent/compaction/compact.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';

/**
 * 回归测试：发请求前的压缩预检（preflight）。
 *
 * 修复前的缺陷：压缩检查只挂在 `tool_use` 分支（回合结束、且模型确实调了工具时），
 * 于是三条常见路径完全绕过压缩——
 *   ① 新一轮 run 的第一个回合（超限历史直接发出去）
 *   ② 纯对话轮 `end_turn`（模型不调工具就结束，压缩永不评估）
 *   ③ 用户 Esc 中断 `aborted`（分支直接 return）
 * 后果：长会话可以长期停在「占用已超配置上限、仍照常发请求」的状态。若模型实际窗口
 * 比配置的 maxContextSize 更宽，API 不报 overflow，这个状态就不会自愈。
 *
 * 另一处同源缺陷：overflow 保命压缩分支只发 notice、**不发 usage**，导致压缩后
 * 状态栏数字停在压缩前的旧值（用户看到「说压缩了、数字没动」）。
 */

function sm(
  message: Anthropic.MessageParam,
  origin: 'user' | 'assistant' | 'tool' = 'user',
): StoredMessage {
  return stored(message, origin);
}

const baseOpts = (
  provider: ReturnType<typeof makeFakeProvider>['provider'],
  messages: StoredMessage[],
  signal?: AbortSignal,
) => ({ provider, system: 'sys', ctx: { cwd: process.cwd(), signal }, messages, signal });

/** 造一段远超阈值的历史（8 条 × 100 字符填充，估算 ≫ maxContextSize×triggerRatio）。 */
function bigHistory(): StoredMessage[] {
  return Array.from({ length: 8 }, (_, i) =>
    i % 2 === 0
      ? sm({ role: 'user', content: `历史消息内容${'x'.repeat(100)}` })
      : sm({ role: 'assistant', content: [textBlock(`回复${'y'.repeat(100)}`)] }, 'assistant'),
  );
}

/** 本组统一的压缩阈值：maxContextSize=200 → 触发线 170。 */
const THRESHOLDS = { maxContextSize: 200, triggerRatio: 0.85, reservedTokens: 10 };

describe('发请求前的压缩预检', () => {
  it('纯对话轮：模型不调工具也会在发请求前压缩（修复前此路径永不压缩）', async () => {
    // 只给两个行为：摘要调用 + 唯一的主会话请求（end_turn）。
    // 若预检缺失，第一次 stream 就会是主会话请求、摘要调用不存在，
    // 断言 streamParams()[0] 带 compactionModel 就会失败。
    const { provider, streamCalls, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('早期摘要')] }, // 预检触发的摘要调用
      { textChunks: ['答复'], finalContent: [textBlock('答复')] }, // 主会话唯一回合，直接 end_turn
    ]);
    const messages = bigHistory();
    const before = messages.length;

    const events = await collect(
      runAgent({
        ...baseOpts(provider, messages),
        compaction: THRESHOLDS,
        compactionModel: 'summary-model',
      }),
    );

    // 摘要调用排在主会话请求之前 → 证明压缩发生在「发请求前」
    expect(streamCalls()).toBe(2);
    expect(streamParams()[0]!['model']).toBe('summary-model');
    expect(streamParams()[1]!['model']).toBeUndefined();
    // 历史被压缩的稳定判据：产出了摘要消息。
    // 不用 messages.length 下降做判据——usage 发出后主会话回合还会追加 assistant，
    // 最终长度不代表压缩那一刻的长度。
    expect(messages.some((m) => m.origin.kind === 'compaction_summary')).toBe(true);
    expect(before).toBe(8); // 前置条件自检：确认造的历史确实是 8 条
    // 本回合是纯对话（end_turn），照旧正常收尾
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('预检压缩后紧跟 usage 事件：状态栏立即回落，不等下一次真实 usage', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('早期摘要')] },
      { textChunks: ['答复'], finalContent: [textBlock('答复')] },
    ]);
    const messages = bigHistory();
    const beforeEstimate = estimateTokens(messages);

    const events = await collect(
      runAgent({ ...baseOpts(provider, messages), compaction: THRESHOLDS }),
    );

    const usage = events.find((e) => e.type === 'usage') as
      | { type: 'usage'; totalTokens: number; measuredLength?: number }
      | undefined;
    expect(usage).toBeDefined();
    // 压缩后的估算必须低于压缩前，否则「立即回落」没有意义
    expect(usage!.totalTokens).toBeLessThan(beforeEstimate);
    // usage 事件必须排在任何模型输出之前 —— 这是「预检发生在发请求前」的直接证据
    const usageIdx = events.findIndex((e) => e.type === 'usage');
    const firstTextIdx = events.findIndex((e) => e.type === 'text');
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(firstTextIdx).toBeGreaterThan(usageIdx);
    // measuredLength 取压缩后那一刻的全长；此后主会话回合又追加了 assistant，故严格小于最终长度
    expect(usage!.measuredLength).toBeGreaterThan(0);
    expect(usage!.measuredLength).toBeLessThan(messages.length);
  });

  it('未超阈值时预检不动手：不产生额外的摘要调用', async () => {
    const { provider, streamCalls, streamParams } = makeFakeProvider([
      { textChunks: ['短答'], finalContent: [textBlock('短答')] },
    ]);
    const messages: StoredMessage[] = [sm({ role: 'user', content: 'hi' })];

    const events = await collect(
      runAgent({
        ...baseOpts(provider, messages),
        compaction: THRESHOLDS,
        compactionModel: 'summary-model',
      }),
    );

    // 只有主会话这一次请求，且不带压缩模型覆盖
    expect(streamCalls()).toBe(1);
    expect(streamParams()[0]!['model']).toBeUndefined();
    expect(messages.some((m) => m.origin.kind === 'compaction_summary')).toBe(false);
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('未配置 compaction 时预检整体跳过（不因缺配置而报错）', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: ['答复'], finalContent: [textBlock('答复')] },
    ]);
    const messages = bigHistory(); // 即便超限，也不该尝试压缩

    const events = await collect(runAgent(baseOpts(provider, messages)));

    expect(streamCalls()).toBe(1);
    expect(events.at(-1)!.type).toBe('turn_done');
    expect(messages.some((m) => m.origin.kind === 'compaction_summary')).toBe(false);
  });
});

describe('overflow 保命压缩的状态栏刷新', () => {
  it('溢出重试后发 usage 事件：修复前只发 notice，数字停在压缩前旧值', async () => {
    // 第 1 次主请求抛上下文溢出 → 保命压缩（摘要调用）→ 重试本回合成功。
    // 错误文本必须能被 isContextOverflowError 识别，否则会走通用重试而非 overflow 分支。
    const overflow = new Anthropic.APIError(400, undefined, 'prompt is too long', undefined);
    const { provider } = makeFakeProvider([
      { throw: overflow }, // 主请求：溢出
      { textChunks: [], finalContent: [textBlock('保命摘要')] }, // 保命 fullCompact 摘要调用
      { textChunks: ['重试成功'], finalContent: [textBlock('重试成功')] }, // 重试本回合
    ]);
    // 多条历史，保证保命压缩确实有内容可压；maxContextSize 给大值使预检不触发
    const messages: StoredMessage[] = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0
        ? sm({ role: 'user', content: `第${i}条` })
        : sm({ role: 'assistant', content: [textBlock(`回复${i}`)] }, 'assistant'),
    );

    const events = await collect(
      runAgent({
        ...baseOpts(provider, messages),
        // maxContextSize 给大值：预检不触发，只有 API 报错这条路径能触发压缩
        compaction: { maxContextSize: 1_000_000, triggerRatio: 0.85, reservedTokens: 10 },
      }),
    );

    // 溢出重试的 notice 仍在
    const notices = events.filter((e) => e.type === 'notice') as { type: 'notice'; message: string }[];
    expect(notices.some((n) => n.message.includes('溢出'))).toBe(true);
    // 关键断言：保命压缩后必须有 usage 事件，且 measuredLength 指向压缩后全长
    const usage = events.find((e) => e.type === 'usage') as
      | { type: 'usage'; totalTokens: number; measuredLength?: number }
      | undefined;
    expect(usage).toBeDefined();
    // measuredLength 取压缩后那一刻的全长；重试回合又追加了 assistant，故严格小于最终长度
    expect(usage!.measuredLength).toBeGreaterThan(0);
    expect(usage!.measuredLength).toBeLessThan(messages.length);
    expect(events.at(-1)!.type).toBe('turn_done');
  });
});

describe('压缩饱和守卫', () => {
  it('压过一次仍超阈值：置饱和并提示，本 run 内不再重复烧摘要请求', async () => {
    // 历史远超阈值，且保留窗口内的消息本身就超预算 → 压一次也压不到阈值以下。
    // 修复前的行为：预检每回合都判一次，于是每回合各烧一次摘要请求（且都压不下来）。
    // 只给 3 个行为，若发生第二次压缩就会 behaviors 用尽而 error。
    const { provider, streamCalls, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('早期摘要')] }, // 唯一一次摘要调用
      { textChunks: [], finalContent: [toolUseBlock('c1', 'nonexistent_tool', {})] }, // 第1轮
      { textChunks: ['收尾'], finalContent: [textBlock('收尾')] }, // 第2轮 end_turn
    ]);
    const messages = bigHistory();

    const events = await collect(
      runAgent({
        ...baseOpts(provider, messages),
        compaction: THRESHOLDS,
        compactionModel: 'summary-model',
      }),
    );

    // 全程只有一次摘要调用（第 0 次），主会话两次
    expect(streamCalls()).toBe(3);
    expect(streamParams()[0]!['model']).toBe('summary-model');
    expect(streamParams().filter((p) => p['model'] === 'summary-model')).toHaveLength(1);
    // 饱和时必须明确告知用户，而不是静默继续带着超限上下文跑
    const notices = events.filter((e) => e.type === 'notice') as { type: 'notice'; message: string }[];
    expect(notices.some((n) => n.message.includes('无法进一步压缩'))).toBe(true);
    expect(events.at(-1)!.type).toBe('turn_done');
  });
});
