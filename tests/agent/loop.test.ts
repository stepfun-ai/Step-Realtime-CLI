import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/loop.js';
import { estimateTextTokens, estimateTokens } from '../../src/agent/compaction/compact.js';
import { toAnthropicTools } from '../../src/tools/index.js';
import { GoalMode } from '../../src/agent/goal/mode.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { collect, makeFakeProvider, textBlock, thinkingBlock, toolUseBlock } from '../helpers/fakeProvider.js';

/** 包一条 storage 消息（测试用）。 */
function sm(message: Anthropic.MessageParam, origin: 'user' | 'assistant' | 'tool' = 'user'): StoredMessage {
  return stored(message, { kind: origin });
}

const baseOpts = (
  provider: ReturnType<typeof makeFakeProvider>['provider'],
  messages: StoredMessage[],
  signal?: AbortSignal,
) => ({ provider, system: 'sys', ctx: { cwd: process.cwd(), signal }, messages, signal });

/**
 * 框架固定开销（system + tools schema），与 loop 内 `frameworkTokens` 同算法。
 * 状态栏与预检报的都是「历史估算 + 框架开销」，断言基线必须同口径——
 * 拿裸历史估算去比会必然失败（本仓库工具表本身约 8k tok）。
 */
function frameworkTokensOf(system: string): number {
  return estimateTextTokens(system) + estimateTextTokens(JSON.stringify(toAnthropicTools(undefined)));
}

