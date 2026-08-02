import { describe, expect, it } from 'vitest';
import {
  resolveCapability,
  UNKNOWN_CAPABILITY,
  type CapabilityOverride,
} from '../../src/provider/capability-registry.js';

describe('resolveCapability 静态表', () => {
  it('stepfun 通道 step-3 前缀命中：cache_control 声明为不支持', () => {
    const cap = resolveCapability('stepfun', 'step-3.7-flash');
    expect(cap.source).toBe('table');
    expect(cap.cache_control).toBe(false);
    expect(cap.image_in).toBe(true);
    expect(cap.reasoning).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('查不到的通道/模型返回全 false 的 UNKNOWN 能力', () => {
    const cap = resolveCapability('no-such-channel', 'whatever-1');
    expect(cap.source).toBe('unknown');
    expect(cap).toMatchObject(UNKNOWN_CAPABILITY);
  });

  it('通道内模型前缀不匹配同样回落 UNKNOWN', () => {
    const cap = resolveCapability('stepfun', 'other-9');
    expect(cap.source).toBe('unknown');
    expect(cap.tool_use).toBe(false);
  });
});

describe('resolveCapability config 覆盖', () => {
  it('override 命中表条目：只覆盖显式维度，其余沿用表', () => {
    const overrides: CapabilityOverride[] = [
      { channel: 'stepfun', modelPrefix: 'step-3', capability: { image_in: false } },
    ];
    const cap = resolveCapability('stepfun', 'step-3.7-flash', overrides);
    expect(cap.source).toBe('override');
    expect(cap.image_in).toBe(false);
    expect(cap.cache_control).toBe(false);
    expect(cap.reasoning).toBe(true);
  });

  it('override 命中 UNKNOWN 基底：未覆盖维度保持全 false', () => {
    const overrides: CapabilityOverride[] = [
      {
        channel: 'acme',
        modelPrefix: 'acme-pro',
        capability: { tool_use: true, max_context_tokens: 128000 },
      },
    ];
    const cap = resolveCapability('acme', 'acme-pro-2', overrides);
    expect(cap.source).toBe('override');
    expect(cap.tool_use).toBe(true);
    expect(cap.max_context_tokens).toBe(128000);
    expect(cap.image_in).toBe(false);
  });

  it('override 之间取最长前缀命中', () => {
    const overrides: CapabilityOverride[] = [
      { channel: 'acme', modelPrefix: 'acme', capability: { image_in: false } },
      { channel: 'acme', modelPrefix: 'acme-vision', capability: { image_in: true } },
    ];
    const cap = resolveCapability('acme', 'acme-vision-2', overrides);
    expect(cap.image_in).toBe(true);
  });

  it('override 的 channel 不匹配时不生效', () => {
    const overrides: CapabilityOverride[] = [
      { channel: 'other', modelPrefix: 'step-3', capability: { image_in: false } },
    ];
    const cap = resolveCapability('stepfun', 'step-3.7-flash', overrides);
    expect(cap.source).toBe('table');
    expect(cap.image_in).toBe(true);
  });
});
