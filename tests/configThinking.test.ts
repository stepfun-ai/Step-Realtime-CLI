import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THINKING_LEVEL,
  DEFAULT_THINKING_LEVELS,
  isThinkingLevelName,
  resolveThinkingConfig,
  THINKING_LEVEL_NAMES,
} from '../src/config/config.js';

const DEFAULT_LEVELS = { low: 1024, medium: 4096, high: 32000 };

describe('resolveThinkingConfig 基础形态', () => {
  it('缺省 → enabled=false，defaultLevel 落 medium，levels 落内置默认表', () => {
    const expected = { enabled: false, levels: DEFAULT_LEVELS, defaultLevel: 'medium' };
    expect(resolveThinkingConfig(undefined, 32768)).toEqual(expected);
    expect(resolveThinkingConfig('not-object', 32768)).toEqual(expected);
    expect(resolveThinkingConfig({}, 32768)).toEqual(expected);
  });

  it('defaultLevel 恒有值——不留 undefined', () => {
    // 这是本轮改造的核心约束：留空等于不发 effort，而实测「不发 effort = 跑最高思考量」，
    // 会让思考吃满 max_tokens 导致正文零输出（空响应 bug 的成因之一）。
    for (const raw of [undefined, {}, { enabled: true }, { levels: { low: 2048 } }]) {
      expect(resolveThinkingConfig(raw, 65536).defaultLevel).toBe('medium');
    }
  });

  it('enabled 非布尔按 false；仅 true 启用', () => {
    expect(resolveThinkingConfig({ enabled: 'yes' }, 32768).enabled).toBe(false);
    expect(resolveThinkingConfig({ enabled: 1 }, 32768).enabled).toBe(false);
    expect(resolveThinkingConfig({ enabled: true }, 32768).enabled).toBe(true);
  });
});

describe('resolveThinkingConfig 拒绝已删除的 budget_tokens', () => {
  it('出现 budget_tokens → 抛错，不做折算兼容', () => {
    // 用户明确要求「从零开发逻辑，不用兼容」：静默折算会让用户以为自己填的数字生效了。
    expect(() => resolveThinkingConfig({ budget_tokens: 4096 }, 32768)).toThrow(
      /budget_tokens 已移除/,
    );
  });

  it('报错信息给出替代写法与原因', () => {
    expect(() => resolveThinkingConfig({ budget_tokens: 4096 }, 32768)).toThrow(
      /default_level = "low" \| "medium" \| "high"/,
    );
    expect(() => resolveThinkingConfig({ budget_tokens: 4096 }, 32768)).toThrow(
      /对阶跃渠道从不发出/,
    );
  });

  it('非法类型的 budget_tokens 同样报错（只看键存不存在）', () => {
    expect(() => resolveThinkingConfig({ budget_tokens: 'x' }, 32768)).toThrow(/budget_tokens 已移除/);
    expect(() => resolveThinkingConfig({ budget_tokens: null }, 32768)).toThrow(/budget_tokens 已移除/);
  });
});

describe('resolveThinkingConfig default_level', () => {
  it('三个合法档位都能配', () => {
    for (const level of THINKING_LEVEL_NAMES) {
      expect(resolveThinkingConfig({ default_level: level }, 65536).defaultLevel).toBe(level);
    }
  });

  it('非法档位名 → 抛错并列出可用档位', () => {
    expect(() => resolveThinkingConfig({ default_level: 'ultra' }, 32768)).toThrow(
      /default_level="ultra" 不是合法档位/,
    );
    expect(() => resolveThinkingConfig({ default_level: 'ultra' }, 32768)).toThrow(
      /low \| medium \| high/,
    );
  });

  it('自定义档位名不再被接受（曾经可以，现在档位名要直接作 effort 值）', () => {
    expect(() =>
      resolveThinkingConfig({ levels: { deep: 8192 }, default_level: 'deep' }, 32768),
    ).toThrow(/不认识档位名 "deep"/);
  });

  it('非法类型按未配置处理 → 回落 medium', () => {
    expect(resolveThinkingConfig({ default_level: 42 }, 32768).defaultLevel).toBe('medium');
  });
});