describe('runAgent', () => {
  it('纯文本回合：产出 text 与 turn_done，并把 assistant 推入历史', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: ['你好', '世界'], finalContent: [textBlock('你好世界')] },
    ]);
    const messages: StoredMessage[] = [sm({ role: 'user', content: 'hi' })];
    const events = await collect(runAgent(baseOpts(provider, messages)));

    expect(
      events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text),
    ).toEqual(['你好', '世界']);
    expect(events.at(-1)!.type).toBe('turn_done');
    expect(messages).toHaveLength(2);
    expect(messages[1]!.message.role).toBe('assistant');
  });

  it('工具调用回合：未知工具错误回灌，且每个 tool_use 都配对 tool_result', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('call_1', 'nonexistent_tool', {})] },
      { textChunks: ['已处理'], finalContent: [textBlock('已处理')] },
    ]);
    const messages: StoredMessage[] = [sm({ role: 'user', content: 'go' })];
    const events = await collect(runAgent(baseOpts(provider, messages)));

    const toolEnd = events.find((e) => e.type === 'tool_end') as
      | { type: 'tool_end'; isError: boolean }
      | undefined;
    expect(toolEnd?.isError).toBe(true);

    expect(messages).toHaveLength(4);
    const toolResultMsg = messages[2]!.message;
    expect(toolResultMsg.role).toBe('user');
    const blocks = toolResultMsg.content as Anthropic.ToolResultBlockParam[];
    expect(blocks[0]!.type).toBe('tool_result');
    expect(blocks[0]!.tool_use_id).toBe('call_1');
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('预先中止：首个事件即 aborted，不调用 provider', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: ['x'], finalContent: [textBlock('x')] },
    ]);
    const ac = new AbortController();
    ac.abort();
    const events = await collect(
      runAgent(baseOpts(provider, [sm({ role: 'user', content: 'hi' })], ac.signal)),
    );
    expect(events).toEqual([{ type: 'aborted' }]);
    expect(streamCalls()).toBe(0);
  });

  it('可重试错误：先 retry 事件，再正常完成', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { throw: Object.assign(new Error('net'), { code: 'ECONNRESET' }) },
      { textChunks: ['ok'], finalContent: [textBlock('ok')] },
    ]);
    const events = await collect(runAgent(baseOpts(provider, [sm({ role: 'user', content: 'hi' })])));
    expect(events.some((e) => e.type === 'retry')).toBe(true);
    expect(events.some((e) => e.type === 'text')).toBe(true);
    expect(events.at(-1)!.type).toBe('turn_done');
    expect(streamCalls()).toBe(2);
  });

  it('不可重试错误：直接产出 error 事件', async () => {
    const { provider } = makeFakeProvider([{ throw: new Error('fatal-400') }]);
    const events = await collect(runAgent(baseOpts(provider, [sm({ role: 'user', content: 'hi' })])));
    const err = events.find((e) => e.type === 'error') as
      | { type: 'error'; message: string }
      | undefined;
    expect(err?.message).toContain('fatal-400');
  });

  it('循环内超阈值：tool_use 回合后自动压缩并发 notice', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'nonexistent_tool', {})] }, // 第1轮 tool_use
      { textChunks: [], finalContent: [textBlock('早期摘要')] }, // fullCompact 摘要调用
      { textChunks: ['完成'], finalContent: [textBlock('完成')] }, // 第2轮 end_turn
    ]);
    // 8 条长消息，估算远超 maxContextSize×triggerRatio=170，触发循环内压缩
    const big: StoredMessage[] = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0
        ? sm({ role: 'user', content: `历史消息内容${'x'.repeat(100)}` })
        : sm({ role: 'assistant', content: [textBlock(`回复${'y'.repeat(100)}`)] }, 'assistant'),
    );
    const events = await collect(
      runAgent({
        ...baseOpts(provider, big),
        compaction: { maxContextSize: 200, triggerRatio: 0.85, reservedTokens: 10 },
      }),
    );
    expect(events.some((e) => e.type === 'notice')).toBe(true);
    expect(events.at(-1)!.type).toBe('turn_done');
    expect(streamCalls()).toBe(3);
  });

  it('循环内压缩后紧跟 usage 事件：状态栏立即回落到压缩后估算，不等下一回合', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'nonexistent_tool', {})] }, // 第1轮 tool_use
      { textChunks: [], finalContent: [textBlock('早期摘要')] }, // fullCompact 摘要调用
      { textChunks: ['完成'], finalContent: [textBlock('完成')] }, // 第2轮 end_turn
    ]);
    const big2: StoredMessage[] = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0
        ? sm({ role: 'user', content: `历史消息内容${'x'.repeat(100)}` })
        : sm({ role: 'assistant', content: [textBlock(`回复${'y'.repeat(100)}`)] }, 'assistant'),
    );
    // 同口径基线：含框架开销（被测量本身也含）
    const beforeEstimate = estimateTokens(big2) + frameworkTokensOf('sys');
    const events = await collect(
      runAgent({
        ...baseOpts(provider, big2),
        compaction: { maxContextSize: 200, triggerRatio: 0.85, reservedTokens: 10 },
      }),
    );
    const noticeIdx = events.findIndex((e) => e.type === 'notice');
    expect(noticeIdx).toBeGreaterThanOrEqual(0);
    // notice 之后紧跟一条 usage，值已回落（KEEP_RECENT 保留近 6 条，只有最老 2 条被摘要，降幅有限但必然 < 压缩前）
    const usageAfter = events.slice(noticeIdx + 1).find((e) => e.type === 'usage') as
      | { type: 'usage'; totalTokens: number }
      | undefined;
    expect(usageAfter).toBeDefined();
    expect(usageAfter!.totalTokens).toBeGreaterThan(0);
    expect(usageAfter!.totalTokens).toBeLessThan(beforeEstimate);
  });

  it('真实 usage 事件带 measuredLength = 当轮消息全长（供 UI 叠加未测量尾部）', async () => {
    const { provider } = makeFakeProvider([
      {
        textChunks: ['好'],
        finalContent: [textBlock('好')],
        usage: { input_tokens: 100, output_tokens: 20 } as Anthropic.Usage,
      },
    ]);
    const messages: StoredMessage[] = [sm({ role: 'user', content: 'hi' })];
    const events = await collect(runAgent(baseOpts(provider, messages)));

    const usage = events.find((e) => e.type === 'usage') as
      | { type: 'usage'; totalTokens: number; measuredLength?: number }
      | undefined;
    expect(usage).toBeDefined();
    expect(usage!.totalTokens).toBe(120);
    // 真实 usage 覆盖当轮完整历史（user + assistant），游标为全长 → UI 侧尾部为空、不叠加估算
    expect(usage!.measuredLength).toBe(messages.length);
    expect(messages).toHaveLength(2);
  });

  it('压缩回落的估算 usage 带 measuredLength = 压缩后全长（尾部为空，不重复叠加）', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'nonexistent_tool', {})] },
      { textChunks: [], finalContent: [textBlock('早期摘要')] }, // fullCompact 摘要调用
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const msgs: StoredMessage[] = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0
        ? sm({ role: 'user', content: `历史消息内容${'x'.repeat(100)}` })
        : sm({ role: 'assistant', content: [textBlock(`回复${'y'.repeat(100)}`)] }, 'assistant'),
    );
    const events = await collect(
      runAgent({
        ...baseOpts(provider, msgs),
        compaction: { maxContextSize: 200, triggerRatio: 0.85, reservedTokens: 10 },
      }),
    );
    const noticeIdx = events.findIndex((e) => e.type === 'notice');
    const usageAfter = events.slice(noticeIdx + 1).find((e) => e.type === 'usage') as
      | { type: 'usage'; totalTokens: number; measuredLength?: number }
      | undefined;
    expect(usageAfter).toBeDefined();
    // 该值是压缩后全量估算：游标必须为全长，否则 UI 会把全部消息再当尾部估算一遍（翻倍）
    expect(usageAfter!.measuredLength).toBeGreaterThan(0);
    expect(usageAfter!.totalTokens).toBe(
      estimateTokens(msgs.slice(0, usageAfter!.measuredLength)) + frameworkTokensOf('sys'),
    );
  });

  it('上下文溢出：压缩历史后重试本回合完成', async () => {
    const overflowErr = new Anthropic.APIError(400, undefined, 'prompt is too long', undefined);
    const { provider, streamCalls } = makeFakeProvider([
      { throw: overflowErr }, // 第1次：溢出
      { textChunks: [], finalContent: [textBlock('早期摘要')] }, // 强制压缩的摘要调用
      { textChunks: ['好了'], finalContent: [textBlock('好了')] }, // 重试：正常完成
    ]);
    const msgs: StoredMessage[] = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0
        ? sm({ role: 'user', content: `第${i}条` })
        : sm({ role: 'assistant', content: [textBlock(`回复${i}`)] }, 'assistant'),
    );
    const events = await collect(
      runAgent({
        ...baseOpts(provider, msgs),
        compaction: { maxContextSize: 1000, triggerRatio: 0.85, reservedTokens: 100 },
      }),
    );
    expect(events.some((e) => e.type === 'notice')).toBe(true);
    expect(events.at(-1)!.type).toBe('turn_done');
    expect(streamCalls()).toBe(3);
  });

  it('溢出但无压缩配置：直接报错，不无限重试', async () => {
    const overflowErr = new Anthropic.APIError(400, undefined, 'prompt is too long', undefined);
    const { provider } = makeFakeProvider([{ throw: overflowErr }]);
    const events = await collect(
      runAgent(baseOpts(provider, [sm({ role: 'user', content: 'hi' })])),
    );
    const err = events.find((e) => e.type === 'error') as
      | { type: 'error'; message: string }
      | undefined;
    expect(err?.message).toContain('上下文超出模型窗口');
  });

  it('压缩透传 compactionModel：摘要调用带 model 覆盖，主会话调用不带', async () => {
    // 序列说明：历史一开始就超阈值，故**发请求前的预检**先压一次，摘要调用排在最前，
    // 主会话的第 1 次请求排在它之后。这个顺序本身就是预检生效的证据。
    const { provider, streamCalls, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('早期摘要')] }, // 预检压缩的 fullCompact 摘要调用
      { textChunks: [], finalContent: [toolUseBlock('c1', 'nonexistent_tool', {})] }, // 第1轮 tool_use
      { textChunks: ['完成'], finalContent: [textBlock('完成')] }, // 第2轮 end_turn
    ]);
    const big: StoredMessage[] = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0
        ? sm({ role: 'user', content: `历史消息内容${'x'.repeat(100)}` })
        : sm({ role: 'assistant', content: [textBlock(`回复${'y'.repeat(100)}`)] }, 'assistant'),
    );
    const events = await collect(
      runAgent({
        ...baseOpts(provider, big),
        compaction: { maxContextSize: 200, triggerRatio: 0.85, reservedTokens: 10 },
        compactionModel: 'step-flash',
      }),
    );
    expect(events.some((e) => e.type === 'notice')).toBe(true);
    expect(events.at(-1)!.type).toBe('turn_done');
    expect(streamCalls()).toBe(3);
    // 摘要调用带压缩模型；主会话调用不带 model 覆盖
    expect(streamParams()[0]!['model']).toBe('step-flash');
    expect(streamParams()[1]!['model']).toBeUndefined();
  });

  it('溢出兜底压缩同样透传 compactionModel', async () => {
    const overflowErr = new Anthropic.APIError(400, undefined, 'prompt is too long', undefined);
    const { provider, streamCalls, streamParams } = makeFakeProvider([
      { throw: overflowErr }, // 第1次：溢出
      { textChunks: [], finalContent: [textBlock('早期摘要')] }, // 强制压缩的摘要调用
      { textChunks: ['好了'], finalContent: [textBlock('好了')] }, // 重试：正常完成
    ]);
    const msgs: StoredMessage[] = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0
        ? sm({ role: 'user', content: `第${i}条` })
        : sm({ role: 'assistant', content: [textBlock(`回复${i}`)] }, 'assistant'),
    );
    const events = await collect(
      runAgent({
        ...baseOpts(provider, msgs),
        compaction: { maxContextSize: 1000, triggerRatio: 0.85, reservedTokens: 100 },
        compactionModel: 'step-flash',
      }),
    );
    expect(events.at(-1)!.type).toBe('turn_done');
    expect(streamCalls()).toBe(3);
    expect(streamParams()[1]!['model']).toBe('step-flash');
  });

  it('max_tokens 截断：tool_use 不执行，发提示后结束回合', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      {
        textChunks: ['我需要先读取'],
        finalContent: [textBlock('我需要先读取'), toolUseBlock('call_1', 'nonexistent_tool', {})],
        stopReason: 'max_tokens',
      },
    ]);
    const messages: StoredMessage[] = [sm({ role: 'user', content: 'go' })];
    const events = await collect(runAgent(baseOpts(provider, messages)));

    // 截断响应里的 tool_use 不执行：无 tool_start/tool_end，不再发起第二回合
    expect(events.some((e) => e.type === 'tool_start')).toBe(false);
    expect(events.some((e) => e.type === 'tool_end')).toBe(false);
    expect(streamCalls()).toBe(1);
    // 截断 assistant 消息仍入历史（用户可见半截输出），无 tool_result 追加
    expect(messages).toHaveLength(2);
    expect(messages[1]!.message.role).toBe('assistant');
    // 明确提示 + 结束
    const notice = events.find((e) => e.type === 'notice') as { message: string } | undefined;
    expect(notice?.message).toContain('max_tokens');
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('goal token 计量：每回合真实 usage 按计费口径累计到 active goal', async () => {
    const goal = new GoalMode();
    goal.create('A');
    const usage1 = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 600 } as Anthropic.Usage;
    const usage2 = { input_tokens: 500, output_tokens: 100 } as Anthropic.Usage;
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'nonexistent_tool', {})], usage: usage1 }, // 第1轮 tool_use
      { textChunks: ['完成'], finalContent: [textBlock('完成')], usage: usage2 }, // 第2轮 end_turn
    ]);
    const messages: StoredMessage[] = [sm({ role: 'user', content: 'go' })];
    const events = await collect(
      runAgent({ ...baseOpts(provider, messages), ctx: { cwd: process.cwd(), goal } }),
    );
    expect(events.at(-1)!.type).toBe('turn_done');
    // (1000 + 200) + (500 + 100) = 1800（input_tokens 本身已排除缓存命中部分）
    expect(goal.get()?.tokensUsed).toBe(1800);
  });

  it('goal token 计量：paused 期间回合不累计；无 goal 上下文不影响循环', async () => {
    const goal = new GoalMode();
    goal.create('A');
    goal.update('paused');
    const usage = { input_tokens: 100, output_tokens: 10 } as Anthropic.Usage;
    const { provider } = makeFakeProvider([
      { textChunks: ['完成'], finalContent: [textBlock('完成')], usage },
    ]);
    const messages: StoredMessage[] = [sm({ role: 'user', content: 'go' })];
    await collect(runAgent({ ...baseOpts(provider, messages), ctx: { cwd: process.cwd(), goal } }));
    expect(goal.get()?.tokensUsed).toBe(0);
    // ctx 无 goal（如子 agent / 非交互模式）：正常跑完
    const { provider: p2 } = makeFakeProvider([
      { textChunks: ['好'], finalContent: [textBlock('好')], usage },
    ]);
    const ev2 = await collect(runAgent(baseOpts(p2, [sm({ role: 'user', content: 'hi' })])));
    expect(ev2.at(-1)!.type).toBe('turn_done');
  });

  it('续接轮注入：hook 返回续接描述时产出 continuation + turn_done，本 run 结束', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: ['第一段'], finalContent: [textBlock('第一段')] },
    ]);
    const messages: StoredMessage[] = [sm({ role: 'user', content: 'go' })];
    const events = await collect(
      runAgent({
        ...baseOpts(provider, messages),
        hooks: { shouldContinueAfterStop: () => ({ inject: '继续推进' }) },
      }),
    );
    // 续接不在本 run 内续跑（轮级驱动：回 App 层发起下一轮），故只有一次模型调用
    expect(streamCalls()).toBe(1);
    const cont = events.find((e) => e.type === 'continuation') as
      | { type: 'continuation'; inject: string }
      | undefined;
    expect(cont?.inject).toBe('继续推进');
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('撞单轮步数上限：hook 返回续接描述时降级为 continuation 而非 error（不杀死 goal）', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'nonexistent_tool', {})] },
      { textChunks: [], finalContent: [toolUseBlock('c2', 'nonexistent_tool', {})] },
    ]);
    const messages: StoredMessage[] = [sm({ role: 'user', content: 'go' })];
    const events = await collect(
      runAgent({
        ...baseOpts(provider, messages),
        maxIterations: 2,
        hooks: { shouldContinueAfterStop: () => ({ inject: '换下一个 run 继续' }) },
      }),
    );
    // 单轮步数用完 → 正常收尾（continuation + turn_done），由 App 换下一个 run 继续
    expect(streamCalls()).toBe(2);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const cont = events.find((e) => e.type === 'continuation') as
      | { type: 'continuation'; inject: string }
      | undefined;
    expect(cont?.inject).toBe('换下一个 run 继续');
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('撞单轮步数上限：hook 缺省时照旧 error（非 goal 场景回归保护）', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'nonexistent_tool', {})] },
      { textChunks: [], finalContent: [toolUseBlock('c2', 'nonexistent_tool', {})] },
    ]);
    const messages: StoredMessage[] = [sm({ role: 'user', content: 'go' })];
    const events = await collect(
      runAgent({ ...baseOpts(provider, messages), maxIterations: 2 }),
    );
    expect(streamCalls()).toBe(2);
    expect(events.some((e) => e.type === 'continuation')).toBe(false);
    const err = events.find((e) => e.type === 'error') as
      | { type: 'error'; message: string }
      | undefined;
    expect(err?.message).toContain('2');
  });

  it('max_tokens 守卫拦停：goal 闸门放行时产出 continuation（不静默停跑，2026-08-15 根因 B 回归）', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      {
        textChunks: ['我需要先读取'],
        finalContent: [textBlock('我需要先读取'), toolUseBlock('call_1', 'nonexistent_tool', {})],
        stopReason: 'max_tokens',
      },
    ]);
    const messages: StoredMessage[] = [sm({ role: 'user', content: 'go' })];
    const events = await collect(
      runAgent({
        ...baseOpts(provider, messages),
        hooks: { shouldContinueAfterStop: () => ({ inject: '截断后继续推进' }) },
      }),
    );
    // 自动续写未开启（默认 0）→ 守卫拦停；但 goal 闸门放行 → 仍要产出 continuation 事件
    expect(streamCalls()).toBe(1);
    const cont = events.find((e) => e.type === 'continuation') as
      | { type: 'continuation'; inject: string }
      | undefined;
    expect(cont?.inject).toBe('截断后继续推进');
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('max_tokens thinking 耗尽：goal 闸门放行时产出 continuation（不静默停跑）', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [thinkingBlock('想了一大段')],
        stopReason: 'max_tokens',
      },
    ]);
    const messages: StoredMessage[] = [sm({ role: 'user', content: 'go' })];
    const events = await collect(
      runAgent({
        ...baseOpts(provider, messages),
        hooks: { shouldContinueAfterStop: () => ({ inject: '思考耗尽后继续' }) },
      }),
    );
    expect(streamCalls()).toBe(1);
    const cont = events.find((e) => e.type === 'continuation') as
      | { type: 'continuation'; inject: string }
      | undefined;
    expect(cont?.inject).toBe('思考耗尽后继续');
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('max_tokens 截断：hook 缺省时照旧无 continuation（非 goal 场景回归保护）', async () => {
    const { provider } = makeFakeProvider([
      {
        textChunks: ['我需要先读取'],
        finalContent: [textBlock('我需要先读取'), toolUseBlock('call_1', 'nonexistent_tool', {})],
        stopReason: 'max_tokens',
      },
    ]);
    const messages: StoredMessage[] = [sm({ role: 'user', content: 'go' })];
    const events = await collect(runAgent(baseOpts(provider, messages)));
    expect(events.some((e) => e.type === 'continuation')).toBe(false);
    expect(events.at(-1)!.type).toBe('turn_done');
  });
});
