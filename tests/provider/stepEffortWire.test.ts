import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { OpenAiChatProvider } from '../../src/provider/openaiChat.js';
import { OpenAiResponsesProvider } from '../../src/provider/openaiResponses.js';
import { stepEffortParam } from '../../src/provider/step/stepCommon.js';

/**
 * 三通道 effort 下发的端到端回归。
 *
 * 背景：Step 的三个接口都有思考控制字段，但参数名与嵌套层级各不相同。此前
 * openaiChat / openaiResponses 的 stream() 注释都写着「协议无 thinking 请求字段，
 * 忽略此参数」并真的忽略了，导致用户配的档位在这两条通道完全不生效——
 * 思考深度只由服务端默认值决定。2026-08-02 实测（step-3.7-flash 重任务）：
 * 不发 effort 思考 15975 字符，low 档 3248 字符，相差 5 倍。
 */
const MSG: Anthropic.MessageParam[] = [{ role: 'user', content: 'hi' }];

/** 造一个只记录请求体、返回空 SSE 的 fetch。 */
function recordingFetch(): { calls: Record<string, unknown>[]; impl: typeof fetch } {
  const calls: Record<string, unknown>[] = [];
  const impl = vi.fn(async (_url: string, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(new ReadableStream({ start: (c) => c.close() }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

async function drain(stream: { [Symbol.asyncIterator]: () => AsyncIterator<unknown> }): Promise<void> {
  try {
    for await (const _ of stream) {
      /* 不关心事件，只要触发请求发出 */
    }
  } catch {
    /* 空流会让 finalMessage 侧抛错，与本测无关 */
  }
}

describe('Chat Completions 通道：reasoning_effort 下发', () => {
  it('sendThinking + 档位 → 顶层 reasoning_effort', async () => {
    const { calls, impl } = recordingFetch();
    const p = new OpenAiChatProvider({
      apiKey: 'k', baseUrl: 'http://x/v1', model: 'step-3.7-flash', maxTokens: 1000,
      fetchImpl: impl, sendThinking: true, thinking: { level: 'medium' },
    });
    await drain(p.stream({ system: 's', tools: [], messages: MSG }));
    expect(calls[0]!['reasoning_effort']).toBe('medium');
  });

  it('sendThinking=false → 不发字段', async () => {
    const { calls, impl } = recordingFetch();
    const p = new OpenAiChatProvider({
      apiKey: 'k', baseUrl: 'http://x/v1', model: 'step-3.7-flash', maxTokens: 1000,
      fetchImpl: impl, sendThinking: false, thinking: { level: 'medium' },
    });
    await drain(p.stream({ system: 's', tools: [], messages: MSG }));
    expect(calls[0]).not.toHaveProperty('reasoning_effort');
  });

  it('thinking=null 本次强制不发（/think off）', async () => {
    const { calls, impl } = recordingFetch();
    const p = new OpenAiChatProvider({
      apiKey: 'k', baseUrl: 'http://x/v1', model: 'step-3.7-flash', maxTokens: 1000,
      fetchImpl: impl, sendThinking: true, thinking: { level: 'high' },
    });
    await drain(p.stream({ system: 's', tools: [], messages: MSG, thinking: null }));
    expect(calls[0]).not.toHaveProperty('reasoning_effort');
  });

  it('本次 thinking 覆盖构造默认', async () => {
    const { calls, impl } = recordingFetch();
    const p = new OpenAiChatProvider({
      apiKey: 'k', baseUrl: 'http://x/v1', model: 'step-3.7-flash', maxTokens: 1000,
      fetchImpl: impl, sendThinking: true, thinking: { level: 'high' },
    });
    await drain(p.stream({ system: 's', tools: [], messages: MSG, thinking: { level: 'low' } }));
    expect(calls[0]!['reasoning_effort']).toBe('low');
  });
});

describe('Responses 通道：reasoning.effort 下发', () => {
  it('sendThinking + 档位 → 嵌套 reasoning.effort（不是顶层）', async () => {
    const { calls, impl } = recordingFetch();
    const p = new OpenAiResponsesProvider({
      apiKey: 'k', baseUrl: 'http://x/v1', model: 'step-3.7-flash', maxTokens: 1000,
      fetchImpl: impl, sendThinking: true, thinking: { level: 'high' },
    });
    await drain(p.stream({ system: 's', tools: [], messages: MSG }));
    expect(calls[0]!['reasoning']).toEqual({ effort: 'high' });
    // Responses 用嵌套形式，顶层不应出现 reasoning_effort
    expect(calls[0]).not.toHaveProperty('reasoning_effort');
  });

  it('未开 sendThinking → 不发 reasoning', async () => {
    const { calls, impl } = recordingFetch();
    const p = new OpenAiResponsesProvider({
      apiKey: 'k', baseUrl: 'http://x/v1', model: 'step-3.7-flash', maxTokens: 1000,
      fetchImpl: impl, thinking: { level: 'medium' },
    });
    await drain(p.stream({ system: 's', tools: [], messages: MSG }));
    expect(calls[0]).not.toHaveProperty('reasoning');
  });
});

describe('三通道 effort 参数形态', () => {
  it('三通道参数名与层级各不相同', () => {
    // messages 是 output_config.effort（官方文档），不是顶层 effort
    expect(stepEffortParam('messages', 'low')).toEqual({ output_config: { effort: 'low' } });
    expect(stepEffortParam('chat', 'low')).toEqual({ reasoning_effort: 'low' });
    expect(stepEffortParam('responses', 'low')).toEqual({ reasoning: { effort: 'low' } });
  });

  it('effort 为 undefined 时一律返回空对象（不发字段）', () => {
    for (const ch of ['messages', 'chat', 'responses'] as const) {
      expect(stepEffortParam(ch, undefined)).toEqual({});
    }
  });
});
