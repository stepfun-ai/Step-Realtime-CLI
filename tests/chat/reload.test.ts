import { describe, expect, it } from 'vitest';
import type { StepCodeConfig } from '../../src/config/config.js';
import { diffConfig, formatConfigChange, planProviderReload, resolveCapabilitiesOnReload } from '../../src/chat/reload.js';

/** 构造一个最小合法配置（默认值对齐 config.ts 内置默认），用 overrides 覆盖差异字段。 */
function makeCfg(overrides: Partial<StepCodeConfig> = {}): StepCodeConfig {
  return {
    provider: 'stepfun',
    apiKey: 'k-top',
    baseUrl: 'https://api.stepfun.com',
    model: 'step-3.7-flash',
    maxContextSize: 262_144,
    maxTokens: 65_536,
    subagent: { maxDepth: 1, maxSteps: 100, maxConcurrent: 4, retention: { deleteWithParent: true, maxSessions: 0, ttlDays: 0 } },
    compaction: { triggerRatio: 0.85, reservedTokens: 32_000 },
    thinking: { enabled: false, levels: { low: 1024, medium: 4096, high: 32_000 } },
    ...overrides,
  };
}

describe('diffConfig', () => {
  it('无变化返回空数组', () => {
    expect(diffConfig(makeCfg(), makeCfg())).toEqual([]);
  });

  it('顶层标量变更：max_context_size 带旧值 → 新值', () => {
    const changes = diffConfig(makeCfg(), makeCfg({ maxContextSize: 131_072 }));
    expect(changes).toEqual([
      { kind: 'changed', path: 'max_context_size', oldText: '262144', newText: '131072', restart: undefined },
    ]);
  });

  it('api_key 变更只报路径不回显内容（masked）', () => {
    const changes = diffConfig(makeCfg(), makeCfg({ apiKey: 'k-rotated' }));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'changed', path: 'api_key' });
    expect(changes[0]!.oldText).toBeUndefined();
    expect(changes[0]!.newText).toBeUndefined();
  });

  it('[models] 表项：新增 / 移除 / 变更逐键列出', () => {
    const oldCfg = makeCfg({ models: { big: { model: 'test-model-x' }, gone: {} } });
    const newCfg = makeCfg({ models: { big: { model: 'test-model-y' }, foo: {} } });
    const changes = diffConfig(oldCfg, newCfg);
    expect(changes).toEqual([
      { kind: 'removed', path: 'models.gone', oldText: undefined, newText: undefined, restart: undefined },
      { kind: 'changed', path: 'models.big', oldText: undefined, newText: undefined, restart: undefined },
      { kind: 'added', path: 'models.foo', oldText: undefined, newText: undefined, restart: undefined },
    ]);
  });

  it('[providers] 表项：新增逐键列出', () => {
    const changes = diffConfig(makeCfg(), makeCfg({ providers: { my: { type: 'openai' } } }));
    expect(changes).toEqual([
      { kind: 'added', path: 'providers.my', oldText: undefined, newText: undefined, restart: undefined },
    ]);
  });

  it('[providers] 表项内字段变更（含 api_key_env）→ 整项 changed，不回显内容', () => {
    const oldCfg = makeCfg({ providers: { gw: { type: 'openai' } } });
    const newCfg = makeCfg({ providers: { gw: { type: 'openai', apiKeyEnv: 'GW_KEY' } } });
    const changes = diffConfig(oldCfg, newCfg);
    expect(changes).toEqual([
      { kind: 'changed', path: 'providers.gw', oldText: undefined, newText: undefined, restart: undefined },
    ]);
  });

  it('[thinking] 段内字段：default_level / levels 档位逐档列出', () => {
    const oldCfg = makeCfg({
      thinking: { enabled: false, levels: { low: 1024, medium: 4096, high: 32_000 }, defaultLevel: 'medium' },
    });
    const newCfg = makeCfg({
      thinking: { enabled: true, levels: { low: 1024, medium: 4096, high: 16_000, extreme: 64_000 }, defaultLevel: 'high' },
    });
    const changes = diffConfig(oldCfg, newCfg);
    expect(changes).toEqual([
      { kind: 'changed', path: 'thinking.enabled', oldText: 'false', newText: 'true', restart: undefined },
      { kind: 'changed', path: 'thinking.default_level', oldText: 'medium', newText: 'high', restart: undefined },
      { kind: 'changed', path: 'thinking.levels.high', oldText: '32000', newText: '16000', restart: undefined },
      { kind: 'added', path: 'thinking.levels.extreme', oldText: undefined, newText: '64000', restart: undefined },
    ]);
  });

  it('[compaction] 段内字段变更', () => {
    const oldCfg = makeCfg();
    const newCfg = makeCfg({ compaction: { triggerRatio: 0.9, reservedTokens: 16_000, model: 'small-model' } });
    const changes = diffConfig(oldCfg, newCfg);
    expect(changes).toEqual([
      { kind: 'changed', path: 'compaction.trigger_ratio', oldText: '0.85', newText: '0.9', restart: undefined },
      { kind: 'changed', path: 'compaction.reserved_tokens', oldText: '32000', newText: '16000', restart: undefined },
      { kind: 'added', path: 'compaction.model', oldText: undefined, newText: 'small-model', restart: undefined },
    ]);
  });

  it('一次性固化字段标 restart（需重启生效）', () => {
    const oldCfg = makeCfg();
    const newCfg = makeCfg({
      agentsMdMaxBytes: 65_536,
      background: { bashTaskTimeoutS: 1200 },
    });
    const changes = diffConfig(oldCfg, newCfg);
    expect(changes).toEqual([
      { kind: 'added', path: 'agents_md_max_bytes', oldText: undefined, newText: '65536', restart: true },
      { kind: 'added', path: 'background.bash_task_timeout_s', oldText: undefined, newText: '1200', restart: true },
    ]);
  });

  it('hooks 按条数变化列出', () => {
    const oldCfg = makeCfg();
    const newCfg = makeCfg({ hooks: [{ event: 'Stop', command: 'echo hi', timeout: 30 }] });
    const changes = diffConfig(oldCfg, newCfg);
    expect(changes).toEqual([
      { kind: 'changed', path: 'hooks', oldText: '0', newText: '1', restart: undefined },
    ]);
  });

  it('subagent.retention 三字段变更被列出', () => {
    const oldCfg = makeCfg();
    const newCfg = makeCfg({
      subagent: {
        maxDepth: 1,
        maxSteps: 100,
        maxConcurrent: 4,
        retention: { deleteWithParent: false, maxSessions: 200, ttlDays: 30 },
      },
    });
    const changes = diffConfig(oldCfg, newCfg);
    const paths = changes.map((c) => c.path);
    expect(paths).toContain('subagent.retention.delete_with_parent');
    expect(paths).toContain('subagent.retention.max_sessions');
    expect(paths).toContain('subagent.retention.ttl_days');
  });
});

