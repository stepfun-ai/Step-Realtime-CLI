import { DEFAULT_THINKING_LEVELS, PROVIDER_PRESETS, THINKING_TEXT_MARGIN, type ThinkingConfig } from '../config/config.js';

/**
 * /think 命令的纯函数层：参数解析、覆盖 → 请求参数投影、状态栏标签、门控判定。
 * 全部无副作用，便于单测；App 只负责把这些结果接到 state 与 pushItem 上。
 *
 * 会话级覆盖（ThinkOverride）三态：
 * - undefined：跟随 config 默认（default_level / budget_tokens / 仅 enabled）；
 * - 'off'：本会话不再发送 thinking 字段（请求级传 null 抑制）；
 * - 其余字符串：档位名，取 levels[档位] 作为 budget 覆盖。
 */
export type ThinkOverride = string;

/** /think 参数解析结果。 */
export type ThinkArgResult =
  | { kind: 'show' }
  | { kind: 'set'; override: ThinkOverride }
  | { kind: 'invalid'; name: string };

/**
 * 解析 /think 参数：空参 → show；'off' → 会话级关闭；命中档位表 → 切换档位；
 * 其余 → invalid（调用方列出可用档位报错）。
 */
export function parseThinkArgs(args: string, levels: Record<string, number>): ThinkArgResult {
  const arg = args.trim();
  if (arg === '') return { kind: 'show' };
  if (arg === 'off') return { kind: 'set', override: 'off' };
  if (levels[arg] !== undefined) return { kind: 'set', override: arg };
  return { kind: 'invalid', name: arg };
}

/**
 * 会话覆盖 → 传给 runAgent / provider.stream 的 thinking 参数（三态：
 * undefined 用构造默认 / 对象覆盖 / null 本次抑制）。档位名不在表内时回落 undefined（防御）。
 */
export function thinkStreamParam(
  override: ThinkOverride | undefined,
  levels: Record<string, number>,
): { budgetTokens?: number } | null | undefined {
  if (override === undefined) return undefined;
  if (override === 'off') return null;
  const budget = levels[override];
  return budget === undefined ? undefined : { budgetTokens: budget };
}

/**
 * 状态栏档位标签：off 覆盖 → 'off'；档位覆盖 → 档位名；
 * 无覆盖且 [thinking] 启用且配了 default_level → 档位名；否则 undefined（不显示）。
 * default_level 仅在 enabled 时展示：未启用时构造默认不带 thinking 参数，展示了是撒谎。
 */
export function thinkStatusLabel(
  override: ThinkOverride | undefined,
  thinkingCfg?: ThinkingConfig,
): string | undefined {
  if (override === 'off') return 'off';
  if (override !== undefined) return override;
  return thinkingCfg?.enabled === true ? thinkingCfg.defaultLevel : undefined;
}

/**
 * /think 门控：当前渠道是 anthropic 协议且允许发送 thinking 字段时才可用
 * （与 provider 工厂同一口径：preset.sendThinking || [thinking] enabled）。
 * providerName 为当前生效渠道（预设名或自定义渠道的 type，均为 PROVIDER_PRESETS 的 key）。
 */
export function thinkingAvailable(providerName: string, thinkingCfg?: ThinkingConfig): boolean {
  const preset = PROVIDER_PRESETS[providerName];
  return (
    preset !== undefined &&
    preset.protocol === 'anthropic' &&
    (preset.sendThinking || thinkingCfg?.enabled === true)
  );
}

/** 取当前生效的档位表（config 缺省时回落内置默认表，防御手工构造的配置对象）。 */
export function thinkLevelsOf(thinkingCfg?: ThinkingConfig): Record<string, number> {
  return thinkingCfg?.levels ?? DEFAULT_THINKING_LEVELS;
}

/**
 * 思考预算安全判定：正文最小余量 maxTokens - budget ≥ THINKING_TEXT_MARGIN。
 * 与 config.ts 的解析期余量校验同口径（复用同一常量），但用于运行时 /think 切档——
 * 切档不走 config 解析，需在 UI 层单独把这道防线补上。
 * off/undefined（无 budget）恒安全。deficit 为正表示欠缺的余量（供提示展示）。
 */
export function thinkBudgetSafety(
  override: ThinkOverride | undefined,
  levels: Record<string, number>,
  maxTokens: number,
): { safe: boolean; deficit: number; budget: number } {
  const param = thinkStreamParam(override, levels);
  if (param === undefined || param === null || param.budgetTokens === undefined) {
    return { safe: true, deficit: 0, budget: 0 };
  }
  const budget = param.budgetTokens;
  const margin = maxTokens - budget;
  return { safe: margin >= THINKING_TEXT_MARGIN, deficit: Math.max(0, THINKING_TEXT_MARGIN - margin), budget };
}
