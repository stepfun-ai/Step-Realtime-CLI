import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/loop.js';
import { estimateTextTokens, estimateTokens } from '../../src/agent/compaction/compact.js';
import { toAnthropicTools } from '../../src/tools/index.js';
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
  return stored(message, { kind: origin });
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

/**
 * 框架固定开销（system + tools schema）的估算，与 loop 内 `frameworkTokens` 同算法。
 *
 * 测试必须自己算一遍，否则断言口径与被测量不对等：状态栏与预检报的都是
 * 「历史估算 + 框架开销」，拿裸历史估算去比必然失败（本仓库工具表本身就有约 8k tok）。
 * 这正是被修复的那个 bug 在测试侧的镜像，故这里刻意复算而不是放宽阈值。
 */
function frameworkTokensOf(system: string): number {
  return estimateTextTokens(system) + estimateTextTokens(JSON.stringify(toAnthropicTools(undefined)));
}

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
    // 同口径基线：状态栏报的是「历史估算 + 框架开销」，基线也必须含框架开销
    const beforeSameUnit = estimateTokens(messages) + frameworkTokensOf('sys');

    const events = await collect(
      runAgent({ ...baseOpts(provider, messages), compaction: THRESHOLDS }),
    );

    const usage = events.find((e) => e.type === 'usage') as
      | { type: 'usage'; totalTokens: number; measuredLength?: number }
      | undefined;
    expect(usage).toBeDefined();
    // 压缩后的估算必须低于压缩前，否则「立即回落」没有意义
    expect(usage!.totalTokens).toBeLessThan(beforeSameUnit);
    // 且必须仍然含框架开销：低于框架开销说明又退回了裸历史口径（口径不一致的回归信号）
    expect(usage!.totalTokens).toBeGreaterThanOrEqual(frameworkTokensOf('sys'));
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

/**
 * 回归测试：预检判据的口径。
 *
 * 检查点位置修好之后暴露的第二个缺口——喂给它的数字不准：
 *   ① `lastUsage` 是 runAgent 的局部状态，每次提交都是一次新调用、从零开始，
 *      于是首回合只能用纯字符估算。实测该口径只有真实占用的一半
 *      （estimateTokens 185.8k vs 真实 380.9k），单回合的纯对话轮因此永远判不出该压缩。
 *   ② 估算口径不含 system prompt 与 tools schema，而窗口上限装的是三样。
 *   ③ maybeCompact 内部在 micro 之后又用同一个低估口径重判是否需要 full，
 *      把「其实仍超线」判成「已经够了」，调用方传入的准确基准被这一步抹掉。
 *
 * 下面每个用例都用「传/不传」对照，把单一变量的效果隔离出来。
 */
