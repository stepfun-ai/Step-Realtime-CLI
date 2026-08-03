import { describe, expect, it } from 'vitest';
import type { StepCodeConfig } from '../../src/config/config.js';
import { createProvider } from '../../src/provider/factory.js';
import { StepfunAdapter } from '../../src/provider/adapter.js';
import { AnthropicMessagesProvider } from '../../src/provider/anthropicMessages.js';
import { OpenAiChatProvider } from '../../src/provider/openaiChat.js';
import { OpenAiResponsesProvider } from '../../src/provider/openaiResponses.js';

function baseConfig(overrides: Partial<StepCodeConfig> = {}): StepCodeConfig {
  return {
    provider: 'stepfun',
    apiKey: 'k',
    baseUrl: 'https://api.stepfun.com',
    model: 'step-3.7-flash',
    maxContextSize: 1_000_000,
    maxTokens: 8192,
    subagent: { maxPerSession: 10, maxDepth: 1, maxSteps: 100, maxConcurrent: 4 },
    compaction: { triggerRatio: 0.85, reservedTokens: 32_000 },
    ...overrides,
  };
}

describe('createProvider', () => {
  it('stepfun → StepfunAdapter 实例（一厂一 adapter，边界层生效）', () => {
    const p = createProvider(baseConfig({ provider: 'stepfun' }));
    expect(p).toBeInstanceOf(StepfunAdapter);
    expect(typeof p.stream).toBe('function');
  });

  it('anthropic → AnthropicMessagesProvider 实例', () => {
    const p = createProvider(
      baseConfig({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-x' }),
    );
    expect(p).toBeInstanceOf(AnthropicMessagesProvider);
    expect(typeof p.stream).toBe('function');
  });

  it('openai → OpenAiChatProvider 实例', () => {
    const p = createProvider(
      baseConfig({ provider: 'openai', baseUrl: 'https://api.stepfun.com/v1' }),
    );
    expect(p).toBeInstanceOf(OpenAiChatProvider);
    expect(typeof p.stream).toBe('function');
  });

  it('openai_responses → OpenAiResponsesProvider 实例', () => {
    const p = createProvider(
      baseConfig({ provider: 'openai_responses', baseUrl: 'https://api.stepfun.com/v1' }),
    );
    expect(p).toBeInstanceOf(OpenAiResponsesProvider);
    expect(typeof p.stream).toBe('function');
  });

  it('未知 provider → 抛清晰错误', () => {
    expect(() => createProvider(baseConfig({ provider: 'not-a-real-provider' }))).toThrow(/未知服务商/);
  });

  it('stepfun + [thinking] enabled=true → sendThinking 覆盖为 true 并注入 budget', () => {
    const p = createProvider(baseConfig({ thinking: { enabled: true, budgetTokens: 4096, levels: { low: 1024 } } }));
    const internals = p as unknown as { sendThinking: boolean; thinking?: { budgetTokens?: number } };
    expect(internals.sendThinking).toBe(true);
    expect(internals.thinking).toEqual({ budgetTokens: 4096 });
  });

  it('stepfun + [thinking] enabled=true 未配 budget → 只开 sendThinking，不构造空 thinking 对象', () => {
    const p = createProvider(baseConfig({ thinking: { enabled: true, levels: { low: 1024 } } }));
    const internals = p as unknown as { sendThinking: boolean; thinking?: { budgetTokens?: number } };
    expect(internals.sendThinking).toBe(true);
    // 旧行为构造 { budgetTokens: undefined }：一个「存在但内部为空」的对象，语义上表达
    // 「用户指定了预算」，实际没有。三通道的 effort 下发都以 thinking !== undefined 为门槛，
    // 空对象会让它们进入下发分支再靠内层 undefined 兜回来，多一层无谓状态。
    expect(internals.thinking).toBeUndefined();
  });

  it('[thinking] default_level 命中档位 → 该档 budget 作为构造默认（优先于 budget_tokens）', () => {
    const p = createProvider(
      baseConfig({
        thinking: {
          enabled: true,
          budgetTokens: 4096,
          levels: { low: 1024, high: 32000 },
          defaultLevel: 'high',
        },
      }),
    );
    const internals = p as unknown as { thinking?: { budgetTokens?: number } };
    expect(internals.thinking).toEqual({ budgetTokens: 32000 });
  });

  it('stepfun 未配 [thinking] → sendThinking 保持 false，无 thinking 参数（既有行为不变）', () => {
    const p = createProvider(baseConfig());
    const internals = p as unknown as { sendThinking: boolean; thinking?: unknown };
    expect(internals.sendThinking).toBe(false);
    expect(internals.thinking).toBeUndefined();
  });

  it('anthropic 预设 sendThinking=true，但未配 [thinking] 时不注入 thinking 参数', () => {
    const p = createProvider(baseConfig({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com' }));
    const internals = p as unknown as { sendThinking: boolean; thinking?: unknown };
    expect(internals.sendThinking).toBe(true);
    expect(internals.thinking).toBeUndefined();
  });
});

describe('createProvider 缺失 API key 守卫', () => {
  it('apiKey undefined → 抛 factory.missingApiKey（错误信息含 provider 名）', () => {
    expect(() => createProvider(baseConfig({ apiKey: undefined }))).toThrow(/缺少 API key（provider=stepfun）/);
  });

  it('apiKey 空串 → 同样抛 missingApiKey', () => {
    expect(() => createProvider(baseConfig({ provider: 'anthropic', apiKey: '' }))).toThrow(
      /缺少 API key（provider=anthropic）/,
    );
  });

  it('错误文案给出多渠道配置指引（惯例环境变量 / 渠道与别名的 api_key / api_key_env）', () => {
    let message = '';
    try {
      createProvider(baseConfig({ apiKey: undefined }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('STEP_CODE_API_KEY');
    expect(message).toContain('[providers]');
    expect(message).toContain('api_key_env');
  });
});