describe('formatConfigChange', () => {
  it('展示格式：+ / - / ~ 三态', () => {
    expect(formatConfigChange({ kind: 'changed', path: 'max_context_size', oldText: '262144', newText: '131072' })).toBe(
      '~ max_context_size: 262144 → 131072',
    );
    expect(formatConfigChange({ kind: 'added', path: 'models.foo' })).toBe('+ models.foo');
    expect(formatConfigChange({ kind: 'removed', path: 'models.foo' })).toBe('- models.foo');
    expect(formatConfigChange({ kind: 'added', path: 'thinking.levels.extreme', newText: '64000' })).toBe(
      '+ thinking.levels.extreme: 64000',
    );
    expect(formatConfigChange({ kind: 'changed', path: 'api_key' })).toBe('~ api_key');
  });
});

describe('planProviderReload', () => {
  const aliasCfg = (apiKey: string): StepCodeConfig =>
    makeCfg({
      models: { big: { model: 'test-model-x', apiKey, maxContextSize: 1_048_576 } },
    });

  it('别名仍在且配置有变化 → rebuild（新 resolved 配置）', () => {
    const plan = planProviderReload(aliasCfg('k-old'), aliasCfg('k-new'), 'test-model-x', 'big');
    expect(plan.kind).toBe('rebuild');
    if (plan.kind !== 'rebuild') return;
    expect(plan.model).toBe('test-model-x');
    expect(plan.maxContextSize).toBe(1_048_576);
    expect(plan.providerName).toBe('stepfun');
    expect(plan.modelLabel).toBe('test-model-x');
    expect(plan.provider.maxTokens).toBe(65_536);
  });

  it('别名仍在但 provider 构造输入一致 → keep/unchanged（恒等重建跳过）', () => {
    const cfg = aliasCfg('k-entry');
    const plan = planProviderReload(cfg, aliasCfg('k-entry'), 'test-model-x', 'big');
    expect(plan).toEqual({ kind: 'keep', reason: 'unchanged', alias: undefined, message: undefined });
  });

  it('别名在新配置中被删 → keep/aliasRemoved（沿用旧 provider，不回落顶层）', () => {
    const plan = planProviderReload(aliasCfg('k-entry'), makeCfg(), 'test-model-x', 'big');
    expect(plan).toEqual({ kind: 'keep', reason: 'aliasRemoved', alias: 'big', message: undefined });
  });

  it('别名的 provider 指向无效渠道 → resolveModelEntry 返回 null → keep/aliasInvalid', () => {
    const oldCfg = aliasCfg('k-entry');
    const newCfg = makeCfg({ models: { big: { model: 'test-model-x', provider: 'no-such-channel' } } });
    const plan = planProviderReload(oldCfg, newCfg, 'test-model-x', 'big');
    expect(plan).toEqual({ kind: 'keep', reason: 'aliasInvalid', alias: 'big', message: undefined });
  });

  it('别名路径的 modelLabel 取 displayName', () => {
    const oldCfg = makeCfg({ models: { big: { model: 'test-model-x', apiKey: 'k-old' } } });
    const newCfg = makeCfg({
      models: { big: { model: 'test-model-x', apiKey: 'k-new', displayName: '大模型' } },
    });
    const plan = planProviderReload(oldCfg, newCfg, 'test-model-x', 'big');
    expect(plan.kind).toBe('rebuild');
    if (plan.kind !== 'rebuild') return;
    expect(plan.modelLabel).toBe('大模型');
  });

  it('裸 id：顶层 api_key 变化 → 按新顶层 rebuild，模型保持当前 id', () => {
    const plan = planProviderReload(makeCfg(), makeCfg({ apiKey: 'k-rotated' }), 'step-3.7-flash', null);
    expect(plan.kind).toBe('rebuild');
    if (plan.kind !== 'rebuild') return;
    expect(plan.model).toBe('step-3.7-flash');
    expect(plan.maxContextSize).toBe(262_144);
    expect(plan.providerName).toBe('stepfun');
  });

  it('裸 id：无变化 → keep/unchanged', () => {
    const plan = planProviderReload(makeCfg(), makeCfg(), 'step-3.7-flash', null);
    expect(plan.kind).toBe('keep');
    if (plan.kind !== 'keep') return;
    expect(plan.reason).toBe('unchanged');
  });

  it('裸 id：新顶层 provider type 非法 → createProvider 抛错 → keep/buildFailed', () => {
    const plan = planProviderReload(makeCfg(), makeCfg({ provider: 'bogus-type' }), 'step-3.7-flash', null);
    expect(plan.kind).toBe('keep');
    if (plan.kind !== 'keep') return;
    expect(plan.reason).toBe('buildFailed');
    expect(plan.message).toBeTypeOf('string');
  });
});

describe('resolveCapabilitiesOnReload', () => {
  it('别名声明了 capabilities → 返回新配置的声明（reload 后即时生效）', () => {
    const cfg = makeCfg({ models: { big: { model: 'test-model-x', capabilities: ['image_in', 'thinking'] } } });
    expect(resolveCapabilitiesOnReload(cfg, 'big')).toEqual(['image_in', 'thinking']);
  });

  it('别名未声明 capabilities → undefined（与别名解析口径一致）', () => {
    const cfg = makeCfg({ models: { big: { model: 'test-model-x' } } });
    expect(resolveCapabilitiesOnReload(cfg, 'big')).toBeUndefined();
  });

  it('别名在新配置中不存在 → undefined（不报错）', () => {
    expect(resolveCapabilitiesOnReload(makeCfg(), 'big')).toBeUndefined();
  });

  it('裸模型（无别名绑定）→ undefined', () => {
    const cfg = makeCfg({ models: { big: { model: 'test-model-x', capabilities: ['image_in'] } } });
    expect(resolveCapabilitiesOnReload(cfg, null)).toBeUndefined();
  });
});
