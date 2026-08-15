import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_KEYS,
  DEFAULT_CAPABILITY,
  capabilitiesToOverride,
  resolveCapability,
  type CapabilityOverride,
} from '../../src/provider/capability-registry.js';

describe('resolveCapability 默认兜底', () => {
  it('未登记的模型回落默认能力：图片/思考/工具默认支持，cache_control 默认不发', () => {
    const cap = resolveCapability('stepfun', 'step-3.7-flash');
    expect(cap.source).toBe('unknown');
    expect(cap.image_in).toBe(true);
    expect(cap.reasoning).toBe(true);
    expect(cap.tool_use).toBe(true);
    expect(cap.cache_control).toBe(false);
  });

  it('查不到的通道同样回落默认能力（不再是全 false）', () => {
    const cap = resolveCapability('no-such-channel', 'whatever-1');
    expect(cap.source).toBe('unknown');
    expect(cap).toMatchObject(DEFAULT_CAPABILITY);
  });

  it('回归：step-explore 不因名字不像 step-3 而丢掉图片能力', () => {
    // 旧实现按 modelPrefix='step-3' 前缀匹配，step-explore 不命中 → image_in:false
    // → degrader 把用户真实发出的图静默换成占位文本。此处固化修复后的行为。
    const cap = resolveCapability('stepfun', 'step-explore');
    expect(cap.image_in).toBe(true);
  });

  it('精确匹配：模型名相近但不相等不会互相串能力', () => {
    const overrides: CapabilityOverride[] = [
      { channel: 'acme', model: 'acme-pro', capability: { image_in: false } },
    ];
    // 'acme-pro-2' 不等于 'acme-pro'，旧的前缀实现会误命中
    const cap = resolveCapability('acme', 'acme-pro-2', overrides);
    expect(cap.source).toBe('unknown');
    expect(cap.image_in).toBe(true);
  });
});

describe('resolveCapability config 覆盖', () => {
  it('override 精确命中：只覆盖显式维度，其余沿用默认', () => {
    const overrides: CapabilityOverride[] = [
      { channel: 'stepfun', model: 'step-3.7-flash', capability: { image_in: false } },
    ];
    const cap = resolveCapability('stepfun', 'step-3.7-flash', overrides);
    expect(cap.source).toBe('override');
    expect(cap.image_in).toBe(false);
    expect(cap.reasoning).toBe(true);
    expect(cap.cache_control).toBe(false);
  });

  it('override 可显式开启 cache_control（默认关）', () => {
    const overrides: CapabilityOverride[] = [
      { channel: 'acme', model: 'acme-pro', capability: { cache_control: true } },
    ];
    const cap = resolveCapability('acme', 'acme-pro', overrides);
    expect(cap.cache_control).toBe(true);
  });

  it('override 的 channel 不匹配时不生效', () => {
    const overrides: CapabilityOverride[] = [
      { channel: 'other', model: 'step-3.7-flash', capability: { image_in: false } },
    ];
    const cap = resolveCapability('stepfun', 'step-3.7-flash', overrides);
    expect(cap.source).toBe('unknown');
    expect(cap.image_in).toBe(true);
  });
});

describe('capabilitiesToOverride', () => {
  it('undefined / 空数组不产生 override', () => {
    expect(capabilitiesToOverride('stepfun', 'm', undefined)).toBeUndefined();
    expect(capabilitiesToOverride('stepfun', 'm', [])).toBeUndefined();
  });

  it('声明语义是只增不减：只写进声明了的维度', () => {
    const ov = capabilitiesToOverride('stepfun', 'step-explore', ['image_in']);
    expect(ov).toEqual({
      channel: 'stepfun',
      model: 'step-explore',
      capability: { image_in: true },
    });
    // 未声明 tool_use，不写进片段 → 解析时沿用默认 true，而不是被压成 false
    const cap = resolveCapability('stepfun', 'step-explore', [ov!]);
    expect(cap.tool_use).toBe(true);
  });

  it('thinking 映射到内部字段 reasoning', () => {
    const ov = capabilitiesToOverride('stepfun', 'm', ['thinking']);
    expect(ov?.capability).toEqual({ reasoning: true });
  });

  it('大小写与空白被归一', () => {
    const ov = capabilitiesToOverride('stepfun', 'm', ['  IMAGE_IN  ']);
    expect(ov?.capability).toEqual({ image_in: true });
  });

  it('video_in 映射到请求整形（发送前投影视频块）；audio_in 仍不产生 override', () => {
    const ov = capabilitiesToOverride('stepfun', 'm', ['video_in', 'audio_in']);
    expect(ov?.capability).toEqual({ video_in: true });
    expect(capabilitiesToOverride('stepfun', 'm', ['audio_in'])).toBeUndefined();
  });

  it('video_in 默认 false（未声明时投影视频块为占位文本）', () => {
    expect(resolveCapability('openai', 'some-unknown-model').video_in).toBe(false);
  });

  it('"-" 前缀显式取负（2026-08-13 设计：端点只收纯文本时声明 -image_in）', () => {
    const ov = capabilitiesToOverride('openai', 'glm-x-preview-k', ['thinking', '-image_in']);
    expect(ov?.capability).toEqual({ reasoning: true, image_in: false });
    // 解析后 image_in 压住默认 true，其余维度不动
    const cap = resolveCapability('openai', 'glm-x-preview-k', [ov!]);
    expect(cap.image_in).toBe(false);
    expect(cap.tool_use).toBe(true);
    expect(cap.reasoning).toBe(true);
  });

  it('取负与正向同现时后写胜出', () => {
    const ov = capabilitiesToOverride('openai', 'm', ['-image_in', 'image_in']);
    expect(ov?.capability.image_in).toBe(true);
  });
});

describe('CAPABILITY_KEYS', () => {
  it('白名单覆盖配置侧允许的全部能力名', () => {
    expect([...CAPABILITY_KEYS]).toEqual([
      'image_in',
      'video_in',
      'audio_in',
      'thinking',
      'tool_use',
      'cache_control',
    ]);
  });
});

describe('resolveCapability 读取可观察性', () => {
  // 根因对照：旧实现 key 只取 channel，子 agent 别名的 capabilities 注入后仍被静态表/父 model 覆盖，
  // 导致 degrader 按父 model 能力剥图（独立洞二）。此处固化「别名能力声明可被 resolveCapability 读取」。
  it('子 agent 别名能力声明可精确命中（channel + model）', () => {
    const overrides: CapabilityOverride[] = [
      { channel: 'stepfun', model: 'explore', capability: { image_in: true } },
    ];
    const cap = resolveCapability('stepfun', 'explore', overrides);
    expect(cap.image_in).toBe(true);
    expect(cap.source).toBe('override');
  });

  it('未传入子代理别名时回落默认（不因未声明而误判不支持）', () => {
    const cap = resolveCapability('stepfun', 'unknown-model');
    expect(cap.image_in).toBe(true);
  });
});
