import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

/**
 * StepMessagesProvider 的 wire 形状回归。
 *
 * Step 的 /v1/messages 声明兼容 Anthropic Messages，但**思考控制参数不兼容**：
 * 官方的 `thinking: { type, budget_tokens }` 会被接受（HTTP 200）却静默无效，
 * Step 认的是顶层 `effort`。
 *
 * 2026-08-02 实测（step-3.7-flash，max_tokens=2048，同一提问）：
 * ```
 * thinking:{type:'enabled',budget_tokens:4096}  → stop_reason=max_tokens  正文 628（截断）
 * effort:'low'                                  → stop_reason=end_turn    正文 803（收尾）
 * thinking + effort 同发                        → stop_reason=max_tokens  正文 288（更差）
 * ```
 * 同发比只发 effort 更差，因此本 provider 只发 effort、绝不发 thinking。
 */
const captured = vi.hoisted(() => ({ bodies: [] as Record<string, unknown>[] }));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = {
      stream: (body: Record<string, unknown>) => {
        captured.bodies.push(body);
        return {
          [Symbol.asyncIterator]: () => (async function* () {})(),
          finalMessage: async () => ({ content: [], stop_reason: 'end_turn' }),
        };
      },
    };
  }
  return { default: FakeAnthropic };
});

const { StepMessagesProvider } = await import('../../src/provider/step/stepMessages.js');
type ThinkingParam = { level?: 'low' | 'medium' | 'high'; budgetTokens?: number };

const MSG: Anthropic.MessageParam[] = [{ role: 'user', content: 'hi' }];

function send(opts: {
  sendThinking?: boolean;
  thinking?: ThinkingParam;
  streamThinking?: ThinkingParam | null;
}): Record<string, unknown> {
  captured.bodies.length = 0;
  const p = new StepMessagesProvider({
    apiKey: 'k',
    baseUrl: 'http://example.invalid',
    model: 'step-3.7-flash',
    maxTokens: 2048,
    ...(opts.sendThinking !== undefined ? { sendThinking: opts.sendThinking } : {}),
    ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
  });
  p.stream({
    system: 's',
    tools: [],
    messages: MSG,
    ...('streamThinking' in opts ? { thinking: opts.streamThinking } : {}),
  });
  return captured.bodies[0]!;
}

/** 取 wire 上的档位：官方写法是 output_config.effort（不是顶层 effort）。 */
function effortOf(body: Record<string, unknown>): unknown {
  return (body['output_config'] as Record<string, unknown> | undefined)?.['effort'];
}

describe('StepMessagesProvider：output_config.effort 而非 thinking', () => {
  it('sendThinking + 档位 → output_config.effort，且 wire 上没有 thinking 字段', () => {
    const body = send({ sendThinking: true, thinking: { level: 'medium' } });
    expect(effortOf(body)).toBe('medium');
    expect(body).not.toHaveProperty('thinking');
    // 顶层 effort 是曾经的错误写法，Step 静默忽略它，必须确认不再发送
    expect(body).not.toHaveProperty('effort');
  });

  it('low 档位原样下发', () => {
    expect(effortOf(send({ sendThinking: true, thinking: { level: 'low' } }))).toBe('low');
  });

  it('high 档位原样下发', () => {
    expect(effortOf(send({ sendThinking: true, thinking: { level: 'high' } }))).toBe('high');
  });

  it('sendThinking=false → 不发 output_config', () => {
    const body = send({ sendThinking: false, thinking: { level: 'medium' } });
    expect(body).not.toHaveProperty('output_config');
    expect(body).not.toHaveProperty('thinking');
  });

  it('thinking=null（/think off）→ 不发 output_config', () => {
    const body = send({ sendThinking: true, thinking: { level: 'medium' }, streamThinking: null });
    expect(body).not.toHaveProperty('output_config');
  });

  it('未给 budget → 不发 output_config，走服务端默认强度', () => {
    const body = send({ sendThinking: true, thinking: {} });
    expect(body).not.toHaveProperty('output_config');
  });

  it('max_tokens 始终发送（Step Messages 必填，缺省 400）', () => {
    expect(send({ sendThinking: true, thinking: { level: 'medium' } })['max_tokens']).toBe(2048);
  });

  it('cache_control 默认不注入（Step 全通道不兼容）', () => {
    const body = send({ sendThinking: true, thinking: { level: 'medium' } });
    expect(JSON.stringify(body)).not.toContain('cache_control');
  });
});
