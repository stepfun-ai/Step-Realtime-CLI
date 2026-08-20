import type Anthropic from '@anthropic-ai/sdk';
import AnthropicSDK from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/agent/events.js';
import { runAgent } from '../../src/agent/loop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { subagentRequeueDelay, SUBAGENT_REQUEUE_MAX } from '../../src/agent/runTurn.js';
import type { ToolContext } from '../../src/tools/types.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';

const LONG = 'x'.repeat(220); // >200，跳过子 agent 摘要补写

const rateLimitErr = (headers?: Headers): AnthropicSDK.APIError =>
  new AnthropicSDK.APIError(429, undefined, 'rate limited', headers);

function sm(text: string): StoredMessage {
  return stored({ role: 'user', content: text }, { kind: 'user' });
}

const base = (
  provider: ReturnType<typeof makeFakeProvider>['provider'],
  messages: StoredMessage[],
  over: { ctx?: ToolContext; signal?: AbortSignal } = {},
) => ({
  provider,
  system: 'sys',
  ctx: over.ctx ?? { cwd: process.cwd() },
  messages,
  signal: over.signal,
});

/** 取回合里追加的那条 tool_result 消息的块数组。 */
function toolResultBlocks(messages: StoredMessage[]): Anthropic.ToolResultBlockParam[] {
  const m = messages.find(
    (mm) => mm.message.role === 'user' && Array.isArray(mm.message.content),
  );
  return m!.message.content as Anthropic.ToolResultBlockParam[];
}

describe('subagentRequeueDelay（429 重排策略）', () => {
  it('429 限流失败 → 延迟阶梯 3s → 6s，第 3 次（requeued=2）不再重排', () => {
    const result = { isError: true, cause: rateLimitErr() };
    expect(subagentRequeueDelay(result, 0)).toBe(3000);
    expect(subagentRequeueDelay(result, 1)).toBe(6000);
    expect(subagentRequeueDelay(result, SUBAGENT_REQUEUE_MAX)).toBeUndefined();
  });

  it('错误带合法 Retry-After 头时优先用其值', () => {
    const result = { isError: true, cause: rateLimitErr(new Headers({ 'retry-after': '5' })) };
    expect(subagentRequeueDelay(result, 0)).toBe(5000);
  });

  it('非 429（含其他 4xx/5xx）不重排；成功结果与空结果不重排', () => {
    expect(
      subagentRequeueDelay({ isError: true, cause: new AnthropicSDK.APIError(500, undefined, 'x', undefined) }, 0),
    ).toBeUndefined();
    expect(
      subagentRequeueDelay({ isError: true, cause: new AnthropicSDK.APIError(403, undefined, 'x', undefined) }, 0),
    ).toBeUndefined();
    expect(subagentRequeueDelay({ isError: false }, 0)).toBeUndefined();
    expect(subagentRequeueDelay(undefined, 0)).toBeUndefined();
  });
});