describe('resolveThinkingConfig levels 档位表', () => {
  it('逐档合并进内置表：未配的档位保留内置值', () => {
    // 语义变更：旧行为是「整体覆盖」（配一档就丢掉其余两档），
    // 新行为是「逐档合并」——档位名固定三个，缺档补内置值，避免出现残缺档位表。
    expect(resolveThinkingConfig({ levels: { low: 2048 } }, 65536).levels).toEqual({
      low: 2048,
      medium: 4096,
      high: 32000,
    });
  });

  it('档位值取整并 clamp 到 ≥1024', () => {
    expect(resolveThinkingConfig({ levels: { low: 100, medium: 4096.6 } }, 65536).levels).toEqual({
      low: 1024,
      medium: 4097,
      high: 32000,
    });
  });

  it('未知档位名 → 抛错，不静默忽略', () => {
    // 静默忽略会让用户以为自定义档位生效了，而实际请求里根本没有它。
    expect(() => resolveThinkingConfig({ levels: { deep: 16384 } }, 32768)).toThrow(
      /不认识档位名 "deep"/,
    );
    expect(() => resolveThinkingConfig({ levels: { deep: 16384 } }, 32768)).toThrow(
      /只支持：low \| medium \| high/,
    );
  });

  it('档位值非法 → 跳过该档保留内置值（不报错）', () => {
    expect(resolveThinkingConfig({ levels: { low: 'x', medium: Number.NaN } }, 65536).levels).toEqual(
      DEFAULT_LEVELS,
    );
  });

  it('levels 非对象 → 回落内置默认表', () => {
    expect(resolveThinkingConfig({ levels: 'nope' }, 32768).levels).toEqual(DEFAULT_LEVELS);
    expect(resolveThinkingConfig({ levels: [1024] }, 32768).levels).toEqual(DEFAULT_LEVELS);
    expect(resolveThinkingConfig({ levels: {} }, 32768).levels).toEqual(DEFAULT_LEVELS);
  });

  it('内置默认表与导出常量一致（防漂移）', () => {
    expect(DEFAULT_THINKING_LEVELS).toEqual(DEFAULT_LEVELS);
    expect(DEFAULT_THINKING_LEVEL).toBe('medium');
  });
});

describe('resolveThinkingConfig 余量校验（仅显式配置的 levels）', () => {
  it('启用时显式配的档位超余量 → 抛错并指名档位', () => {
    expect(() =>
      resolveThinkingConfig({ enabled: true, levels: { high: 31000 } }, 32768),
    ).toThrow(/档位 high=31000 未给正文留出最小余量/);
  });

  it('报错信息说明该数字只在原生 Anthropic 渠道生效', () => {
    // 避免误导：阶跃渠道根本不收这个数字，报错必须交代清楚作用范围。
    expect(() =>
      resolveThinkingConfig({ enabled: true, levels: { high: 31000 } }, 32768),
    ).toThrow(/原生 Anthropic 渠道/);
  });

  it('余量恰好 2048 → 通过（边界含等号）', () => {
    expect(
      resolveThinkingConfig({ enabled: true, levels: { high: 30720 } }, 32768).levels.high,
    ).toBe(30720);
  });

  it('未启用时不校验（不启用就不发字段）', () => {
    expect(resolveThinkingConfig({ enabled: false, levels: { high: 99999 } }, 32768).levels.high).toBe(
      99999,
    );
  });

  it('内置默认表不校验（兜底数据，且该数字对阶跃渠道不发出）', () => {
    // 默认表 high=32000 对 maxTokens=4096 必然超余量，但不能让「只写 enabled=true」的
    // 配置因为一个不会发出的数字而启动失败。
    expect(resolveThinkingConfig({ enabled: true }, 4096).levels).toEqual(DEFAULT_LEVELS);
  });
});

describe('isThinkingLevelName', () => {
  it('三档为真，其余为假', () => {
    expect(isThinkingLevelName('low')).toBe(true);
    expect(isThinkingLevelName('medium')).toBe(true);
    expect(isThinkingLevelName('high')).toBe(true);
    expect(isThinkingLevelName('High')).toBe(false);
    expect(isThinkingLevelName('off')).toBe(false);
    expect(isThinkingLevelName('deep')).toBe(false);
    expect(isThinkingLevelName(undefined)).toBe(false);
    expect(isThinkingLevelName(4096)).toBe(false);
  });
});
