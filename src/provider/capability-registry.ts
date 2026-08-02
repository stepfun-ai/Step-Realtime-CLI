/**
 * 静态模型能力表 + config 覆盖。
 *
 * 设计来源：消息事件日志与后台通知设计 §5.3 / §7.5.2 的「provider 适配层」。
 * 能力一律声明式查表，不做运行时探测。查询按 (channel, model 名前缀) 匹配，
 * 同一 channel 内取最长前缀命中；查不到返回全 false 的 UNKNOWN 能力（保守兜底，
 * degrader 据此把媒体 / thinking / cache_control 一律剥离，宁可降级不可 400）。
 *
 * config.toml 的显式声明通过 overrides 参数注入（本模块不直接读配置，保持与
 * config 层解耦；由工厂/装配层把配置解析成 {@link CapabilityOverride} 传进来）。
 * override 命中规则与表一致（channel 精确 + 最长前缀），叠加在表结果或 UNKNOWN 之上。
 */

/** 一个模型的能力声明。布尔维度 false 一律表示「不支持/未声明」，不区分原因。 */
export interface ModelCapability {
  /** 是否接受图片输入。 */
  image_in: boolean;
  /** 是否支持 reasoning/thinking（含 thinking 块回灌）。 */
  reasoning: boolean;
  /** 是否接受 cache_control 字段（prompt cache 断点）。 */
  cache_control: boolean;
  /** 是否支持工具调用。 */
  tool_use: boolean;
  /** 上下文窗口 token 上限；0 表示未知。 */
  max_context_tokens: number;
  /** 单次最大输出 token；0 表示未知。 */
  max_output_tokens: number;
}

/** 查不到任何声明时的兜底能力：全 false、上限 0（未知）。 */
export const UNKNOWN_CAPABILITY: ModelCapability = {
  image_in: false,
  reasoning: false,
  cache_control: false,
  tool_use: false,
  max_context_tokens: 0,
  max_output_tokens: 0,
};

/** 能力查询结果：能力本体 + 来源标记（诊断展示用，不影响行为）。 */
export interface ResolvedCapability extends ModelCapability {
  /** 声明来源：静态表 / config 覆盖 / 未命中兜底。 */
  source: 'table' | 'override' | 'unknown';
}

/** 静态表条目：channel（provider 预设 key）+ model 名前缀 + 能力。 */
interface CapabilityTableEntry {
  channel: string;
  /** model 名前缀（startsWith 匹配，最长前缀优先）。 */
  modelPrefix: string;
  capability: ModelCapability;
}

/**
 * config.toml 的显式能力声明（如 [[capabilities]] 段解析而来）。
 * 只需要覆盖个别维度，未给出的维度沿用表结果或 UNKNOWN。
 */
export interface CapabilityOverride {
  channel: string;
  /** model 名前缀，与表条目同一匹配规则。 */
  modelPrefix: string;
  capability: Partial<ModelCapability>;
}

/**
 * 内置静态能力表。只收录实测/官方文档确认过的条目，拿不准的不写——
 * 查不到本来就会回落 UNKNOWN 保守降级，写错比不写危害更大（false 会误剥离
 * 模型实际接受的输入，true 最多只是不主动降级、还有错误驱动重投影兜底）。
 *
 * stepfun 的 cache_control 不兼容个案在此声明为不支持：degrader 据此主动剥离，
 * 请求代码里不再特判。
 */
const CAPABILITY_TABLE: CapabilityTableEntry[] = [
  {
    channel: 'stepfun',
    modelPrefix: 'step-3',
    capability: {
      image_in: true,
      reasoning: true,
      cache_control: false,
      tool_use: true,
      max_context_tokens: 0,
      max_output_tokens: 0,
    },
  },
];

/** 在同一 channel 的条目里取最长前缀命中；无前缀命中返回 undefined。 */
function matchLongestPrefix<T extends { channel: string; modelPrefix: string }>(
  entries: T[],
  channel: string,
  model: string,
): T | undefined {
  let best: T | undefined;
  for (const entry of entries) {
    if (entry.channel !== channel) continue;
    if (!model.startsWith(entry.modelPrefix)) continue;
    if (best === undefined || entry.modelPrefix.length > best.modelPrefix.length) {
      best = entry;
    }
  }
  return best;
}

/**
 * 查询 (channel, model) 的能力声明。
 *
 * 解析顺序：静态表命中 → 表结果；未命中 → UNKNOWN。随后叠加 overrides 里
 * 同 channel 的最长前缀命中项（只覆盖其显式给出的维度）。overrides 命中时
 * source 记为 'override'，无论基底是表还是 UNKNOWN。
 */
export function resolveCapability(
  channel: string,
  model: string,
  overrides?: CapabilityOverride[],
): ResolvedCapability {
  const tableHit = matchLongestPrefix(CAPABILITY_TABLE, channel, model);
  const base: ModelCapability = tableHit !== undefined ? tableHit.capability : UNKNOWN_CAPABILITY;
  const overrideHit =
    overrides !== undefined ? matchLongestPrefix(overrides, channel, model) : undefined;
  if (overrideHit === undefined) {
    return { ...base, source: tableHit !== undefined ? 'table' : 'unknown' };
  }
  return { ...base, ...overrideHit.capability, source: 'override' };
}
