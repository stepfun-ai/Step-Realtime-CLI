/**
 * 模型能力声明 + config 覆盖。
 *
 * 设计来源：消息事件日志与后台通知设计 §5.3 / §7.5.2 的「provider 适配层」。
 *
 * 能力一律声明式，不做运行时探测，也**不按模型名前缀猜**。查询按 (channel, model)
 * 精确匹配：`step-3` 这类前缀既盖不住其他命名风格的模型，又会把未来任意 `step-3*`
 * 新模型无条件当成多模态——那是靠命名规律猜能力，不是读声明。
 *
 * 兜底取向：**未声明维度默认「支持」，不默认「不支持」**（{@link DEFAULT_CAPABILITY}）。
 * 依据是两类失败的代价不对称——猜少了 degrader 会静默剥掉用户真实发出的内容
 * （图片被换成占位文本、历史 thinking 块被删），不报错、不可见；猜多了服务端会
 * 明确 400，且有 nextReprojectionLevel 重投影链逐档降级自愈。静默劣化比显式报错
 * 难查得多，所以这里刻意选择「宁可多给、让服务端拒绝」而非「宁可少给、自己先削」。
 *
 * 例外见 {@link DEFAULT_CAPABILITY} 各字段注释：cache_control 默认 false 是实测
 * 结论而非取向；video_in 默认 false 是因视频块体积大、端点接受面窄，且有占位降级
 * 路径兜底（audio_in 仍无对应路径，不映射）。
 *
 * config.toml 的显式声明通过 overrides 参数注入（本模块不直接读配置，保持与
 * config 层解耦；由工厂/装配层把配置解析成 {@link CapabilityOverride} 传进来）。
 * override 按 (channel, model) 精确命中，叠加在表结果或默认之上。
 */

