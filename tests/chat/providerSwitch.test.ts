import { describe, expect, it } from 'vitest';
import type { StepCodeConfig } from '../../src/config/config.js';
import { firstAliasOf, resolveProviderTarget } from '../../src/chat/providerSwitch.js';

/** 最小可用的 StepCodeConfig 夹具（解析只读 providers/models 两表）。 */
function cfg(overrides: Partial<StepCodeConfig> = {}): StepCodeConfig {
  return { provider: 'stepfun', ...overrides } as StepCodeConfig;
}

describe('firstAliasOf', () => {
  it('返回该渠道按配置文件顺序的第一个别名；无别名返回 undefined', () => {
    const c = cfg({
      models: {
        'm-a': { provider: 'gw' },
        'm-b': { provider: 'other' },
        'm-c': { provider: 'gw' },
      },
    });
    expect(firstAliasOf(c, 'gw')).toBe('m-a');
    expect(firstAliasOf(c, 'other')).toBe('m-b');
    expect(firstAliasOf(c, 'none')).toBeUndefined();
  });
});

describe('resolveProviderTarget（/provider <id> 三分支）', () => {
  it('命中自定义渠道且有别名 → alias（首个别名）', () => {
    const c = cfg({
      providers: { gw: { type: 'openai' } },
      models: { 'm-1': { provider: 'gw' }, 'm-2': { provider: 'gw' } },
    });
    expect(resolveProviderTarget(c, 'gw')).toEqual({ kind: 'alias', providerId: 'gw', alias: 'm-1' });
  });

  it('命中自定义渠道但无别名 → noAlias', () => {
    const c = cfg({ providers: { gw: { type: 'openai' } } });
    expect(resolveProviderTarget(c, 'gw')).toEqual({ kind: 'noAlias', providerId: 'gw' });
  });

  it('自定义渠道 id 与预设同名时自定义优先（遮蔽预设）', () => {
    const c = cfg({
      providers: { openai: { type: 'openai' } },
      models: { 'my-openai': { provider: 'openai' } },
    });
    expect(resolveProviderTarget(c, 'openai')).toEqual({ kind: 'alias', providerId: 'openai', alias: 'my-openai' });
  });

  it('命中内置预设名 → preset（大小写归一）', () => {
    expect(resolveProviderTarget(cfg(), 'anthropic')).toEqual({ kind: 'preset', name: 'anthropic' });
    expect(resolveProviderTarget(cfg(), 'OpenAI')).toEqual({ kind: 'preset', name: 'openai' });
  });

  it('都不命中 → unknown，可用清单 = 自定义渠道 + 未被遮蔽的预设', () => {
    const c = cfg({ providers: { gw: { type: 'openai' }, openai: { type: 'openai' } } });
    const target = resolveProviderTarget(c, 'nope');
    expect(target.kind).toBe('unknown');
    if (target.kind === 'unknown') {
      expect(target.available).toEqual(['gw', 'openai', 'stepfun', 'anthropic', 'openai_responses']);
    }
  });
});
