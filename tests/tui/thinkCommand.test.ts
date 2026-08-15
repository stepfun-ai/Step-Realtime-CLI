import { describe, expect, it } from 'vitest';
import { DEFAULT_THINKING_LEVELS, type ThinkingConfig } from '../../src/config/config.js';
import {
  parseThinkArgs,
  thinkBudgetSafety,
  thinkLevelsOf,
  thinkStatusLabel,
  thinkStreamParam,
  thinkingAvailable,
} from '../../src/chat/thinkCommand.js';

const LEVELS = { low: 1024, medium: 4096, high: 32000 };

describe('parseThinkArgs', () => {
  it('空参 → show', () => {
    expect(parseThinkArgs('', LEVELS)).toEqual({ kind: 'show' });
    expect(parseThinkArgs('   ', LEVELS)).toEqual({ kind: 'show' });
  });

  it('off → 会话级关闭', () => {
    expect(parseThinkArgs('off', LEVELS)).toEqual({ kind: 'set', override: 'off' });
    expect(parseThinkArgs(' off ', LEVELS)).toEqual({ kind: 'set', override: 'off' });
  });

  it('命中档位名 → 切换该档', () => {
    expect(parseThinkArgs('high', LEVELS)).toEqual({ kind: 'set', override: 'high' });
  });

  it('未知档位 → invalid 并带回原样档位名（含大小写敏感）', () => {
    expect(parseThinkArgs('ultra', LEVELS)).toEqual({ kind: 'invalid', name: 'ultra' });
    expect(parseThinkArgs('High', LEVELS)).toEqual({ kind: 'invalid', name: 'High' });
    expect(parseThinkArgs('OFF', LEVELS)).toEqual({ kind: 'invalid', name: 'OFF' });
  });
});

describe('thinkStreamParam', () => {
  it('undefined → undefined（provider 用构造默认）', () => {
    expect(thinkStreamParam(undefined, LEVELS)).toBeUndefined();
  });

  it('off → null（本次抑制 thinking 字段）', () => {
    expect(thinkStreamParam('off', LEVELS)).toBeNull();
  });

  it('档位名 → 同时带 level 与 budget 的对象覆盖', () => {
    // 必须带 level：阶跃三协议只认档位字符串。曾经只返回 budgetTokens，
    // 让 provider 反推档位，反推阈值硬编码，改 levels 数字就会静默错档。
    expect(thinkStreamParam('high', LEVELS)).toEqual({ level: 'high', budgetTokens: 32000 });
  });

  it('档位名不在表内 → undefined（防御，不发明知非法的覆盖）', () => {
    expect(thinkStreamParam('ghost', LEVELS)).toBeUndefined();
  });
});

describe('thinkStatusLabel', () => {
  it('off 覆盖 → off；档位覆盖 → 档位名', () => {
    expect(thinkStatusLabel('off', { enabled: true, levels: LEVELS })).toBe('off');
    expect(thinkStatusLabel('high', { enabled: false, levels: LEVELS })).toBe('high');
  });

  it('无覆盖：启用且配了 default_level → 档位名；否则不显示', () => {
    expect(thinkStatusLabel(undefined, { enabled: true, levels: LEVELS, defaultLevel: 'medium' })).toBe('medium');
    // 未启用时构造默认不带 thinking 参数，展示 default_level 是撒谎
    expect(thinkStatusLabel(undefined, { enabled: false, levels: LEVELS, defaultLevel: 'medium' })).toBeUndefined();
    expect(thinkStatusLabel(undefined, { enabled: true, levels: LEVELS })).toBeUndefined();
    expect(thinkStatusLabel(undefined, undefined)).toBeUndefined();
  });
});

describe('thinkingAvailable 门控', () => {
  const enabled: ThinkingConfig = { enabled: true, levels: LEVELS };
  const disabled: ThinkingConfig = { enabled: false, levels: LEVELS };

  it('anthropic 预设：sendThinking 恒 true，未配 [thinking] 也可用（会话级开启）', () => {
    expect(thinkingAvailable('anthropic', undefined)).toBe(true);
    expect(thinkingAvailable('anthropic', disabled)).toBe(true);
  });

  it('stepfun 预设：仅当 [thinking] enabled=true 时可用', () => {
    expect(thinkingAvailable('stepfun', enabled)).toBe(true);
    expect(thinkingAvailable('stepfun', disabled)).toBe(false);
    expect(thinkingAvailable('stepfun', undefined)).toBe(false);
  });

  it('openai 系协议：[thinking] enabled 时同样可用（三接口都有思考强度参数）', () => {
    // 旧断言是 false，理由写着「协议无 thinking 字段」——该前提被官方文档推翻：
    // Chat Completions 用 reasoning_effort，Responses 用 reasoning.effort，
    // Messages 用 output_config.effort。三条路径 provider 工厂都在下发，UI 不该拦。
    expect(thinkingAvailable('openai', enabled)).toBe(true);
    expect(thinkingAvailable('openai_responses', enabled)).toBe(true);
  });

  it('openai 系协议：未启用 [thinking] 时仍不可用（预设 sendThinking=false）', () => {
    expect(thinkingAvailable('openai', disabled)).toBe(false);
    expect(thinkingAvailable('openai_responses', undefined)).toBe(false);
  });

  it('未知渠道 → 不可用', () => {
    expect(thinkingAvailable('ghost', enabled)).toBe(false);
  });
});

describe('thinkLevelsOf', () => {
  it('config 缺省/缺 levels → 内置默认表；有 levels → 原样返回', () => {
    expect(thinkLevelsOf(undefined)).toEqual(DEFAULT_THINKING_LEVELS);
    expect(thinkLevelsOf({ enabled: false, levels: { low: 2048, medium: 4096, high: 8192 }, defaultLevel: 'medium' })).toEqual({ low: 2048, medium: 4096, high: 8192 });
  });
});

describe('thinkBudgetSafety（运行时切档余量防线）', () => {
  it('off / undefined（无 budget）→ 恒安全', () => {
    expect(thinkBudgetSafety(undefined, LEVELS, 32768)).toEqual({ safe: true, deficit: 0, budget: 0 });
    expect(thinkBudgetSafety('off', LEVELS, 32768)).toEqual({ safe: true, deficit: 0, budget: 0 });
  });

  it('余量充足 → safe（默认新基准 65536 下 high 档安全）', () => {
    // 65536 - 32000 = 33536 ≫ 2048
    expect(thinkBudgetSafety('high', LEVELS, 65536)).toEqual({ safe: true, deficit: 0, budget: 32000 });
  });

  it('余量不足 → unsafe 并给出欠缺量（旧默认 32768 下 high 档危险）', () => {
    // 32768 - 32000 = 768 < 2048，欠 2048 - 768 = 1280
    expect(thinkBudgetSafety('high', LEVELS, 32768)).toEqual({ safe: false, deficit: 1280, budget: 32000 });
  });

  it('边界：余量恰好等于最小余量 → safe', () => {
    // margin === THINKING_TEXT_MARGIN(2048) 时 safe（≥ 判定）
    expect(thinkBudgetSafety('low', { low: 4096, medium: 8192, high: 16384 }, 6144)).toEqual({ safe: true, deficit: 0, budget: 4096 });
  });

  it('档位名不在表内 → 回落无 budget、恒安全（与 thinkStreamParam 防御一致）', () => {
    expect(thinkBudgetSafety('ghost', LEVELS, 100)).toEqual({ safe: true, deficit: 0, budget: 0 });
  });
});
