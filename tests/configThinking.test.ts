import { describe, expect, it } from 'vitest';
import { DEFAULT_THINKING_LEVELS, resolveThinkingConfig } from '../src/config/config.js';

const DEFAULT_LEVELS = { low: 1024, medium: 4096, high: 32000 };

describe('resolveThinkingConfig', () => {
  it('缺省 → enabled=false，budget 键不进结果对象，levels 落内置默认表', () => {
    expect(resolveThinkingConfig(undefined, 32768)).toEqual({ enabled: false, levels: DEFAULT_LEVELS });
    expect(resolveThinkingConfig('not-object', 32768)).toEqual({ enabled: false, levels: DEFAULT_LEVELS });
    expect(resolveThinkingConfig({}, 32768)).toEqual({ enabled: false, levels: DEFAULT_LEVELS });
  });

  it('enabled 非布尔按 false；仅 true 启用', () => {
    expect(resolveThinkingConfig({ enabled: 'yes' }, 32768)).toEqual({ enabled: false, levels: DEFAULT_LEVELS });
    expect(resolveThinkingConfig({ enabled: 1 }, 32768)).toEqual({ enabled: false, levels: DEFAULT_LEVELS });
    expect(resolveThinkingConfig({ enabled: true }, 32768)).toEqual({ enabled: true, levels: DEFAULT_LEVELS });
  });

  it('budget_tokens 取整并 clamp 到 ≥1024', () => {
    expect(resolveThinkingConfig({ budget_tokens: 8192.6 }, 32768)).toEqual({
      enabled: false,
      budgetTokens: 8193,
      levels: DEFAULT_LEVELS,
    });
    expect(resolveThinkingConfig({ budget_tokens: 100 }, 32768)).toEqual({
      enabled: false,
      budgetTokens: 1024,
      levels: DEFAULT_LEVELS,
    });
    expect(resolveThinkingConfig({ enabled: true, budget_tokens: -5 }, 32768)).toEqual({
      enabled: true,
      budgetTokens: 1024,
      levels: DEFAULT_LEVELS,
    });
  });

  it('budget_tokens 非法值不进结果对象', () => {
    expect(resolveThinkingConfig({ enabled: true, budget_tokens: 'x' }, 32768)).toEqual({
      enabled: true,
      levels: DEFAULT_LEVELS,
    });
    expect(resolveThinkingConfig({ budget_tokens: Number.NaN }, 32768)).toEqual({
      enabled: false,
      levels: DEFAULT_LEVELS,
    });
  });

  it('启用且未配 budget：合法（请求只带 {type:enabled}），不做余量校验', () => {
    expect(resolveThinkingConfig({ enabled: true }, 4096)).toEqual({ enabled: true, levels: DEFAULT_LEVELS });
  });

  it('启用时 max_tokens - budget < 2048 → 抛配置错误并给出调整方向', () => {
    expect(() =>
      resolveThinkingConfig({ enabled: true, budget_tokens: 8192 }, 10000),
    ).toThrow(/max_tokens.*budget_tokens|调大 max_tokens 或调小 budget_tokens/);
    expect(() =>
      resolveThinkingConfig({ enabled: true, budget_tokens: 8192 }, 10000),
    ).toThrow(/调大 max_tokens 或调小 budget_tokens/);
  });

  it('余量恰好 2048 → 通过（边界含等号）', () => {
    expect(resolveThinkingConfig({ enabled: true, budget_tokens: 8192 }, 10240)).toEqual({
      enabled: true,
      budgetTokens: 8192,
      levels: DEFAULT_LEVELS,
    });
  });

  it('未启用时 budget 超余量也不校验（不启用就不发字段）', () => {
    expect(resolveThinkingConfig({ enabled: false, budget_tokens: 30000 }, 32768)).toEqual({
      enabled: false,
      budgetTokens: 30000,
      levels: DEFAULT_LEVELS,
    });
  });
});

