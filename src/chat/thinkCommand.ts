import {
  DEFAULT_THINKING_LEVELS,
  isThinkingLevelName,
  PROVIDER_PRESETS,
  THINKING_LEVEL_NAMES,
  THINKING_TEXT_MARGIN,
  type ThinkingConfig,
  type ThinkingLevelName,
} from '../config/config.js';
import type { ThinkingParam } from '../provider/types.js';

/**
 * /think 命令的纯函数层：参数解析、覆盖 → 请求参数投影、状态栏标签、门控判定。
 * 全部无副作用，便于单测；App 只负责把这些结果接到 state 与 pushItem 上。
 *
 * 会话级覆盖（ThinkOverride）三态：
 * - undefined：跟随 config 的 default_level（恒有值，缺省 medium）；
 * - 'off'：本会话不再发送 thinking 字段（请求级传 null 抑制）；
 * - 'low' | 'medium' | 'high'：档位名，直接作为服务端 effort 值。
 */
export type ThinkOverride = string;

/** /think 参数解析结果。 */
export type ThinkArgResult =
  | { kind: 'show' }
  | { kind: 'set'; override: ThinkOverride }
  | { kind: 'invalid'; name: string };

/**
 * 解析 /think 参数：空参 → show；'off' → 会话级关闭；命中三档之一 → 切换档位；
 * 其余 → invalid（调用方列出可用档位报错）。
 *
 * 不再需要传档位表：合法档位固定为 low|medium|high，不由配置决定。
 */
export function parseThinkArgs(args: string): ThinkArgResult {
  const arg = args.trim();
  if (arg === '') return { kind: 'show' };
  if (arg === 'off') return { kind: 'set', override: 'off' };
  if (isThinkingLevelName(arg)) return { kind: 'set', override: arg };
  return { kind: 'invalid', name: arg };
}

/**
 * 会话覆盖 → 传给 runAgent / provider.stream 的 thinking 参数（三态：
 * undefined 用构造默认 / 对象覆盖 / null 本次抑制）。
 *
 * 返回对象同时带 level 与 budgetTokens：阶跃三协议只认档位名，原生 Anthropic 只认数字。
 * **必须带 level**——曾经这里只返回 budgetTokens，让 provider 反推档位；反推阈值硬编码，
 * 用户改 levels 数字就会静默错档。而且 TS 结构类型不会报错，这类丢字段的问题
 * 编译期抓不到，只能靠这里的契约把两份都填满。
 */
export function thinkStreamParam(
  override: ThinkOverride | undefined,
  levels: Record<ThinkingLevelName, number>,
): ThinkingParam | null | undefined {
  if (override === undefined) return undefined;
  if (override === 'off') return null;
  if (!isThinkingLevelName(override)) return undefined;
  return { level: override, budgetTokens: levels[override] };
}

/**
 * 状态栏档位标签：off 覆盖 → 'off'；档位覆盖 → 档位名；
 * 无覆盖且 [thinking] 启用 → config 的 default_level（恒有值）；未启用 → undefined（不显示）。
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
export function thinkLevelsOf(thinkingCfg?: ThinkingConfig): Record<ThinkingLevelName, number> {
  return thinkingCfg?.levels ?? DEFAULT_THINKING_LEVELS;
}

/** 可选档位名列表（弹层与报错提示共用，避免各处硬编码三个字符串）。 */
export const THINK_CHOICES: readonly ThinkingLevelName[] = THINKING_LEVEL_NAMES;

/**
 * 切档安全判定：档位对应的 budget 是否给正文留出 {@link THINKING_TEXT_MARGIN} 余量。
 *
 * ## 这个判定为什么还留着（理由已经和当初不同）
 *
 * 它原本的依据是「budget_tokens 会被发出，占掉 max_tokens」。对阶跃渠道这个依据是错的——
 * 三个接口都不收数字，只收档位字符串，`[thinking.levels]` 的数字根本不出现在请求里。
 *
 * 但结论仍然成立，换了条依据：2026-08-03 实测，**high 档本身就会让思考吃满 max_tokens
 * 导致正文零输出**（这正是「服务端返回了空响应」的根因之一）。所以「切到高档 + max_tokens
 * 偏小」这个组合确实危险，警告该给。levels 表的数字在这里的角色从「即将发出的参数」
 * 降级为「档位思考量的估算刻度」——不精确，但单调性对得上，用来排序风险够用。
 *
 * off/undefined（无档位）恒安全。deficit 为正表示欠缺的余量（供提示展示）。
 */
export function thinkBudgetSafety(
  override: ThinkOverride | undefined,
  levels: Record<ThinkingLevelName, number>,
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