describe('runTurn 并行子 agent 的 429 重排队', () => {
  it('429 失败 → 重排队尾重跑成功：runSubagent 调用 2 次，notice 透出，结果不占错误槽', async () => {
    let c1Calls = 0;
    const ctx: ToolContext = {
      cwd: process.cwd(),
      depth: 0,
      runSubagent: async (req) => {
        if (req.prompt === 'unlucky') {
          c1Calls++;
          if (c1Calls === 1) return { summary: '子 agent 执行出错，未产出结果。', isError: true, cause: rateLimitErr() };
        }
        await new Promise((r) => setTimeout(r, 50));
        return { summary: `done:${req.prompt}${LONG}`, isError: false };
      },
    };
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'spawn_agent', { prompt: 'unlucky', subagent_type: 'explore' }),
          toolUseBlock('c2', 'spawn_agent', { prompt: 'lucky', subagent_type: 'explore' }),
        ],
      },
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent(base(provider, messages, { ctx })));

    expect(c1Calls).toBe(2); // 第一次 429 → 重排队尾 → 第二次成功
    const notice = events.find((e) => e.type === 'notice') as { type: 'notice'; message: string } | undefined;
    expect(notice?.message).toContain('429');
    expect(notice?.message).toContain('3000ms');
    const blocks = toolResultBlocks(messages);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['c1', 'c2']);
    expect(blocks.every((b) => b.is_error !== true)).toBe(true);
    expect(events.at(-1)!.type).toBe('turn_done');
  }, 15000);

  it('非 429 的失败（500）不重排：runSubagent 只调 1 次，直接占错误槽', async () => {
    let c1Calls = 0;
    const ctx: ToolContext = {
      cwd: process.cwd(),
      depth: 0,
      runSubagent: async (req) => {
        if (req.prompt === 'broken') {
          c1Calls++;
          return {
            summary: '子 agent 执行出错，未产出结果。',
            isError: true,
            cause: new AnthropicSDK.APIError(500, undefined, 'server error', undefined),
          };
        }
        await new Promise((r) => setTimeout(r, 50));
        return { summary: `done:${req.prompt}${LONG}`, isError: false };
      },
    };
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'spawn_agent', { prompt: 'broken', subagent_type: 'explore' }),
          toolUseBlock('c2', 'spawn_agent', { prompt: 'fine', subagent_type: 'explore' }),
        ],
      },
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent(base(provider, messages, { ctx })));

    expect(c1Calls).toBe(1);
    expect(events.some((e) => e.type === 'notice')).toBe(false);
    const blocks = toolResultBlocks(messages);
    expect(blocks[0]!.is_error).toBe(true);
    expect(blocks[1]!.is_error).not.toBe(true);
  });

  it('唯一未完成任务不重排（防死锁）：单个 spawn_agent 429 直接占错误槽', async () => {
    let calls = 0;
    const ctx: ToolContext = {
      cwd: process.cwd(),
      depth: 0,
      runSubagent: async () => {
        calls++;
        return { summary: '子 agent 执行出错，未产出结果。', isError: true, cause: rateLimitErr() };
      },
    };
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [toolUseBlock('c1', 'spawn_agent', { prompt: 'alone', subagent_type: 'explore' })],
      },
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent(base(provider, messages, { ctx })));

    expect(calls).toBe(1);
    expect(events.some((e) => e.type === 'notice')).toBe(false);
    expect(toolResultBlocks(messages)[0]!.is_error).toBe(true);
  });

  it('重排上限 2 次：持续 429 跑 3 次后占错误槽，notice 透出 2 次', async () => {
    let c1Calls = 0;
    let releaseC2!: () => void;
    const c2Gate = new Promise<void>((r) => {
      releaseC2 = r;
    });
    const ctx: ToolContext = {
      cwd: process.cwd(),
      depth: 0,
      runSubagent: async (req) => {
        if (req.prompt === 'doomed') {
          c1Calls++;
          if (c1Calls >= 3) releaseC2(); // c1 第三次失败后放行 c2，保证前两次重排时批内有未完成任务
          return { summary: '子 agent 执行出错，未产出结果。', isError: true, cause: rateLimitErr() };
        }
        await c2Gate;
        return { summary: `done:${req.prompt}${LONG}`, isError: false };
      },
    };
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'spawn_agent', { prompt: 'doomed', subagent_type: 'explore' }),
          toolUseBlock('c2', 'spawn_agent', { prompt: 'waiting', subagent_type: 'explore' }),
        ],
      },
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent(base(provider, messages, { ctx })));

    expect(c1Calls).toBe(3); // 首跑 + 2 次重排，第 3 次失败占槽
    const notices = events.filter((e) => e.type === 'notice');
    expect(notices).toHaveLength(2);
    const blocks = toolResultBlocks(messages);
    expect(blocks[0]!.is_error).toBe(true);
    expect(blocks[1]!.is_error).not.toBe(true);
    expect(events.at(-1)!.type).toBe('turn_done');
  }, 25000);
});

describe('runTurn 错误码 → 建议用户动作文案', () => {
  it('401 → error 事件附检查 STEP_CODE_API_KEY / config.toml 的建议', async () => {
    const { provider } = makeFakeProvider([
      { throw: new AnthropicSDK.APIError(401, undefined, 'invalid api key', undefined) },
    ]);
    const events = await collect(runAgent(base(provider, [sm('hi')])));
    const err = events.find((e) => e.type === 'error') as { type: 'error'; message: string } | undefined;
    expect(err?.message).toContain('STEP_CODE_API_KEY');
    expect(err?.message).toContain('config.toml');
  });

  it('429 重试耗尽 → error 事件附限流持续的建议', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { throw: rateLimitErr() },
      { throw: rateLimitErr() },
      { throw: rateLimitErr() },
    ]);
    const events = await collect(runAgent(base(provider, [sm('hi')])));
    const err = events.find((e) => e.type === 'error') as { type: 'error'; message: string } | undefined;
    expect(streamCalls()).toBe(3); // 重试循环先扛过一轮
    expect(err?.message).toContain('限流持续');
  }, 15000);

  it('上下文溢出压缩后仍失败 → error 事件提示 /compact 或 /new', async () => {
    const overflowErr = new AnthropicSDK.APIError(400, undefined, 'prompt is too long', undefined);
    const { provider } = makeFakeProvider([{ throw: overflowErr }]);
    const events = await collect(runAgent(base(provider, [sm('hi')])));
    const err = events.find((e) => e.type === 'error') as { type: 'error'; message: string } | undefined;
    expect(err?.message).toContain('/compact');
    expect(err?.message).toContain('/new');
  });
});