describe('预检判据的口径', () => {
  /** 阈值放宽到 2000（触发线 1700），使 bigHistory 的纯估算不足以触发，好观察基准来源的影响。 */
  const WIDE = { maxContextSize: 2000, triggerRatio: 0.85, reservedTokens: 10 };

  it('传 initialUsage：首回合即用真实基准判断，估算偏低也会压缩', async () => {
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('摘要')] }, // 预检触发的摘要调用
      { textChunks: ['答复'], finalContent: [textBlock('答复')] },
    ]);
    const messages = bigHistory();
    // 前置条件：纯估算远低于触发线，所以「压了」只可能是因为用了传入的真实基准
    expect(estimateTokens(messages)).toBeLessThan(1700);

    await collect(
      runAgent({
        ...baseOpts(provider, messages),
        allowedTools: [], // 排除 tools schema 的影响，只观察 initialUsage 这一个变量
        compaction: WIDE,
        compactionModel: 'summary-model',
        initialUsage: { total: 1800, measuredLength: messages.length }, // 真实占用已过线
      }),
    );

    expect(streamParams()[0]!['model']).toBe('summary-model');
    expect(messages.some((m) => m.origin.kind === 'compaction_summary')).toBe(true);
  });

  it('对照：同样的历史不传 initialUsage 就不压缩（修复前的行为）', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: ['答复'], finalContent: [textBlock('答复')] },
    ]);
    const messages = bigHistory();

    await collect(
      runAgent({
        ...baseOpts(provider, messages),
        allowedTools: [],
        compaction: WIDE,
        compactionModel: 'summary-model',
      }),
    );

    // 只有主会话一次请求，没有摘要调用
    expect(streamCalls()).toBe(1);
    expect(messages.some((m) => m.origin.kind === 'compaction_summary')).toBe(false);
  });

  it('无真实基准时补上框架开销：tools schema 计入后越过阈值', async () => {
    // 触发线 = maxContextSize×0.85。本用例依赖「全量 tools schema + bigHistory」越过触发线，
    // 而 tools schema 大小随工具表增减变化（2026-08-05 删 workflow 工具后实测 7231 tok、
    // bigHistory 260 tok、sys 1 tok，合计 7492）。maxContextSize=8000 → 触发线 6800：
    // 6800 < 7492（越线），且清空工具后仅 261 ≪ 6800（对照用例不过线）。
    // 若未来工具表大幅增删导致此用例失败，按上面实测口径重算 maxContextSize。
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('摘要')] },
      { textChunks: ['答复'], finalContent: [textBlock('答复')] },
    ]);
    const messages = bigHistory();

    await collect(
      runAgent({
        ...baseOpts(provider, messages),
        // 不传 allowedTools = 全量工具，其 schema 是框架开销的主要来源
        compaction: { maxContextSize: 8000, triggerRatio: 0.85, reservedTokens: 10 },
        compactionModel: 'summary-model',
      }),
    );

    expect(streamParams()[0]!['model']).toBe('summary-model');
    expect(messages.some((m) => m.origin.kind === 'compaction_summary')).toBe(true);
  });

  it('对照：同阈值下把工具集清空就不过线（证明上一条是 tools schema 起的作用）', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: ['答复'], finalContent: [textBlock('答复')] },
    ]);
    const messages = bigHistory();

    await collect(
      runAgent({
        ...baseOpts(provider, messages),
        allowedTools: [],
        compaction: { maxContextSize: 8000, triggerRatio: 0.85, reservedTokens: 10 },
        compactionModel: 'summary-model',
      }),
    );

    expect(streamCalls()).toBe(1);
    expect(messages.some((m) => m.origin.kind === 'compaction_summary')).toBe(false);
  });

  it('有真实基准时不叠加框架开销：真实值本身已含 system 与 tools，再加即双算', async () => {
    // 触发线 17000，真实基准 16000 未过线。若错误地把 7800+ 的框架开销加上去就会误压。
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: ['答复'], finalContent: [textBlock('答复')] },
    ]);
    const messages = bigHistory();

    await collect(
      runAgent({
        ...baseOpts(provider, messages),
        // 全量工具：框架开销可观，正是「不该被加上」的那部分
        compaction: { maxContextSize: 20000, triggerRatio: 0.85, reservedTokens: 10 },
        compactionModel: 'summary-model',
        initialUsage: { total: 16000, measuredLength: messages.length },
      }),
    );

    expect(streamCalls()).toBe(1);
    expect(messages.some((m) => m.origin.kind === 'compaction_summary')).toBe(false);
  });

  it('micro 未清理任何内容时，full 的重判沿用真实基准而非低估的估算', async () => {
    // 历史里没有可被 micro 清理的大 tool_result（clearedCount=0），
    // 此时若拿 estimateTokens 重判就会判成「不用 full」——那正是被修掉的行为。
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('摘要')] },
      { textChunks: ['答复'], finalContent: [textBlock('答复')] },
    ]);
    const messages = bigHistory(); // 纯文本对话，无 tool_result

    await collect(
      runAgent({
        ...baseOpts(provider, messages),
        allowedTools: [],
        compaction: WIDE,
        compactionModel: 'summary-model',
        initialUsage: { total: 1800, measuredLength: messages.length },
      }),
    );

    // full 确实执行了（摘要调用发生 + 产出 compaction_summary）
    expect(streamParams()[0]!['model']).toBe('summary-model');
    expect(messages.some((m) => m.origin.kind === 'compaction_summary')).toBe(true);
  });
});
