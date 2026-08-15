/**
 * `[compaction] model` → 压缩摘要绑定的解析测试。
 *
 * 覆盖四条分支：未配置 / 裸模型 id / 命中别名（跨渠道建独立 provider）/ 别名渠道构造失败。
 * 关键回归点：命中别名时必须**换 provider 实例**——只换 model id 会把跨渠道模型名发给
 * 主会话端点，那是稳定失败，压缩持续报错等于上下文兜底失效。
 */
import { describe, expect, it } from 'vitest';
import type { StepCodeConfig } from '../../src/config/config.js';
import { resolveCompactionBinding } from '../../src/provider/compaction.js';
import { OpenAiChatProvider } from '../../src/provider/openaiChat.js';
import type { NormalizedChatProvider } from '../../src/provider/normalizedProvider.js';
import { StepfunAdapter } from '../../src/provider/adapter.js';
import type { ChatProvider } from '../../src/provider/types.js';

function baseConfig(overrides: Partial<StepCodeConfig> = {}): StepCodeConfig {
  return {
    provider: 'stepfun',
    apiKey: 'main-key',
    baseUrl: 'https://api.stepfun.com',
    model: 'step-3.7-flash',
    maxContextSize: 1_000_000,
    maxTokens: 8192,
    subagent: { maxDepth: 1, maxSteps: 100, maxConcurrent: 4 },
    compaction: { triggerRatio: 0.85, reservedTokens: 32_000 },
    ...overrides,
  };
}

/** 主会话走 stepfun（anthropic 协议），另有一条 openai 协议的 plan 渠道。 */
function crossChannelConfig(compactionModel?: string): StepCodeConfig {
  const compaction: StepCodeConfig['compaction'] = { triggerRatio: 0.85, reservedTokens: 32_000 };
  if (compactionModel !== undefined) compaction.model = compactionModel;
  return baseConfig({
    compaction,
    providers: {
      'stepfun-plan': {
        type: 'openai',
        baseUrl: 'https://api.stepfun.com/step_plan/v1',
        apiKey: 'plan-key',
      },
    },
    models: {
      'step35-plan': {
        provider: 'stepfun-plan',
        model: 'step-3.5-flash-2603',
        maxContextSize: 262_144,
      },
    },
  });
}

describe('resolveCompactionBinding', () => {
  it('未配置 → 空绑定（沿用主会话 provider 与模型）', () => {
    expect(resolveCompactionBinding(baseConfig())).toEqual({});
  });

  it('空串视同未配置', () => {
    const cfg = baseConfig({ compaction: { triggerRatio: 0.85, reservedTokens: 32_000, model: '' } });
    expect(resolveCompactionBinding(cfg)).toEqual({});
  });

  it('裸模型 id（未命中别名）→ 只回 model，不建 provider（旧行为，向后兼容）', () => {
    const cfg = baseConfig({
      compaction: { triggerRatio: 0.85, reservedTokens: 32_000, model: 'step-3.5-flash-2603' },
    });
    const binding = resolveCompactionBinding(cfg);
    expect(binding.model).toBe('step-3.5-flash-2603');
    expect(binding.provider).toBeUndefined();
  });

  it('命中别名 → 建该别名渠道的独立 provider，且模型解析为别名的真实 id', () => {
    const binding = resolveCompactionBinding(crossChannelConfig('step35-plan'));
    // 主会话是 stepfun（anthropic 协议 → StepfunAdapter），压缩必须换成 openai 协议实例
    const inner = (binding.provider as NormalizedChatProvider).inner;
    expect(inner).toBeInstanceOf(OpenAiChatProvider);
    expect(binding.provider).not.toBeInstanceOf(StepfunAdapter);
    // 回的是别名绑定的真实模型 id，不是别名本身
    expect(binding.model).toBe('step-3.5-flash-2603');
  });

  it('缓存命中时复用同一 provider 实例（不重复构造 SDK 客户端）', () => {
    const cfg = crossChannelConfig('step35-plan');
    const cache = new Map<string, ChatProvider>();
    const first = resolveCompactionBinding(cfg, cache);
    const second = resolveCompactionBinding(cfg, cache);
    expect(first.provider).toBeDefined();
    expect(second.provider).toBe(first.provider);
    expect(cache.size).toBe(1);
  });

  it('别名渠道构造失败（缺 key）→ 整体放弃覆盖，回退主会话模型', () => {
    const cfg = baseConfig({
      apiKey: undefined, // 掐断顶层回落，让别名渠道拿不到任何 key
      compaction: { triggerRatio: 0.85, reservedTokens: 32_000, model: 'broken' },
      providers: { bare: { type: 'openai', baseUrl: 'https://example.invalid/v1' } },
      models: { broken: { provider: 'bare', model: 'whatever' } },
    });
    // 关键：不能退化成 { model: 'broken' }——那会把跨渠道模型名发给主会话端点，每次压缩稳定失败
    expect(resolveCompactionBinding(cfg)).toEqual({});
  });

  it('别名指向不存在的渠道且非内置预设 → 按裸模型 id 处理', () => {
    const cfg = baseConfig({
      compaction: { triggerRatio: 0.85, reservedTokens: 32_000, model: 'ghost' },
      models: { ghost: { provider: 'no-such-channel', model: 'x' } },
    });
    const binding = resolveCompactionBinding(cfg);
    expect(binding.provider).toBeUndefined();
    expect(binding.model).toBe('ghost');
  });

  it('会话级覆盖（/compact-model）优先于 config：override 是裸 id 时 config 里的别名不生效', () => {
    const cfg = crossChannelConfig('step35-plan');
    const binding = resolveCompactionBinding(cfg, undefined, 'step-3.5-flash-2603');
    expect(binding.provider).toBeUndefined();
    expect(binding.model).toBe('step-3.5-flash-2603');
  });

  it('override 命中别名 → 与 config 来源同一解析路径：建独立 provider、回真实模型 id', () => {
    const binding = resolveCompactionBinding(crossChannelConfig(), undefined, 'step35-plan');
    const inner = (binding.provider as NormalizedChatProvider).inner;
    expect(inner).toBeInstanceOf(OpenAiChatProvider);
    expect(binding.model).toBe('step-3.5-flash-2603');
  });

  it('override 显式传 undefined → 与现状一致（config 生效）', () => {
    const binding = resolveCompactionBinding(crossChannelConfig('step35-plan'), undefined, undefined);
    expect(binding.provider).toBeDefined();
    expect(binding.model).toBe('step-3.5-flash-2603');
  });

  it('override 与 config 来源共享同一 provider 缓存（按别名键，/reload 清缓存由调用方负责）', () => {
    const cfg = crossChannelConfig();
    const cache = new Map<string, ChatProvider>();
    const first = resolveCompactionBinding(cfg, cache, 'step35-plan');
    const second = resolveCompactionBinding(cfg, cache, 'step35-plan');
    expect(second.provider).toBe(first.provider);
    expect(cache.size).toBe(1);
  });
});