/** 一个模型的能力声明。布尔维度 false 一律表示「不支持」（默认见 {@link DEFAULT_CAPABILITY}）。 */
export interface ModelCapability {
  /** 是否接受图片输入。 */
  image_in: boolean;
  /** 是否接受视频输入。默认 false：未声明的模型收到视频块一律投影占位（安全默认）。 */
  video_in: boolean;
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

/**
 * 未声明时的兜底能力。取向说明见模块头注释：默认「支持」而非「不支持」，
 * 因为误剥离是静默的、误发送是显式可自愈的。
 */
export const DEFAULT_CAPABILITY: ModelCapability = {
  /** 默认接受图片：默认 false 会把用户真实发出的图静默换成占位文本（explore 读图失效即此因）。 */
  image_in: true,
  /**
   * 默认不接受视频：视频块体积大、端点接受面窄（2026-08-13 实测仅部分 openai
   * 协议端点收 video_url），默认 true 会把几十 MB 的 base64 打给大概率
   * 不认识的端点。视频有明确的占位降级路径（[video omitted ...]），静默劣化不成立。
   */
  video_in: false,
  /**
   * 默认保留 thinking 块。此维度只管「历史 thinking 块要不要保留」，不控制本次是否思考
   * （那是 sendThinking 与 reasoning.effort 的职责）。默认 false 会无条件删除历史思考
   * 上下文，且永不报错——对 Step 全系这类真会思考的模型是纯静默劣化。
   */
  reasoning: true,
  /**
   * 默认不发 cache_control。这一条不是保守取向而是实测结论：Step 全通道不兼容该字段，
   * 默认 true 等于每个请求都带上服务端明确拒绝的内容。
   */
  cache_control: false,
  /** 默认支持工具调用：默认 false 会让模型拿不到任何工具，CLI 直接失能。 */
  tool_use: true,
  max_context_tokens: 0,
  max_output_tokens: 0,
};

/** 能力查询结果：能力本体 + 来源标记（诊断展示用，不影响行为）。 */
export interface ResolvedCapability extends ModelCapability {
  /** 声明来源：静态表 / config 覆盖 / 未命中兜底。 */
  source: 'table' | 'override' | 'unknown';
}

/** 静态表条目：channel（provider 预设 key）+ model 名（精确匹配）+ 能力。 */
interface CapabilityTableEntry {
  channel: string;
  /** model 名，精确匹配（不做前缀猜测，理由见模块头注释）。 */
  model: string;
  capability: ModelCapability;
}

/**
 * config.toml 的显式能力声明（由 [models.<别名>] capabilities 解析而来）。
 * 只需要覆盖个别维度，未给出的维度沿用表结果或 {@link DEFAULT_CAPABILITY}。
 */
export interface CapabilityOverride {
  channel: string;
  /** model 名，精确匹配（与表条目同一规则）。 */
  model: string;
  capability: Partial<ModelCapability>;
}

/**
 * 内置静态能力表。只收录实测/官方文档确认过的**偏离默认**的条目。
 *
 * 与默认一致的模型不必登记——未命中会回落 {@link DEFAULT_CAPABILITY}（默认已是
 * 「支持图片 / 保留 thinking / 支持工具 / 不发 cache_control」）。因此本表的用途
 * 是记录例外，不是穷举模型清单。
 *
 * stepfun 的 cache_control 不兼容已收进 DEFAULT_CAPABILITY（全通道适用），
 * 无需逐模型登记。
 */
const CAPABILITY_TABLE: CapabilityTableEntry[] = [];

/** 在同一 channel 内按 model 名精确命中；无命中返回 undefined。 */
function matchExact<T extends { channel: string; model: string }>(
  entries: T[],
  channel: string,
  model: string,
): T | undefined {
  return entries.find((entry) => entry.channel === channel && entry.model === model);
}

/** capabilities 声明允许的取值（白名单，未知值在配置解析层报错）。 */
export const CAPABILITY_KEYS = [
  'image_in',
  'video_in',
  'audio_in',
  'thinking',
  'tool_use',
  'cache_control',
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/**
 * 把 config.toml 的 capabilities 字符串数组翻译成 {@link CapabilityOverride} 的能力片段。
 *
 * 语义：正向声明置 true；**`-` 前缀显式取负置 false**（如 `"-image_in"` 声明该模型
 * 不收图——端点只收纯文本时用，2026-08-13 智谱端点 400 实录）。未提到的维度不写进
 * 片段、继续沿用表结果或默认。取负是给「用户确知端点行为」的显式通道，不改变
 * 「未声明默认支持」的全局取向（静默劣化比显式报错难查，那条取向依然成立）。
 *
 * `thinking` 映射到 ModelCapability.reasoning（一个是配置词，一个是内部字段名）。
 * `video_in` 映射到 ModelCapability.video_in（发送前投影把视频块换占位文本）。
 * `audio_in` 目前只用于工具门控，degrader 无对应降级路径，不参与请求整形、此处不映射。
 */
export function capabilitiesToOverride(
  channel: string,
  model: string,
  capabilities: readonly string[] | undefined,
): CapabilityOverride | undefined {
  if (capabilities === undefined || capabilities.length === 0) return undefined;
  const capability: Partial<ModelCapability> = {};
  for (const raw of capabilities) {
    const c = raw.trim().toLowerCase();
    const negate = c.startsWith('-');
    const key = negate ? c.slice(1) : c;
    if (key === 'image_in') capability.image_in = !negate;
    else if (key === 'video_in') capability.video_in = !negate;
    else if (key === 'thinking') capability.reasoning = !negate;
    else if (key === 'tool_use') capability.tool_use = !negate;
    else if (key === 'cache_control') capability.cache_control = !negate;
  }
  if (Object.keys(capability).length === 0) return undefined;
  return { channel, model, capability };
}

/**
 * 查询 (channel, model) 的能力声明。
 *
 * 解析顺序：静态表精确命中 → 表结果；未命中 → {@link DEFAULT_CAPABILITY}。
 * 随后叠加 overrides 里同 (channel, model) 的精确命中项（只覆盖其显式给出的维度）。
 * overrides 命中时 source 记为 'override'，无论基底是表还是默认。
 */
export function resolveCapability(
  channel: string,
  model: string,
  overrides?: CapabilityOverride[],
): ResolvedCapability {
  const tableHit = matchExact(CAPABILITY_TABLE, channel, model);
  const base: ModelCapability = tableHit !== undefined ? tableHit.capability : DEFAULT_CAPABILITY;
  const overrideHit = overrides !== undefined ? matchExact(overrides, channel, model) : undefined;
  if (overrideHit === undefined) {
    return { ...base, source: tableHit !== undefined ? 'table' : 'unknown' };
  }
  return { ...base, ...overrideHit.capability, source: 'override' };
}
