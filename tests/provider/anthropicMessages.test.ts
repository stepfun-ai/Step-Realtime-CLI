import { describe, expect, it, vi } from 'vitest';
import { AnthropicMessagesProvider } from '../../src/provider/anthropicMessages.js';

/** 捕获 messages.stream 收到的请求体（vi.mock 工厂内引用，需 vi.hoisted）。 */
const captured = vi.hoisted(() => ({ bodies: [] as Record<string, unknown>[] }));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = {
      stream: (body: Record<string, unknown>) => {
        captured.bodies.push(body);
        // 满足 provider 返回契约的最小假流（本测试只关心请求体，不消费流）
        return {
          [Symbol.asyncIterator]: () => (async function* () {})(),
          finalMessage: async () => ({ content: [], stop_reason: 'end_turn' }),
        };
      },
    };
  }
  return { default: FakeAnthropic };
});

function makeProvider(opts: {
  sendThinking?: boolean;
  thinking?: { budgetTokens?: number };
  /** 传给 stream 的 thinking 覆盖（三态测试）：省略 = undefined。 */
  streamThinking?: { budgetTokens?: number } | null;
}) {
  captured.bodies.length = 0;
  const p = new AnthropicMessagesProvider({
    apiKey: 'k',
    baseUrl: 'https://api.stepfun.com',
    model: 'step-3.7-flash',
    maxTokens: 32768,
    sendThinking: opts.sendThinking,
    thinking: opts.thinking,
  });
  p.stream({ system: 's', tools: [], messages: [], thinking: opts.streamThinking });
  return captured.bodies[0]!;
}

describe('AnthropicMessagesProvider thinking 请求字段', () => {
  it('sendThinking + 配置 budget → 请求体带 {type:enabled, budget_tokens}', () => {
    const body = makeProvider({ sendThinking: true, thinking: { budgetTokens: 8192 } });
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 8192 });
  });

  it('sendThinking + 未配 budget → 只带 {type:enabled}', () => {
    const body = makeProvider({ sendThinking: true, thinking: {} });
    expect(body['thinking']).toEqual({ type: 'enabled' });
    expect('budget_tokens' in (body['thinking'] as object)).toBe(false);
  });

  it('sendThinking 为 true 但未配置 [thinking] → 绝不含 thinking 字段', () => {
    const body = makeProvider({ sendThinking: true });
    expect('thinking' in body).toBe(false);
  });

  it('sendThinking 为 false 时即使注入参数也绝不带 thinking 字段（quirk 关闭优先）', () => {
    const body = makeProvider({ sendThinking: false, thinking: { budgetTokens: 8192 } });
    expect('thinking' in body).toBe(false);
  });

  it('默认（sendThinking 缺省）→ 绝不含 thinking 字段（既有行为字节级不变）', () => {
    const body = makeProvider({});
    expect('thinking' in body).toBe(false);
  });

  it('绝不发 {type:disabled}（实测被服务端忽略）', () => {
    for (const body of captured.bodies) {
      expect((body['thinking'] as { type?: string } | undefined)?.type).not.toBe('disabled');
    }
  });
});

describe('AnthropicMessagesProvider thinking 调用级覆盖（三态）', () => {
  it('undefined（不传）→ 用构造默认', () => {
    const body = makeProvider({ sendThinking: true, thinking: { budgetTokens: 8192 } });
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 8192 });
  });

  it('对象覆盖 → 本次用覆盖 budget，构造默认被顶替', () => {
    const body = makeProvider({
      sendThinking: true,
      thinking: { budgetTokens: 8192 },
      streamThinking: { budgetTokens: 4096 },
    });
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 4096 });
  });

  it('空对象覆盖 → 只带 {type:enabled}（即使构造默认带 budget）', () => {
    const body = makeProvider({
      sendThinking: true,
      thinking: { budgetTokens: 8192 },
      streamThinking: {},
    });
    expect(body['thinking']).toEqual({ type: 'enabled' });
    expect('budget_tokens' in (body['thinking'] as object)).toBe(false);
  });

  it('构造默认无 budget、覆盖带 budget → 本次带 budget', () => {
    const body = makeProvider({ sendThinking: true, thinking: {}, streamThinking: { budgetTokens: 1024 } });
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 1024 });
  });

  it('null → 本次强制不发 thinking 字段（构造默认与 sendThinking 均被抑制）', () => {
    const body = makeProvider({
      sendThinking: true,
      thinking: { budgetTokens: 8192 },
      streamThinking: null,
    });
    expect('thinking' in body).toBe(false);
  });

  it('覆盖不越过 sendThinking 闸门：sendThinking=false 时对象覆盖也不发', () => {
    const body = makeProvider({ sendThinking: false, streamThinking: { budgetTokens: 4096 } });
    expect('thinking' in body).toBe(false);
  });
});
