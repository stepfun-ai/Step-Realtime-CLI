import { describe, expect, it } from 'vitest';
import { DEFAULT_THINKING_LEVELS, type StepCodeConfig } from '../../src/config/config.js';
import { createProvider } from '../../src/provider/factory.js';
import { StepfunAdapter } from '../../src/provider/adapter.js';
import { AnthropicMessagesProvider } from '../../src/provider/anthropicMessages.js';
import { OpenAiChatProvider } from '../../src/provider/openaiChat.js';
import type { NormalizedChatProvider } from '../../src/provider/normalizedProvider.js';
import { OpenAiResponsesProvider } from '../../src/provider/openaiResponses.js';

function baseConfig(overrides: Partial<StepCodeConfig> = {}): StepCodeConfig {
  return {
    provider: 'stepfun',
    apiKey: 'k',
    baseUrl: 'https://api.stepfun.com',
    model: 'step-3.7-flash',
    maxContextSize: 1_000_000,
    maxTokens: 8192,
    subagent: { maxDepth: 1, maxSteps: 100, maxConcurrent: 4 },
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

  it('anthropic → AnthropicMessagesProvider 实例（包装在历史整形装饰器内）', () => {
    const p = createProvider(
      baseConfig({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-x' }),
    );
    const inner = (p as NormalizedChatProvider).inner;
    expect(inner).toBeInstanceOf(AnthropicMessagesProvider);
    expect(typeof p.stream).toBe('function');
  });

  it('openai → OpenAiChatProvider 实例（包装在历史整形装饰器内）', () => {
    const p = createProvider(
      baseConfig({ provider: 'openai', baseUrl: 'https://api.stepfun.com/v1' }),
    );
    const inner = (p as NormalizedChatProvider).inner;
    expect(inner).toBeInstanceOf(OpenAiChatProvider);
    expect(typeof p.stream).toBe('function');
  });

  it('openai_responses → OpenAiResponsesProvider 实例（包装在历史整形装饰器内）', () => {
    const p = createProvider(
      baseConfig({ provider: 'openai_responses', baseUrl: 'https://api.stepfun.com/v1' }),
    );
    const inner = (p as NormalizedChatProvider).inner;
    expect(inner).toBeInstanceOf(OpenAiResponsesProvider);
    expect(typeof p.stream).toBe('function');
  });

  it('未知 provider → 抛清晰错误', () => {
    expect(() => createProvider(baseConfig({ provider: 'not-a-real-provider' }))).toThrow(/未知服务商/);
  });

  it('stepfun + [thinking] enabled=true → sendThinking 覆盖为 true 并注入档位', () => {
    const p = createProvider(
      baseConfig({
        thinking: { enabled: true, levels: { low: 1024, medium: 4096, high: 32000 }, defaultLevel: 'medium' },
      }),
    );
    const internals = p as unknown as { sendThinking: boolean; thinking?: { level?: string; budgetTokens?: number } };
    expect(internals.sendThinking).toBe(true);
    // 同时带 level 与 budgetTokens：阶跃三协议取 level，原生 Anthropic 取 budgetTokens。
    expect(internals.thinking).toEqual({ level: 'medium', budgetTokens: 4096 });
  });

  it('[thinking] enabled=true 未配 default_level → 仍注入 medium 档，不留空', () => {
    // 行为变更（2026-08-03）：旧实现在「启用但没给 budget」时故意不构造 thinking 对象，
    // 理由是「不替用户猜档位」。这个理由被实测推翻——不发 effort 不是中性的，
    // 阶跃三通道在不发 effort 时思考量全部落在 high 附近，即「留空 = 跑最高思考量」，
    // 而 high 档在难任务上会把 max_tokens 打满、正文零输出。
    // 所以「不猜」实际效果等于「悄悄选了最高档」，反而是最危险的一种默认。
    const p = createProvider(baseConfig({ thinking: { enabled: true, levels: DEFAULT_THINKING_LEVELS } }));
    const internals = p as unknown as { sendThinking: boolean; thinking?: { level?: string } };
    expect(internals.sendThinking).toBe(true);
    expect(internals.thinking?.level).toBe('medium');
  });

  it('[thinking] default_level 决定构造默认档位', () => {
    const p = createProvider(
      baseConfig({
        thinking: {
          enabled: true,
          levels: { low: 1024, medium: 4096, high: 32000 },
          defaultLevel: 'high',
        },
      }),
    );
    const internals = p as unknown as { thinking?: { level?: string; budgetTokens?: number } };
    expect(internals.thinking).toEqual({ level: 'high', budgetTokens: 32000 });
  });

  it('自定义 levels 数字不影响下发的档位名（曾经会静默错档）', () => {
    // 回归护栏：旧实现把档位折算成数字再由 provider 反推档位，反推阈值硬编码
    // （<2560→low、<18048→medium、其余 high）。用户把 medium 配成 20000 时，
    // 反推结果是 high——选 medium 却发 high。现在档位名直达，数字只喂原生 Anthropic。
    const p = createProvider(
      baseConfig({
        thinking: { enabled: true, levels: { low: 1024, medium: 20000, high: 32000 }, defaultLevel: 'medium' },
      }),
    );
    const internals = p as unknown as { thinking?: { level?: string; budgetTokens?: number } };
    expect(internals.thinking?.level).toBe('medium');
    expect(internals.thinking?.budgetTokens).toBe(20000);
  });

  it('stepfun 未配 [thinking] → sendThinking 保持 false，无 thinking 参数（既有行为不变）', () => {
    const p = createProvider(baseConfig());
    const internals = p as unknown as { sendThinking: boolean; thinking?: unknown };
    expect(internals.sendThinking).toBe(false);
    expect(internals.thinking).toBeUndefined();
  });

  it('anthropic 预设 sendThinking=true，但未配 [thinking] 时不注入 thinking 参数', () => {
    const p = createProvider(baseConfig({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com' }));
    const inner = (p as NormalizedChatProvider).inner as unknown as { sendThinking: boolean; thinking?: unknown };
    expect(inner.sendThinking).toBe(true);
    expect(inner.thinking).toBeUndefined();
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
