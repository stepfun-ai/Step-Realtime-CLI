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
 * /think 门控：当前渠道允许下发思考控制字段时才可用。
 *
 * ## 曾经的错误：只放行 anthropic 协议
 *
 * 旧实现要求 `preset.protocol === 'anthropic'`，依据是「thinking 请求字段只有
 * Anthropic Messages 才有」。这个前提是错的——阶跃三个接口都有思考强度参数，
 * 只是名字和层级不同（见 provider/step/stepCommon.ts 的 stepEffortParam）：
 *
 * | 协议 | 参数 |
 * |---|---|
 * | anthropic（Messages） | `output_config.effort` |
 * | openai（Chat Completions） | `reasoning_effort` |
 * | openai_responses（Responses） | `reasoning.effort` |
 *
 * 依据：[官方 step-3.7-flash 文档](https://platform.stepfun.com/docs/zh/guides/models/step-3.7-flash)
 * 「Chat Completions API 使用 reasoning_effort 控制推理强度；Messages API 使用 output_config.effort」。
 *
 * 后果：用 openai / openai_responses 渠道时 /think 被拒、状态栏不显示档位，
 * 而 provider 工厂其实已经在给这两条路径下发 effort——UI 说「不支持」，底层却在发，自相矛盾。
 *
 * 现在的口径与 provider 工厂完全一致：`preset.sendThinking || [thinking] enabled`，
 * 不再看协议。providerName 为当前生效渠道（预设名或自定义渠道的 type）。
 */
export function thinkingAvailable(providerName: string, thinkingCfg?: ThinkingConfig): boolean {
  const preset = PROVIDER_PRESETS[providerName];
  return preset !== undefined && (preset.sendThinking || thinkingCfg?.enabled === true);
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