describe('resolveThinkingConfig levels 档位表', () => {
  it('自定义 levels 原样解析（覆盖内置默认表）', () => {
    expect(resolveThinkingConfig({ levels: { low: 2048, deep: 16384 } }, 32768)).toEqual({
      enabled: false,
      levels: { low: 2048, deep: 16384 },
    });
  });

  it('levels 档位值取整并 clamp 到 ≥1024；非法档位跳过', () => {
    expect(
      resolveThinkingConfig({ levels: { tiny: 100, ok: 4096.6, bad: 'x', nan: Number.NaN } }, 32768),
    ).toEqual({
      enabled: false,
      levels: { tiny: 1024, ok: 4097 },
    });
  });

  it('levels 非对象或全部无效 → 回落内置默认表', () => {
    expect(resolveThinkingConfig({ levels: 'nope' }, 32768).levels).toEqual(DEFAULT_LEVELS);
    expect(resolveThinkingConfig({ levels: [1024] }, 32768).levels).toEqual(DEFAULT_LEVELS);
    expect(resolveThinkingConfig({ levels: {} }, 32768).levels).toEqual(DEFAULT_LEVELS);
    expect(resolveThinkingConfig({ levels: { bad: 'x' } }, 32768).levels).toEqual(DEFAULT_LEVELS);
  });

  it('内置默认表与导出的 DEFAULT_THINKING_LEVELS 一致（防漂移）', () => {
    expect(DEFAULT_THINKING_LEVELS).toEqual(DEFAULT_LEVELS);
  });

  it('启用时自定义档位套用正文余量校验：任一档超余量即抛配置错误并指名档位', () => {
    expect(() =>
      resolveThinkingConfig({ enabled: true, levels: { low: 1024, high: 31000 } }, 32768),
    ).toThrow(/档位 high=31000 未给正文留出最小余量/);
  });

  it('启用时自定义档位余量恰好 2048 → 通过（边界含等号）', () => {
    expect(
      resolveThinkingConfig({ enabled: true, levels: { low: 1024, high: 30720 } }, 32768).levels,
    ).toEqual({ low: 1024, high: 30720 });
  });

  it('未启用时自定义档位超余量不校验（不启用就不发字段）', () => {
    expect(resolveThinkingConfig({ enabled: false, levels: { high: 99999 } }, 32768).levels).toEqual({
      high: 99999,
    });
  });

  it('内置默认表不做余量校验（兜底数据；enabled 且小 max_tokens 不因默认表报错）', () => {
    // 默认表 high=32000 对 maxTokens=4096 必然超余量，但默认表不校验——
    // 运行时档位由 /think 显式选择，不应让「只写 enabled=true」的既有合法配置报错
    expect(resolveThinkingConfig({ enabled: true }, 4096).levels).toEqual(DEFAULT_LEVELS);
  });
});

describe('resolveThinkingConfig default_level', () => {
  it('命中档位表 → defaultLevel 进结果对象', () => {
    expect(resolveThinkingConfig({ default_level: 'medium' }, 32768)).toEqual({
      enabled: false,
      levels: DEFAULT_LEVELS,
      defaultLevel: 'medium',
    });
    expect(
      resolveThinkingConfig({ levels: { deep: 8192 }, default_level: 'deep' }, 32768),
    ).toEqual({
      enabled: false,
      levels: { deep: 8192 },
      defaultLevel: 'deep',
    });
  });

  it('引用不存在的档位名 → 抛配置错误并列出可用档位', () => {
    expect(() => resolveThinkingConfig({ default_level: 'ultra' }, 32768)).toThrow(
      /default_level="ultra" 未命中任何档位/,
    );
    expect(() =>
      resolveThinkingConfig({ levels: { deep: 8192 }, default_level: 'medium' }, 32768),
    ).toThrow(/可用：deep/);
  });

  it('default_level 非法类型按未配置处理（键不进结果对象）', () => {
    expect(resolveThinkingConfig({ default_level: 42 }, 32768)).toEqual({
      enabled: false,
      levels: DEFAULT_LEVELS,
    });
  });
});
