import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { PermissionMode } from '../agent/permission/mode.js';
import { CAPABILITY_KEYS } from '../provider/capability-registry.js';
import { t, type Locale } from '../i18n.js';

/**
 * 子 agent 限制。设计三件套：可配 + 硬编码默认 + clamp 上限。
 * 深度用 clamp 封顶防 fork-bomb；并发维度不设——step-code 顺序执行，无并发概念。
 */
export interface SubagentLimits {
  /** 嵌套深度上限（父=0）。硬顶封 2。 */
  maxDepth: number;
  /** 每个子 agent 内部最大 模型↔工具 往返轮数的全局默认；agent 定义的 maxSteps 可覆盖。 */
  maxSteps: number;
  /** 并行子 agent 的并发上限（一轮里并行执行的 explore 数量）。 */
  maxConcurrent: number;
  /** 子会话留存与清理策略（[subagent.retention] 段）。 */
  retention: SubagentRetention;
}

/**
 * 子会话留存策略。默认不主动删：子 agent 历史的价值在事后追查，追查常发生在数周后。
 * delete_with_parent 默认开：用户显式删主会话即表达"这个会话不要了"，其子会话是纯垃圾。
 */
export interface SubagentRetention {
  /** 删主会话时连带删其子会话（跳过持活跃锁的）。 */
  deleteWithParent: boolean;
  /** 子会话数量上限（按 updatedAt 删最旧，跳过持活跃锁的）。0 = 不限。 */
  maxSessions: number;
  /** 子会话过期天数（按 updatedAt，跳过持活跃锁的）。0 = 不过期。 */
  ttlDays: number;
}

/**
 * 上下文压缩配置。压缩判定下沉进 agent 循环，靠真实 usage 判断，
 * 超阈值先微压缩（清旧 tool_result 正文）、仍超再全量 LLM 摘要。
 */
export interface CompactionConfig {
  /** 触发比例：占用达到 maxContextSize × 此值即压缩。clamp [0.5, 0.99]。 */
  triggerRatio: number;
  /** 预留量：剩余窗口不足此值即压缩（给下一次生成留安全垫）。clamp [0, 500000]。 */
  reservedTokens: number;
  /** 压缩摘要专用模型（大小模型协同）。缺省用主会话模型，行为与之前完全一致。 */
  model?: string;
  /**
   * 用户原话保真预算（token）：压缩时在摘要之外单独保留的用户原始消息总量。
   * 缺省 20000（见 COMPACT_USER_MESSAGE_MAX_TOKENS）。0 = 关闭保真块，回到纯摘要行为。
   * clamp [0, 200000]。
   */
  userMessageMaxTokens?: number;
  /**
   * 保真预算中划给「最早消息」的份额（token）。缺省 2000。clamp [0, userMessageMaxTokens]。
   * 预算不足时最早消息留开头、最近消息留结尾，中段丢弃并插省略说明。
   */
  userMessageHeadTokens?: number;
}

/**
 * 输出截断自动续写配置（[continuation] 段）。
 */
export interface ContinuationConfig {
  /**
   * 输出被 max_tokens 截断时，自动续写的最大次数。默认 3。
   * 0 = 关闭自动续写，保持既有行为。
   * 每轮续写都经过循环守卫，异常循环会在次数上限或病态特征处停下。
   */
  maxAutoContinues?: number;
}

/**
 * 后台执行配置（[background] 段）。四个字段全部可选，缺省不进结果对象，
 * 消费方用 ?? 落默认（notifyOnComplete / bashAutoBackgroundOnTimeout 默认 true，
 * bashTaskTimeoutS 默认 600、0 = 不限；notifyTerminal 默认 true）。
 */
export interface BackgroundConfig {
  /** bash 前台超时后自动转后台（默认 true；false 保持超时即杀）。 */
  bashAutoBackgroundOnTimeout?: boolean;
  /** 后台任务超时秒数（默认 600，clamp [0, 86400]，0 = 不限）。 */
  bashTaskTimeoutS?: number;
  /** 后台任务终态时主动注入完成通知（默认 true；false 回到模型经 task_list 查询）。 */
  notifyOnComplete?: boolean;
  /** 后台任务终态时发终端铃响/桌面通知（默认 true；false 静默）。 */
  notifyTerminal?: boolean;
}

/**
 * 联网搜索配置（[search] / [search.web] / [search.image] 段）。
 * 搜索是阶跃平台专属增值能力，与主会话模型渠道在业务上不等价——主会话切到非阶跃
 * 渠道时，复用其 base_url + apiKey 会把搜索请求打到错误地址（404）。因此搜索配置独立。
 *
 * 三层结构：[search] 是通用兜底，[search.web] / [search.image] 分别覆盖内容搜索与文搜图。
 * 字段全部可选，缺省键不进结果对象。消费方按「专用段 → 通用段 → 主会话渠道」的优先级解析，
 * 最终都缺时缺省回退主会话渠道（零配置默认策略，见工具内注释）。
 *
 * url 是「已含协议路径」的完整 Base URL，工具只在末尾拼 /search 或 /search-image，
 * 不做 resolveSearchBaseUrl 式裁剪——独立配置视为用户的精确意图。
 */
export interface SearchEndpointConfig {
  /** Base URL（如 https://api.stepfun.com/v1 或 .../step_plan/v1）。 */
  url?: string;
  /** 鉴权 key。 */
  key?: string;
}

export interface SearchConfig {
  /** 通用段 [search]：内容搜索与文搜图的默认 url/key。 */
  url?: string;
  key?: string;
  /** 内容搜索专用段 [search.web]，覆盖通用段。 */
  web?: SearchEndpointConfig;
  /** 文搜图专用段 [search.image]，覆盖通用段。 */
  image?: SearchEndpointConfig;
}

/**
 * 网页结果缓存容量配置（[tools.web] 段）。
 *
 * 三个维度任一传 `0` 表示该维度不限制（等价于不配）。
 * 缺省值见 WebResultCache 模块级常量。
 */
export interface WebCacheConfig {
  /** 条目数上限。 */
  maxSize?: number;
  /** 缓存总字节上限（估算值）。 */
  maxBytes?: number;
  /** 单条字节上限（估算值）；超过则整条不入缓存。 */
  maxEntryBytes?: number;
}

/**
 * thinking（推理过程）请求配置（[thinking] 段）。
 *
 * enabled 默认 false：不主动发 thinking 字段，保持既有请求行为（部分服务端对该字段 400）。
 *
 * ## 用户接口是档位名，不是 token 数
 *
 * 唯一的用户旋钮是 `default_level`（low|medium|high），会话级用 `/think <档位>` 切换。
 * 曾经存在的 `[thinking] budget_tokens = <数字>` 已删除，原因是那个数字对阶跃渠道
 * **从未真正发出**：它只被用来折算档位，而折算阈值是硬编码的，用户改了
 * `[thinking.levels]` 的数字就会错档（配 medium=20000 实际发出 high）。
 * 让用户填一个既不会送达、又可能被错误折算的数字，是有害的接口。
 *
 * `levels` 表保留但语义降级为高级选项，作用范围只有原生 Anthropic 渠道，
 * 详见 {@link DEFAULT_THINKING_LEVELS} 的注释。
 */
export interface ThinkingConfig {
  /** 是否主动发送 thinking 请求字段（budget 控制手段；思考本身是服务端固有行为，渲染不受影响）。 */
  enabled: boolean;
  /** 档位 → budget token 数映射（仅原生 Anthropic 渠道生效，每档 clamp ≥1024）。恒含三档。 */
  levels: Record<ThinkingLevelName, number>;
  /**
   * 默认档位（[thinking] default_level）。恒有值——未配置时取
   * {@link DEFAULT_THINKING_LEVEL}（medium），不留 undefined。
   * 留空等于「不发 effort」，而实测「不发 effort = 跑最高思考量」，会导致正文被思考挤空。
   */
  defaultLevel: ThinkingLevelName;
}

/**
 * [models.<别名>] 表的单条模型配置（渠道与模型分离）：字段全部可选，
 * 缺省项在 {@link resolveModelEntry} 合并时继承渠道与顶层配置。
 */
export interface ModelEntry {
  /** 渠道 id（[providers.<id>] 自定义渠道）；缺省继承顶层 provider。显式写内置预设名视为无效别名。 */
  provider?: string;
  /** 真实模型 id；缺省 = 别名本身。 */
  model?: string;
  /** 缺省：entry.provider 指向的渠道/预设 baseUrl，再缺省继承顶层。 */
  baseUrl?: string;
  apiKey?: string;
  /** 间接引用：只存环境变量名（api_key_env），密钥不落盘；解析时读 process.env[apiKeyEnv]。 */
  apiKeyEnv?: string;
  maxContextSize?: number;
  maxTokens?: number;
  /** 展示名（选择器与状态栏显示用）；缺省用别名/真实 id。 */
  displayName?: string;
  /** 能力标记（如 thinking / image_in），原样透传，消费方自己解释。 */
  capabilities?: string[];
  /**
   * 按别名声明模型的图片输入长边上限（像素，config.toml [models.*] image_max_edge_px）。
   * 消费方：read_media 交付降采样阈值。缺省走全局保守值（1568，Claude 推荐长边）；
   * 高上限通道（如 GPT 系 high detail 长边 2048）可按别名放宽。
   */
  imageMaxEdgePx?: number;
  /**
   * 按别名声明单图交付字节预算（config.toml [models.*] image_budget_bytes）。
   * 消费方：read_media 字节预算。缺省走全局保守值（256KB，上下文经济性预算，
   * 远低于各家 API 硬限制）；需要原图精度的读图场景可按别名放宽。
   */
  imageBudgetBytes?: number;
  /**
   * 按别名声明单视频交付字节预算（config.toml [models.*] video_budget_bytes）。
   * 消费方：read_media 视频预算。缺省走全局保守值 32MB（v1 视频只能 inline base64，
   * 膨胀 1.33 倍进请求体）；确认端点吃得下更大文件时可按别名放宽。
   */
  videoBudgetBytes?: number;
  /**
   * 按别名覆盖媒体降级保留张数（config.toml [models.*] media_keep_recent）。
   * 缺省继承顶层 media_keep_recent，再缺省 10。通道限制差异大（step-3.7 实测
   * 60 张、Gemini 10 张、GLM 5 张），宽松通道可多留、严格通道少留。
   */
  mediaKeepRecent?: number;
}

/** 用户可配置 hooks 的合法事件名集合（其余事件名视为非法，整条跳过）。 */
export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart'] as const;

/** hook 事件名（合法集见 {@link HOOK_EVENTS}）。 */
export type HookEventName = (typeof HOOK_EVENTS)[number];

/**
 * 单条用户 hook（config.toml 扁平 `[[hooks]]` 数组的一项）。
 * 执行语义：shell 命令 + stdin JSON 输入；exit 0 放行（UserPromptSubmit/SessionStart 时
 * stdout 注入上下文）、exit 2 阻断（stderr 为原因）、其余非零/超时/崩溃 fail-open。
 */
export interface HookConfigEntry {
  /** 生命周期事件名。 */
  event: HookEventName;
  /** 可选正则（匹配工具名/事件相关标识），已编译；非法正则整条跳过。 */
  matcher?: RegExp;
  /** 要执行的 shell 命令（spawn with shell）。 */
  command: string;
  /** 超时秒数：默认 30，clamp [1,600]；超时杀进程树并按 fail-open 放行。 */
  timeout: number;
}

/**
 * [providers.<id>] 渠道表的单条渠道配置：type 必填（映射 {@link PROVIDER_PRESETS}
 * 的协议 key，非法 type 该项无效），baseUrl/apiKey/apiKeyEnv 可选（缺省在
 * {@link resolveModelEntry} 合并时按渠道分支回落链解析）。
 */
export interface ProviderEntry {
  /** 协议类型，对应 PROVIDER_PRESETS 的 key（决定 provider 工厂分发与 sendThinking）。 */
  type: string;
  baseUrl?: string;
  apiKey?: string;
  /** 间接引用：只存环境变量名（api_key_env），密钥不落盘；解析时读 process.env[apiKeyEnv]。 */
  apiKeyEnv?: string;
}

/**
 * memory 观察池配置（[memory] 段）。
 * enabled 默认 false：不注入记忆段、不创建目录、/memory 提示未开启。
 * 关闭不是删除——已有记忆文件原样保留，重新开启即恢复。
 */
export interface MemoryConfig {
  enabled: boolean;
}

/**
 * TUI 渲染配置（[tui] 段）。
 */
export interface TuiConfig {
  /** 工具错误输出折叠态预览行数（clamp [1, 20]）。默认 4。 */
  errorPreviewLines?: number;
  /** 是否把会话标题写进终端 tab 标题（OSC 0）。默认 true；不支持的终端自动跳过。 */
  terminalTitle?: boolean;
}

/**
 * step-code 运行时配置。
 *
 * StepFun 服务端走 Anthropic Messages 协议，有几条硬约束（见 provider 层）：
 * base_url 不带 /v1（SDK 自动拼），仅支持 base64 图片。
 */
export interface StepCodeConfig {
  /** 服务商标识（如 'stepfun' | 'anthropic'）。决定预设默认与 provider 工厂分发。 */
  provider: string;
  /**
   * 最终生效的 API key（渠道/别名回落链的解析结果，见 {@link resolveModelEntry}）。
   * 注意：这不是一个用户可配的顶层字段——config.toml 顶层没有 api_key，
   * key 只能配在 [providers.<id>] 渠道或 [models.<别名>] 上。此处的值来自
   * 环境变量（隐式渠道场景）或别名展开后的渠道链解析。
   * 允许 undefined：缺失时由 provider 工厂在构造前抛带指引的错误。
   */
  apiKey: string | undefined;
  baseUrl: string;
  model: string;
  /** 模型上下文上限（token）。默认对齐内置默认模型的窗口（256K）；更大窗口的模型需经 config.toml max_context_size 显式声明。 */
  maxContextSize: number;
  /** 单次响应最大输出 token。默认 65536（给 high 档 thinking 预算留足正文余量，避免思考吃满预算致正文零输出；也避免长输出/大段代码中途截断）。可经 config.toml max_tokens 覆盖。 */
  maxTokens: number;
  /** 子 agent 限制。 */
  subagent: SubagentLimits;
  /** 上下文压缩配置。 */
  compaction: CompactionConfig;
  /** 输出截断自动续写配置。 */
  continuation?: ContinuationConfig;
  /** 后台执行配置（[background] 段）。字段全部可选，缺省键不进对象。 */
  background?: BackgroundConfig;
  /** thinking（推理过程）请求配置（[thinking] 段）。loadConfig 恒赋值（默认 { enabled: false }），消费方仍按可选处理。 */
  thinking?: ThinkingConfig;
  /** memory 观察池开关（[memory] 段）。loadConfig 恒赋值（默认 { enabled: false }）。 */
  memory?: MemoryConfig;
  /** 联网搜索配置（[search] 段）。loadConfig 恒赋值（可能为空对象 {}），消费方按「专用段 → 通用段 → 主会话渠道」解析。 */
  search?: SearchConfig;
  /** 网页结果缓存容量配置（[tools.web] 段）。未配置时使用内置默认值（条目数 100 / 总字节 32MB / 单条 2MB）。 */
  web?: WebCacheConfig;
  /** 界面语言（TUI/CLI 给人看的文案）。缺省 'zh'；给模型看的文案恒中文，不受其影响。 */
  language?: Locale;
  /**
   * 权限模式默认值（config.toml permission_mode）。缺省 manual（键不进结果对象，行为与之前一致）。
   * 生效优先级：CLI flag（--yolo/--auto）> 本键 > 恢复会话存储的 mode > manual。
   * 运行态 /permission、/yolo 切换不回写本键——yolo 被常驻化必须是用户的显式编辑行为。
   */
  permissionMode?: PermissionMode;
  /**
   * 代理 URL（config.toml proxy，如 http://127.0.0.1:7892）。启动时注入 HTTPS_PROXY
   * （环境变量已存在则不覆盖：环境变量 > 本键 > 直连），全局 fetch 经 Node 内置
   * NODE_USE_ENV_PROXY 机制生效。只在启动时读取（reload 标 restart）。
   */
  proxy?: string;
  /** AGENTS.md 自定义加载路径（config.toml agents_paths）。配置后完全覆盖默认的用户级+项目级收集；文件直读、目录取 AGENTS.md / agents.md。支持 `~` 与相对 cwd 的路径。 */
  agentsPaths?: string[];
  /** AGENTS.md 总字节预算（config.toml agents_md_max_bytes，UTF-8 字节计）。缺省 32KB；0 或负数 = 禁用 AGENTS.md 加载。非法值（非数字）时键不进结果对象。 */
  agentsMdMaxBytes?: number;
  /** skills 追加扫描目录（config.toml extra_skill_dirs）。追加在默认路径之后、plugin 之前扫描，同名 skill 追加目录胜出。支持 `~` 与相对 cwd 的路径。 */
  extraSkillDirs?: string[];
  /** 按名排除的 skill 清单（config.toml disabled_skills）。合并完成后统一过滤，任何来源的同名 skill 都不加载；用于屏蔽不归你管的目录（团队共享 .agents/skills 等）里的个别 skill。 */
  disabledSkills?: string[];
  /** skill 清单注入 system prompt 的字符预算（config.toml skill_listing_budget）。缺省 8000；超预算先压缩描述再逐条截断。调高可让更多 skill 的名称和描述常驻 L1。 */
  skillListingBudget?: number;
  /**
   * 媒体降级时保留的最近图片张数（config.toml media_keep_recent）。缺省 10。
   * 全通道生效：stepfun 走 StepfunAdapter.send 的重投影，其余通道走
   * withMediaDegradation wrapper（factory.ts 装配）。别名的 [models.*]
   * media_keep_recent 可覆盖（resolveModelEntry 合并）。
   * 触发 413/400 图片超限时，media-degraded 档只把更旧的图换成占位文本、保留最近 N 张，
   * 避免「全剥光、模型变瞎」。0 = 旧行为（全换占位）。
   */
  mediaKeepRecentImages?: number;
  /** [models.<别名>] 模型别名表（渠道与模型分离）。未配置或全部无效时键不进结果对象。 */
  models?: Record<string, ModelEntry>;
  /** [providers.<id>] 渠道表（自定义服务商端点/密钥）。未配置或全部无效时键不进结果对象。 */
  providers?: Record<string, ProviderEntry>;
  /** 用户可配置 hooks（[[hooks]] 扁平数组）。未配置或全部无效时键不进结果对象。 */
  hooks?: HookConfigEntry[];
  /**
   * 当前模型的能力标记（如 image_in）。仅当最终 model 命中 [models.<别名>] 且该别名声明了
   * capabilities 时由 {@link resolveModelEntry} 带入；裸模型 / 未命中别名时为 undefined。
   * 消费方：read_media 等多模态工具据此做能力门控（经 ToolContext.capabilities 下发）。
   */
  capabilities?: string[];
  /**
   * 当前模型的图片输入长边上限（像素）。同 capabilities 的带入语义：仅命中别名且声明时
   * 由 {@link resolveModelEntry} 带入；缺省由消费方（read_media）回退全局保守值 1568。
   */
  imageMaxEdgePx?: number;
  /** 当前模型的单图交付字节预算。带入语义同 {@link imageMaxEdgePx}；缺省回退 256KB。 */
  imageBudgetBytes?: number;
  /** 当前模型的单视频交付字节预算。带入语义同 {@link imageMaxEdgePx}；缺省回退 32MB。 */
  videoBudgetBytes?: number;
  /**
   * 用户原始选择的模型别名（展开前）。当 config.model 是别名（如 'step37-plan'）时，
   * 此字段保存该别名；config.model 是裸模型 id 时为 undefined。
   *
   * 解决「多别名指向同一真实 id」的歧义：step37 和 step37-plan 都是 step-3.7-flash，
   * 但渠道不同（stepfun vs stepfun-plan）。App 侧需要知道用户实际选的是哪个别名，
   * 才能正确初始化 currentModelAliasRef 和 modelLabel。
   */
  modelAlias?: string;
  /** TUI 渲染配置（[tui] 段）。未配置时键不进结果对象，消费方用 ?? 落默认。 */
  tui?: TuiConfig;
}

const DEFAULT_BASE_URL = 'https://api.stepfun.com';
const DEFAULT_MODEL = 'step-3.7-flash';
const DEFAULT_MAX_CONTEXT = 262_144;
const DEFAULT_MAX_TOKENS = 65536;
const DEFAULT_MAX_AUTO_CONTINUES = 3;

/**
 * provider 协议维度：决定 provider 工厂分发到哪个适配器实现。
 * - anthropic：Anthropic Messages 协议（/v1/messages，base_url 不带 /v1，SDK 自拼）。
 * - openai：OpenAI Chat Completions 协议（/v1/chat/completions，base_url 带 /v1）。
 * - openai_responses：OpenAI Responses 协议（/v1/responses，base_url 带 /v1，支持工具调用）。
 */
export type ProviderProtocol = 'anthropic' | 'openai' | 'openai_responses';

/** 服务商预设：仅在用户未显式配置 baseUrl/model 时提供默认；protocol/sendThinking 供 provider 工厂读取。 */
export interface ProviderPreset {
  /** 协议维度：provider 工厂据此分发到对应适配器。 */
  protocol: ProviderProtocol;
  /** 默认 base_url（用户未配时使用）。 */
  baseUrl?: string;
  /** 默认 model（用户未配时使用）；anthropic 不预设，需用户自配。 */
  model?: string;
  /** 是否允许发送 thinking 字段（仅 anthropic 协议有意义；openai 协议下工厂忽略）。stepfun 必须为 false。 */
  sendThinking: boolean;
}

/** 默认服务商。保持 stepfun 以维持历史默认路径行为字节级不变。 */
export const DEFAULT_PROVIDER = 'stepfun';

/**
 * 服务商预设表。未知 provider 不在此表内，由 provider 工厂负责报错。
 * stepfun/anthropic 走 Anthropic Messages 协议（历史默认，行为字节级不变）；
 * openai/openai_responses 走 OpenAI 协议，base_url 默认带 /v1（拼 /chat/completions 或 /responses）。
 */
export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  stepfun: { protocol: 'anthropic', baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL, sendThinking: false },
  anthropic: { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', sendThinking: true },
  openai: { protocol: 'openai', baseUrl: `${DEFAULT_BASE_URL}/v1`, model: DEFAULT_MODEL, sendThinking: false },
  openai_responses: { protocol: 'openai_responses', baseUrl: `${DEFAULT_BASE_URL}/v1`, model: DEFAULT_MODEL, sendThinking: false },
};

/** 渠道 type 对应的惯例 API key 环境变量名（协议层被广泛使用的变量名）；无惯例 → undefined。 */
export function conventionalApiKeyEnvVar(providerType: string): string | undefined {
  switch (providerType) {
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'openai':
    case 'openai_responses':
      return 'OPENAI_API_KEY';
    default:
      return undefined;
  }
}

/** 读环境变量：name 缺失/空串，或变量未设置/为空串 → undefined（空串视为未设置，与 asString 判空一致）。 */
function envValue(name: string | undefined): string | undefined {
  if (name === undefined || name === '') return undefined;
  const v = process.env[name];
  return v !== undefined && v !== '' ? v : undefined;
}

// 子 agent 限制的默认值与 clamp 边界（默认克制、上限封顶）。
const SUBAGENT_MAX_DEPTH_DEFAULT = 1;
const SUBAGENT_MAX_DEPTH_MIN = 1;
const SUBAGENT_MAX_DEPTH_MAX = 3; // 硬顶封 3：防 fork-bomb，配置无法突破；默认 1，显式配置才放宽嵌套
const SUBAGENT_MAX_STEPS_DEFAULT = 100;
const SUBAGENT_MAX_STEPS_MIN = 1;
const SUBAGENT_MAX_STEPS_MAX = 1000;
const SUBAGENT_MAX_CONCURRENT_DEFAULT = 4;
const SUBAGENT_MAX_CONCURRENT_MIN = 1;
const SUBAGENT_MAX_CONCURRENT_MAX = 16;

// 压缩配置默认值与 clamp 边界（0.85 触发 + 预留安全垫）。
const COMPACTION_TRIGGER_RATIO_DEFAULT = 0.85;
const COMPACTION_TRIGGER_RATIO_MIN = 0.5;
const COMPACTION_TRIGGER_RATIO_MAX = 0.99;
const COMPACTION_RESERVED_TOKENS_DEFAULT = 32_000;
const COMPACTION_RESERVED_TOKENS_MIN = 0;
const COMPACTION_RESERVED_TOKENS_MAX = 500_000;
// 用户原话保真预算的 clamp 边界（默认值在 compact.ts，此处只做上下界防御）。
const COMPACTION_USER_TOKENS_MIN = 0;
const COMPACTION_USER_TOKENS_MAX = 200_000;

// 后台任务超时 clamp 边界（默认 600 在消费方落，0 = 不限）。
const BACKGROUND_TASK_TIMEOUT_MIN = 0;
const BACKGROUND_TASK_TIMEOUT_MAX = 86_400;

// hook 超时 clamp 边界与默认（秒）：默认 30，硬顶 600，下限 1。
const HOOK_TIMEOUT_DEFAULT = 30;
const HOOK_TIMEOUT_MIN = 1;
const HOOK_TIMEOUT_MAX = 600;

// thinking 配置边界：Anthropic 协议要求 budget ≥1024；正文最小余量 2048
// （实测教训：思考会吃满 max_tokens，余量不足时正文零输出）。
const THINKING_BUDGET_MIN = 1024;
export const THINKING_TEXT_MARGIN = 2048;

/**
 * 合法档位名（用户接口只有这三个，与 Step 三接口的 effort 取值一一对应）。
 * 不再支持自定义档位名：档位名要直接作为 effort 值发给服务端，自造的名字服务端不认。
 */
export const THINKING_LEVEL_NAMES = ['low', 'medium', 'high'] as const;

export type ThinkingLevelName = (typeof THINKING_LEVEL_NAMES)[number];

/** 判定字符串是否为合法档位名。 */
export function isThinkingLevelName(value: unknown): value is ThinkingLevelName {
  return typeof value === 'string' && (THINKING_LEVEL_NAMES as readonly string[]).includes(value);
}

/**
 * `[thinking] default_level` 未配置时的兜底档位。
 *
 * 为什么必须有兜底、且不能是「不发档位」：2026-08-03 实测，阶跃三通道在**不发 effort**
 * 时的思考量全部落在 high 附近（三通道基线与 high 档同量级）。即「空档位 = 跑最高思考量」，
 * 而 high 档在难任务上会把 max_tokens 打满、正文零输出——这正是「服务端返回了空响应」
 * 那个 bug 的成因之一。所以缺省必须显式取中档，不能留空交给服务端默认。
 */
export const DEFAULT_THINKING_LEVEL: ThinkingLevelName = 'medium';

/**
 * 内置档位 → budget token 数映射表。
 *
 * ## 这张表的作用范围很窄，别误解
 *
 * 它**只在原生 Anthropic 渠道（api.anthropic.com）生效**，在那条路径上被翻译成
 * `thinking.budget_tokens` 真实发出。阶跃三个接口一律不收数字，收的是
 * `effort: 'low'|'medium'|'high'` 字符串（见 provider/step/stepCommon.ts），
 * 档位名直接作为 effort 值发出，**根本不经过这张表**。
 *
 * 因此改这张表的数字，对阶跃渠道零影响。它属于高级选项，不是普通用户的调节旋钮——
 * 普通用户只需要 `default_level` 和 `/think <档位>`。
 */
export const DEFAULT_THINKING_LEVELS: Record<ThinkingLevelName, number> = {
  low: 1024,
  medium: 4096,
  high: 32000,
};

/**
 * 从 cwd 下的 .env 文件读取键值（若存在），只填充尚未在 process.env 中的键。
 * 不引入 dotenv 依赖，保持极简；只解析 `KEY=VALUE` 形式，忽略注释与空行。
 */
function loadDotEnv(cwd: string): void {
  const envPath = join(cwd, '.env');
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 去掉包裹的引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '' && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

interface TomlConfigShape {
  provider?: unknown;
  base_url?: unknown;
  model?: unknown;
  max_context_size?: unknown;
  max_tokens?: unknown;
  subagent?: unknown;
  compaction?: unknown;
  continuation?: unknown;
  background?: unknown;
  thinking?: unknown;
  memory?: unknown;
  search?: unknown;
  tools?: unknown;
  language?: unknown;
  permission_mode?: unknown;
  proxy?: unknown;
  agents_paths?: unknown;
  agents_md_max_bytes?: unknown;
  media_keep_recent?: unknown;
  extra_skill_dirs?: unknown;
  disabled_skills?: unknown;
  skill_listing_budget?: unknown;
  models?: unknown;
  providers?: unknown;
  hooks?: unknown;
  tui?: unknown;
}

/**
 * 逃生舱环境变量：配置文件语法错误时以内置默认配置启动。
 *
 * 为什么必须有这个开关：config.toml 在 home 目录，而用户常用 step-code 自己修改它
 *（内置 update-config skill 就是干这个的）。若语法错误一律 exit，就出现「起不来 →
 * 无法用 step-code 修 step-code 的配置」的死锁。设为 1 时整份配置不生效，调用方
 * 负责持续告知用户（不能悄悄用默认配置跑，那正是本机制要消灭的行为）。
 */
export const IGNORE_BAD_CONFIG_ENV = 'STEP_CODE_IGNORE_BAD_CONFIG';

/** 语法错误被逃生舱忽略时的现场信息（整份配置未生效）。 */
export interface IgnoredBadConfigFile {
  path: string;
  message: string;
}

/**
 * loadConfig 的启动期诊断结果。
 *
 * 这里只交出**原始 TOML 表**，不算警告：警告规则住在 diagnostics.ts，而那个模块要用
 * 本模块的 PROVIDER_PRESETS / HOOK_EVENTS。让 config.ts 反过来 import 它会形成循环依赖，
 * 所以分工是——config 负责读取与降级事实，diagnostics 负责规则，cli 负责组合与呈现。
 */
export interface ConfigLoadDiagnostics {
  /** 解析成功的原始顶层表（供 collectConfigWarnings 检查）；被逃生舱放行时为空表。 */
  rawToml: Record<string, unknown>;
  /** 存在时表示配置文件解析失败但被逃生舱放行，本次跑的是内置默认配置。 */
  ignoredBadFile?: IgnoredBadConfigFile;
}

/** 诊断出口：由调用方（cli.ts）决定往哪条通道呈现。 */
export type ConfigDiagnosticsSink = (diagnostics: ConfigLoadDiagnostics) => void;

/**
 * 从 ~/.step-code/config.toml 读取配置（若存在）。
 *
 * 解析失败**抛错**而非返回 {}：静默回落等于「用一份用户从未写过的配置跑」——所有渠道、
 * 别名、语言、权限模式全部消失，随后的报错（api key 缺失、陌生端点 404）与真实病因
 * （某一行语法错）之间没有任何可见链条，比启动失败难排查得多。
 * 文件不存在是正常的零配置场景，照旧返回 {}。
 * 逃生舱（{@link IGNORE_BAD_CONFIG_ENV}）置 1 时降级为「忽略并记录」，交由调用方告知。
 */
/** TOML 语法解析失败专用错误：让 cli 层能用 instanceof 区分「文件坏」与其他配置错误，
 *  而不靠脆弱的报错文案匹配。message 已含给人看的修复指引。 */
export class TomlParseError extends Error {
  readonly detail: string;
  constructor(detail: string, tomlPath: string, ignoreEnv: string) {
    super(
      `配置文件解析失败：${tomlPath}\n  ${detail}\n` +
        `  该文件未生效，为避免用一份你没写过的配置运行，已停止启动。\n` +
        `  修完可用 step doctor config 校验；若要暂时忽略它以默认配置启动，设 ${ignoreEnv}=1。`,
    );
    this.name = 'TomlParseError';
    this.detail = detail;
  }
}

function loadTomlConfig(): { toml: TomlConfigShape; ignoredBadFile?: IgnoredBadConfigFile } {
  const tomlPath = join(homedir(), '.step-code', 'config.toml');
  if (!existsSync(tomlPath)) return { toml: {} };
  try {
    return { toml: parseToml(readFileSync(tomlPath, 'utf8')) as TomlConfigShape };
  } catch (e) {
    const detail = (e as Error).message;
    if (process.env[IGNORE_BAD_CONFIG_ENV] === '1') {
      return { toml: {}, ignoredBadFile: { path: tomlPath, message: detail } };
    }
    throw new TomlParseError(detail, tomlPath, IGNORE_BAD_CONFIG_ENV);
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 取整并夹到 [min,max]；value 缺失或非法时用 dflt。 */
function clampInt(value: unknown, min: number, max: number, dflt: number): number {
  const n = asNumber(value);
  if (n === undefined) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 夹到 [min,max]（不取整）；value 缺失或非法时用 dflt。 */
function clampFloat(value: unknown, min: number, max: number, dflt: number): number {
  const n = asNumber(value);
  if (n === undefined) return dflt;
  return Math.min(max, Math.max(min, n));
}

/**
 * 从 [subagent] 段解析限制，缺失落到默认、越界被 clamp。纯函数，便于单测。
 * @param raw config.toml 里 [subagent] 段的原始值（可能为 undefined / 非对象）。
 */
export function resolveSubagentLimits(raw: unknown): SubagentLimits {
  const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    maxDepth: clampInt(
      t['max_depth'],
      SUBAGENT_MAX_DEPTH_MIN,
      SUBAGENT_MAX_DEPTH_MAX,
      SUBAGENT_MAX_DEPTH_DEFAULT,
    ),
    maxSteps: clampInt(
      t['max_steps'],
      SUBAGENT_MAX_STEPS_MIN,
      SUBAGENT_MAX_STEPS_MAX,
      SUBAGENT_MAX_STEPS_DEFAULT,
    ),
    maxConcurrent: clampInt(
      t['max_concurrent'],
      SUBAGENT_MAX_CONCURRENT_MIN,
      SUBAGENT_MAX_CONCURRENT_MAX,
      SUBAGENT_MAX_CONCURRENT_DEFAULT,
    ),
    retention: resolveSubagentRetention(t['retention']),
  };
}

/**
 * 从 [subagent.retention] 子段解析留存策略。默认 delete_with_parent=true、max_sessions=0（不限）、
 * ttl_days=0（不过期）——默认不主动删子会话，唯一的自动回收是随主会话级联删除。
 */
export function resolveSubagentRetention(raw: unknown): SubagentRetention {
  const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    deleteWithParent: t['delete_with_parent'] !== false, // 缺省 true；只有显式 false 才关
    maxSessions: clampInt(t['max_sessions'], 0, 100000, 0),
    ttlDays: clampInt(t['ttl_days'], 0, 36500, 0),
  };
}

/**
 * 从 [compaction] 段解析配置，缺失落到默认、越界被 clamp。纯函数，便于单测。
 * @param raw config.toml 里 [compaction] 段的原始值（可能为 undefined / 非对象）。
 */
export function resolveCompactionConfig(raw: unknown): CompactionConfig {
  const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const cfg: CompactionConfig = {
    triggerRatio: clampFloat(
      t['trigger_ratio'],
      COMPACTION_TRIGGER_RATIO_MIN,
      COMPACTION_TRIGGER_RATIO_MAX,
      COMPACTION_TRIGGER_RATIO_DEFAULT,
    ),
    reservedTokens: clampInt(
      t['reserved_tokens'],
      COMPACTION_RESERVED_TOKENS_MIN,
      COMPACTION_RESERVED_TOKENS_MAX,
      COMPACTION_RESERVED_TOKENS_DEFAULT,
    ),
  };
  // 压缩专用模型：未配置时键不进结果对象（下游 toEqual 精确断言依赖此形态）
  const model = asString(t['model']);
  if (model !== undefined) cfg.model = model;
  // 用户原话保真预算：未配置时键不进结果对象，由 compact.ts 的默认常数生效
  const userMax = asNumber(t['user_message_max_tokens']);
  if (userMax !== undefined) {
    cfg.userMessageMaxTokens = Math.min(
      COMPACTION_USER_TOKENS_MAX,
      Math.max(COMPACTION_USER_TOKENS_MIN, Math.round(userMax)),
    );
  }
  const userHead = asNumber(t['user_message_head_tokens']);
  if (userHead !== undefined) {
    // head 不得超过总预算（超了等于把预算全给最早消息，最近意图反而丢光）
    const ceiling = cfg.userMessageMaxTokens ?? COMPACTION_USER_TOKENS_MAX;
    cfg.userMessageHeadTokens = Math.min(ceiling, Math.max(COMPACTION_USER_TOKENS_MIN, Math.round(userHead)));
  }
  return cfg;
}

/**
 * 从 [continuation] 段解析输出截断自动续写配置。
 * 未配置时键不进结果对象，消费方用 ?? 落到默认（默认开启 3 次）。
 */
export function resolveContinuationConfig(raw: unknown): ContinuationConfig | undefined {
  const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const maxAutoContinues = clampInt(
    t['max_auto_continues'],
    0,
    100,
    DEFAULT_MAX_AUTO_CONTINUES,
  );
  if (maxAutoContinues === DEFAULT_MAX_AUTO_CONTINUES) return undefined;
  return { maxAutoContinues };
}

/**
 * 从 config.toml 顶层字符串数组字段解析路径列表（agents_paths / extra_skill_dirs）。纯函数，便于单测。
 * 全部元素是非空字符串才返回数组；未配置、非数组、空数组或含非法元素时返回 undefined（键不进结果对象）。
 */
export function resolveStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.every((x) => typeof x === 'string' && x.length > 0) ? (raw as string[]) : undefined;
}

/**
 * 从 [background] 段解析后台执行配置。三个字段全部可选：
 * 未配置或类型非法时键不进结果对象（下游 toEqual 精确断言依赖此形态），消费方用 ?? 落默认。
 * @param raw config.toml 里 [background] 段的原始值（可能为 undefined / 非对象）。
 */
export function resolveBackgroundConfig(raw: unknown): BackgroundConfig {
  const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const cfg: BackgroundConfig = {};
  const autoBg = t['bash_auto_background_on_timeout'];
  if (typeof autoBg === 'boolean') cfg.bashAutoBackgroundOnTimeout = autoBg;
  const timeout = asNumber(t['bash_task_timeout_s']);
  if (timeout !== undefined) {
    cfg.bashTaskTimeoutS = Math.min(
      BACKGROUND_TASK_TIMEOUT_MAX,
      Math.max(BACKGROUND_TASK_TIMEOUT_MIN, Math.round(timeout)),
    );
  }
  const notify = t['notify_on_complete'];
  if (typeof notify === 'boolean') cfg.notifyOnComplete = notify;
  const notifyTerm = t['notify_terminal'];
  if (typeof notifyTerm === 'boolean') cfg.notifyTerminal = notifyTerm;
  return cfg;
}

/**
 * 解析 [search] 段的联网搜索配置。纯函数，便于单测。
 * raw 非对象 → 返回空对象 {}（所有字段缺省，消费方回退主会话渠道）。
 * 通用段 url/key 与 [search.web]/[search.image] 子段的 url/key 全部可选，
 * 类型非法的键不进结果对象（下游 toEqual 精确断言依赖此形态）。
 * @param raw config.toml 里 [search] 段的原始值（可能为 undefined / 非对象）。
 */
export function resolveSearchConfig(raw: unknown): SearchConfig {
  const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const cfg: SearchConfig = {};
  const url = asString(t['url']);
  if (url !== undefined) cfg.url = url;
  const key = asString(t['key']);
  if (key !== undefined) cfg.key = key;
  for (const sub of ['web', 'image'] as const) {
    const s = t[sub];
    if (typeof s !== 'object' || s === null) continue;
    const st = s as Record<string, unknown>;
    const endpoint: SearchEndpointConfig = {};
    const subUrl = asString(st['url']);
    if (subUrl !== undefined) endpoint.url = subUrl;
    const subKey = asString(st['key']);
    if (subKey !== undefined) endpoint.key = subKey;
    if (endpoint.url !== undefined || endpoint.key !== undefined) cfg[sub] = endpoint;
  }
  return cfg;
}

/**
 * 按「专用段 → 通用段」解析某个搜索工具的生效 endpoint。
 * 返回的 url/key 可能为 undefined，由调用方决定是否回退主会话渠道。
 * @param cfg 已解析的 [search] 配置（可能为 undefined）。
 * @param kind 'web' 内容搜索 / 'image' 文搜图。
 */
export function resolveSearchEndpoint(
  cfg: SearchConfig | undefined,
  kind: 'web' | 'image',
): SearchEndpointConfig {
  const sub = cfg?.[kind];
  return {
    url: sub?.url ?? cfg?.url,
    key: sub?.key ?? cfg?.key,
  };
}

/**
 * 从 [tools.web] 段解析网页结果缓存容量配置。纯函数，便于单测。
 *
 * 三个字段全部可选，全部是数字；未配置或类型非法时键不进结果对象（下游 toEqual 精确断言依赖此形态）。
 * 值取整并 clamp ≥ 0（负数视为 0 = 不限制）。
 *
 * @param raw config.toml 里 [tools.web] 段的原始值（可能为 undefined / 非对象）。
 */
export function resolveWebCacheConfig(raw: unknown): WebCacheConfig | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const t = raw as Record<string, unknown>;
  const maxSize = clampInt(t['max_size'], 0, 1_000_000, 0);
  const maxBytes = clampInt(t['max_bytes'], 0, 1024 * 1024 * 1024, 0);
  const maxEntryBytes = clampInt(t['max_entry_bytes'], 0, 100 * 1024 * 1024, 0);
  if (maxSize === 0 && maxBytes === 0 && maxEntryBytes === 0) return undefined;
  return { maxSize, maxBytes, maxEntryBytes };
}

/**
 * 解析 [thinking.levels] 档位表。纯函数。
 *
 * 只接受 low / medium / high 三个键——档位名会直接作为 effort 值发给服务端，
 * 自造的名字服务端不认。遇到未知键抛配置错误（不静默忽略：静默忽略会让用户
 * 以为自定义档位生效了，而实际请求里根本没有它）。
 *
 * raw 非对象 → undefined（调用方回落内置表）；值非有限数字 → 跳过该档保留内置值；
 * 合法值取整并 clamp ≥1024。缺档不报错，按内置值补齐。
 * @throws 出现 low/medium/high 之外的键。
 */
function parseThinkingLevels(raw: unknown): Partial<Record<ThinkingLevelName, number>> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Partial<Record<ThinkingLevelName, number>> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isThinkingLevelName(name)) {
      throw new Error(
        `[thinking.levels] 不认识档位名 "${name}"（只支持：${THINKING_LEVEL_NAMES.join(' | ')}）。` +
          `档位名会直接作为思考强度值发给服务端，自定义名称不被支持。`,
      );
    }
    const budget = asNumber(value);
    if (budget === undefined) continue;
    out[name] = Math.max(THINKING_BUDGET_MIN, Math.round(budget));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 从 [thinking] 段解析 thinking 请求配置。纯函数，便于单测。
 *
 * enabled 缺省 false（非布尔按 false）。
 * default_level 缺省 {@link DEFAULT_THINKING_LEVEL}（medium），必须是 low|medium|high 之一。
 * levels 逐档合并进内置表（未配的档位保留内置值），只对原生 Anthropic 渠道生效。
 *
 * ## 已删除的两样东西
 *
 * 1. `budget_tokens` 键：见 {@link ThinkingConfig} 注释。出现即报错，不做折算兼容——
 *    静默折算会让用户以为自己填的数字生效了。
 * 2. `budget_tokens` 的正文余量校验：被校验的数字对阶跃渠道根本不会发出，
 *    校验它只提供虚假的安全感。levels 的余量校验保留，因为那些数字在原生
 *    Anthropic 渠道确实会发出（仅 enabled 时校验，未启用不发字段）。
 *
 * @param raw config.toml 里 [thinking] 段的原始值（可能为 undefined / 非对象）。
 * @param maxTokens 最终生效的 max_tokens（余量校验基准）。
 * @throws 出现已删除的 budget_tokens 键；default_level 非法；levels 含未知档位名；
 *         启用时 levels 某档未给正文留出最小余量。
 */
export function resolveMemoryConfig(raw: unknown): MemoryConfig {
  const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return { enabled: t['enabled'] === true };
}

/**
 * 从 [tui] 段解析 TUI 渲染配置。纯函数，便于单测。
 *
 * error_preview_lines 缺省 4，clamp [1, 20]；terminal_title 缺省 true（不进结果对象）。
 * 未配置或类型非法时键不进结果对象（下游 toEqual 精确断言依赖此形态）。
 *
 * 两个字段独立解析：只配了其中一个时另一个保持缺省，段内无任何已知字段才返回 undefined。
 * 注意别改回「首个字段不存在就整段返回 undefined」的写法：那会让只配了
 * terminal_title 的 [tui] 段整体失效（2026-08-15 加 terminal_title 时修正）。
 */
export function resolveTuiConfig(raw: unknown): TuiConfig | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const t = raw as Record<string, unknown>;
  const out: TuiConfig = {};
  if ('error_preview_lines' in t && asNumber(t['error_preview_lines']) !== undefined) {
    out.errorPreviewLines = clampInt(t['error_preview_lines'], 1, 20, 4);
  }
  if ('terminal_title' in t && typeof t['terminal_title'] === 'boolean') {
    out.terminalTitle = t['terminal_title'];
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export function resolveThinkingConfig(raw: unknown, maxTokens: number): ThinkingConfig {
  const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  if (t['budget_tokens'] !== undefined) {
    throw new Error(
      `[thinking] budget_tokens 已移除，请改用 default_level = "low" | "medium" | "high"。` +
        `原因：该数字对阶跃渠道从不发出（三个接口只收档位字符串），仅被用于折算档位，` +
        `且折算阈值固定，改了 [thinking.levels] 就会错档。档位现在是唯一的用户接口。`,
    );
  }

  const userLevels = parseThinkingLevels(t['levels']);
  const levels: Record<ThinkingLevelName, number> = { ...DEFAULT_THINKING_LEVELS, ...userLevels };

  const rawLevel = asString(t['default_level']);
  if (rawLevel !== undefined && !isThinkingLevelName(rawLevel)) {
    throw new Error(
      `[thinking] default_level="${rawLevel}" 不是合法档位（可用：${THINKING_LEVEL_NAMES.join(' | ')}）。`,
    );
  }

  const cfg: ThinkingConfig = {
    enabled: t['enabled'] === true,
    levels,
    defaultLevel: rawLevel ?? DEFAULT_THINKING_LEVEL,
  };

  // 档位余量校验：仅在启用且用户显式配了 levels 时做。
  // 内置默认表不校验——它是兜底数据，且 32000 这类高档值在小 max_tokens 下必然触发，
  // 而该数字对阶跃渠道不会发出，报错会拦住本来能正常跑的配置。
  if (cfg.enabled && userLevels !== undefined) {
    for (const [name, levelBudget] of Object.entries(userLevels) as [ThinkingLevelName, number][]) {
      if (maxTokens - levelBudget < THINKING_TEXT_MARGIN) {
        throw new Error(
          `[thinking.levels] 档位 ${name}=${levelBudget} 未给正文留出最小余量：max_tokens(${maxTokens}) - ${name}(${levelBudget}) < ${THINKING_TEXT_MARGIN}。` +
            `请调大 max_tokens 或调小该档位的 budget（该值在原生 Anthropic 渠道会作为 thinking.budget_tokens 发出，思考会消耗 max_tokens，余量不足时正文可能零输出）。`,
        );
      }
    }
  }
  return cfg;
}

/**
 * 从 [models.<别名>] 段解析模型别名表（渠道与模型分离）。纯函数，便于单测。
 * raw 非对象 → undefined；别名空串或别名值非对象 → 跳过该别名；只读已知字段，
 * 未知字段忽略；没有任何有效别名时返回 undefined（键不进结果对象，
 * 下游 toEqual 精确断言依赖此形态）。
 * @param raw config.toml 里 [models] 段的原始值（可能为 undefined / 非对象）。
 */
export function resolveModels(raw: unknown): Record<string, ModelEntry> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, ModelEntry> = {};
  for (const [alias, value] of Object.entries(raw as Record<string, unknown>)) {
    if (alias === '' || typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const t = value as Record<string, unknown>;
    const entry: ModelEntry = {};
    const provider = asString(t['provider']);
    if (provider !== undefined) entry.provider = provider;
    const model = asString(t['model']);
    if (model !== undefined) entry.model = model;
    const baseUrl = asString(t['base_url']);
    if (baseUrl !== undefined) entry.baseUrl = baseUrl;
    const apiKey = asString(t['api_key']);
    if (apiKey !== undefined) entry.apiKey = apiKey;
    const apiKeyEnv = asString(t['api_key_env']);
    if (apiKeyEnv !== undefined) entry.apiKeyEnv = apiKeyEnv;
    const maxContextSize = asNumber(t['max_context_size']);
    if (maxContextSize !== undefined) entry.maxContextSize = maxContextSize;
    const maxTokens = asNumber(t['max_tokens']);
    if (maxTokens !== undefined) entry.maxTokens = maxTokens;
    // 图片输入上限：下限钳制防误配（edge <256px / bytes <16KB 的图已无读图价值），不设上限封顶。
    const imageMaxEdgePx = asNumber(t['image_max_edge_px']);
    if (imageMaxEdgePx !== undefined) entry.imageMaxEdgePx = Math.max(256, Math.floor(imageMaxEdgePx));
    const imageBudgetBytes = asNumber(t['image_budget_bytes']);
    if (imageBudgetBytes !== undefined) entry.imageBudgetBytes = Math.max(16 * 1024, Math.floor(imageBudgetBytes));
    const videoBudgetBytes = asNumber(t['video_budget_bytes']);
    if (videoBudgetBytes !== undefined) entry.videoBudgetBytes = Math.max(1024 * 1024, Math.floor(videoBudgetBytes));
    const displayName = asString(t['display_name']);
    if (displayName !== undefined) entry.displayName = displayName;
    // capabilities 白名单校验：未知值直接报错，不静默失效。
    // 拼写错误（如 image-in）以前会被原样透传、消费方查不到就当没声明，
    // 表现为「配了但不生效」且无任何提示——这类静默失效极难排查。
    const capabilities = t['capabilities'];
    if (capabilities !== undefined) {
      if (
        !Array.isArray(capabilities) ||
        capabilities.length === 0 ||
        !capabilities.every((c) => typeof c === 'string' && c.length > 0)
      ) {
        throw new Error(
          `[models.${alias}] capabilities 必须是非空字符串数组（可用值：${CAPABILITY_KEYS.join(' | ')}）。`,
        );
      }
      const normalized = (capabilities as string[]).map((c) => c.trim().toLowerCase());
      // "-" 前缀是显式取负（如 "-image_in"），校验时剥前缀再对白名单；孤立的 "-" 视为未知值
      const unknown = normalized.filter((c) => {
        const bare = c.startsWith('-') ? c.slice(1) : c;
        return !(CAPABILITY_KEYS as readonly string[]).includes(bare);
      });
      if (unknown.length > 0) {
        throw new Error(
          `[models.${alias}] capabilities 含未知能力名：${unknown.join(', ')}（可用值：${CAPABILITY_KEYS.join(' | ')}）。`,
        );
      }
      entry.capabilities = normalized;
    }
    const mediaKeepRecent = asNumber(t['media_keep_recent']);
    if (mediaKeepRecent !== undefined) entry.mediaKeepRecent = Math.max(0, Math.floor(mediaKeepRecent));
    out[alias] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 从 [providers.<id>] 段解析渠道表。纯函数，便于单测。
 * raw 非对象 → undefined；id 空串或渠道值非对象 → 跳过该渠道；type 必填且必须是
 * {@link PROVIDER_PRESETS} 的协议 key，缺失或非法 → 该渠道无效跳过；base_url/api_key/api_key_env 可选。
 * 没有任何有效渠道时返回 undefined（键不进结果对象，下游 toEqual 精确断言依赖此形态）。
 * @param raw config.toml 里 [providers] 段的原始值（可能为 undefined / 非对象）。
 */
export function resolveProviders(raw: unknown): Record<string, ProviderEntry> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, ProviderEntry> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (id === '' || typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const t = value as Record<string, unknown>;
    const type = asString(t['type']);
    if (type === undefined || PROVIDER_PRESETS[type] === undefined) continue;
    const entry: ProviderEntry = { type };
    const baseUrl = asString(t['base_url']);
    if (baseUrl !== undefined) entry.baseUrl = baseUrl;
    const apiKey = asString(t['api_key']);
    if (apiKey !== undefined) entry.apiKey = apiKey;
    const apiKeyEnv = asString(t['api_key_env']);
    if (apiKeyEnv !== undefined) entry.apiKeyEnv = apiKeyEnv;
    out[id] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 从 [[hooks]] 扁平数组解析用户 hooks。纯函数，便于单测。
 * raw 非数组 → undefined；逐条校验：event 必须在合法事件集（{@link HOOK_EVENTS}）内、
 * command 必须是非空字符串，否则该条跳过；matcher 可选但必须是合法正则（非法整条跳过）；
 * timeout 可选，默认 30 秒，clamp [1,600]。全部无效时返回 undefined（键不进结果对象，
 * 下游 toEqual 精确断言依赖此形态）。
 * @param raw config.toml 里 hooks 的原始值（smol-toml 把 [[hooks]] 解析成对象数组）。
 */
export function resolveHooks(raw: unknown): HookConfigEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: HookConfigEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const t = item as Record<string, unknown>;
    const event = asString(t['event']);
    if (event === undefined || !(HOOK_EVENTS as readonly string[]).includes(event)) continue;
    const command = asString(t['command']);
    if (command === undefined) continue;
    const entry: HookConfigEntry = {
      event: event as HookEventName,
      command,
      timeout: clampInt(t['timeout'], HOOK_TIMEOUT_MIN, HOOK_TIMEOUT_MAX, HOOK_TIMEOUT_DEFAULT),
    };
    const matcher = asString(t['matcher']);
    if (matcher !== undefined) {
      try {
        entry.matcher = new RegExp(matcher);
      } catch {
        continue; // 非法正则：整条 hook 跳过
      }
    }
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 按别名展开模型配置：name 命中 config.models 时返回合并后的新配置，未命中返回 null。
 *
 * entry.provider 的合法指向：
 * 1. 自定义渠道 id（config.providers）：结果 provider = 渠道 type（协议 key），
 *    baseUrl 取自渠道，渠道缺省回落 entry → 顶层；渠道与 entry 都没给 baseUrl
 *    且 type 与顶层 provider 不同时，回落 type 预设的 baseUrl。
 * 2. 缺省：继承顶层 provider（原有行为）。
 * 显式指向内置预设名（stepfun/anthropic 等）或未声明的渠道 id 一律视为无效别名，
 * 返回 null——内置预设只是零配置默认策略的载体，不是别名可引用的渠道。
 * entry 其余字段覆盖顶层；model 缺省 = 别名本身。纯函数，不改原对象
 * （env(x) 表示 x 非空时读 process.env[x]，空串视为未设置）。
 *
 * apiKey 回落链（多渠道独立密钥设计，config.apiKey 是隐式渠道/环境变量解析结果的
 * 最后一级回落）：
 * - 渠道分支：渠道 apiKey → 渠道 apiKeyEnv 指向的 env → 渠道 type 的惯例 env
 *   （见 {@link conventionalApiKeyEnvVar}）→ entry.apiKey → entry.apiKeyEnv 指向的 env → config.apiKey。
 * - 继承分支：entry.apiKey → entry.apiKeyEnv 指向的 env → 顶层 provider
 *   的惯例 env → config.apiKey。
 * 全部缺失时 apiKey 为 undefined，由 provider 工厂在构造前抛带指引的错误。
 * 注意：config.apiKey 来自环境变量，作为最后回落意味着「渠道没配 key 时会把它发给该渠道
 * 端点」；跨服务商混用时务必给每个渠道单独配 apiKey 或 apiKeyEnv。
 */
export function resolveModelEntry(config: StepCodeConfig, name: string): StepCodeConfig | null {
  const entry = config.models?.[name];
  if (entry === undefined) return null;

  let provider: string;
  let baseUrl: string;
  let apiKey: string | undefined;
  const channel = entry.provider !== undefined ? config.providers?.[entry.provider] : undefined;
  if (channel !== undefined) {
    // 自定义渠道：协议实现由渠道 type 决定；端点渠道优先、回落 entry → 顶层；密钥走渠道分支回落链
    provider = channel.type;
    // 若该 key 实为全局回落（渠道/entry 都没配 key），校验渠道 type 与顶层 provider type 一致——
    // 否则会把给另一服务商的全局 key 发到本渠道端点（跨渠道泄露）。一致才允许借用，不一致直接报错。
    const fellBackToGlobal =
      channel.apiKey === undefined &&
      envValue(channel.apiKeyEnv) === undefined &&
      envValue(conventionalApiKeyEnvVar(channel.type)) === undefined &&
      entry.apiKey === undefined &&
      envValue(entry.apiKeyEnv) === undefined;
    if (fellBackToGlobal && config.apiKey !== undefined && provider !== config.provider) {
      // config.apiKey 有两种归属，跨渠道借用的危险性不同，分开处理：
      // - 若它等于「顶层 provider 的惯例 env 值」→ 该 key 绑死顶层 type（如顶层 anthropic 的
      //   ANTHROPIC_API_KEY），借给别的 type 渠道 = 把 A 服务商的 key 发到 B 端点 = 泄露，拒绝；
      // - 否则（通用 STEP_CODE_API_KEY 或直接赋值的 key）→ 不绑单一 type，放行。
      const conventionalKey = envValue(conventionalApiKeyEnvVar(config.provider));
      const boundToTopType = conventionalKey !== undefined && conventionalKey === config.apiKey;
      if (boundToTopType) {
        throw new Error(
          t('config.apiKey.channelMismatch', {
            channel: entry.provider ?? '',
            channelType: provider,
            topProvider: config.provider,
          }),
        );
      }
    }
    apiKey =
      channel.apiKey ??
      envValue(channel.apiKeyEnv) ??
      envValue(conventionalApiKeyEnvVar(channel.type)) ??
      entry.apiKey ??
      envValue(entry.apiKeyEnv) ??
      config.apiKey;
    baseUrl = channel.baseUrl ?? entry.baseUrl ?? config.baseUrl;
    if (channel.baseUrl === undefined && entry.baseUrl === undefined && provider !== config.provider) {
      baseUrl = PROVIDER_PRESETS[provider]?.baseUrl ?? config.baseUrl;
    }
  } else {
    if (entry.provider !== undefined) {
      // 显式指向了未声明的渠道 id 或内置预设名：均视为无效别名
      //（内置预设只是零配置默认策略的载体，不是别名可引用的渠道）
      return null;
    }
    // 继承分支：缺省继承顶层 provider
    provider = config.provider;
    apiKey =
      entry.apiKey ??
      envValue(entry.apiKeyEnv) ??
      envValue(conventionalApiKeyEnvVar(provider)) ??
      config.apiKey;
    baseUrl = entry.baseUrl ?? config.baseUrl;
  }
  return {
    ...config,
    provider,
    apiKey,
    baseUrl,
    model: entry.model ?? name,
    maxContextSize: entry.maxContextSize ?? config.maxContextSize,
    maxTokens: entry.maxTokens ?? config.maxTokens,
    // capabilities 只在命中别名时带入（别名未声明则 undefined，覆盖掉 spread 来的旧值）；
    // 裸模型 / 未命中别名（返回 null 的路径）不带
    capabilities: entry.capabilities,
    // 图片输入上限同 capabilities 语义：只在命中别名且声明时带入，裸模型/未声明为 undefined
    imageMaxEdgePx: entry.imageMaxEdgePx,
    imageBudgetBytes: entry.imageBudgetBytes,
    // 视频交付预算同图片上限语义：只在命中别名且声明时带入
    videoBudgetBytes: entry.videoBudgetBytes,
    // mediaKeepRecent 按别名覆盖，未声明继承顶层（再缺省由工厂/use 点补 10）
    mediaKeepRecentImages: entry.mediaKeepRecent ?? config.mediaKeepRecentImages,
  };
}

/** 命令行覆盖项：优先级最高，在预设填充前应用。 */
export interface ConfigOverrides {
  provider?: string;
  model?: string;
}

/**
 * 解析配置，优先级：命令行覆盖 > 环境变量 > config.toml > provider 预设 > 内置默认。
 *
 * provider：`STEP_CODE_PROVIDER` > TOML `provider` > 默认 'stepfun'（overrides.provider 最高优先）。
 * apiKey：隐式渠道只认 `STEP_CODE_API_KEY`；anthropic/openai 协议另认各自的惯例环境变量
 * （见 {@link conventionalApiKeyEnvVar}）。config.toml 顶层不再支持 `api_key`；
 * 配置文件里的 key 只能配在 `[providers.<id>]` 渠道或 `[models.<别名>]` 上。
 * 不再强制：全部缺失时 apiKey 为 undefined 进 cfg，由 provider 工厂在构造前抛带指引的错误
 * （factory.missingApiKey）；启动展开别名时还会经 {@link resolveModelEntry} 的渠道/别名回落链再解析一次。
 * baseUrl / model：用户显式配置（env/toml/override）永远优先；未配时用所选 provider 预设默认。
 */
export function loadConfig(
  cwd: string = process.cwd(),
  overrides: ConfigOverrides = {},
  onDiagnostics?: ConfigDiagnosticsSink,
): StepCodeConfig {
  loadDotEnv(cwd);
  const { toml, ignoredBadFile } = loadTomlConfig();
  if (onDiagnostics !== undefined) {
    const diagnostics: ConfigLoadDiagnostics = { rawToml: toml as Record<string, unknown> };
    if (ignoredBadFile !== undefined) diagnostics.ignoredBadFile = ignoredBadFile;
    onDiagnostics(diagnostics);
  }

  const provider =
    overrides.provider ??
    process.env['STEP_CODE_PROVIDER'] ??
    asString(toml.provider) ??
    DEFAULT_PROVIDER;
  const preset: ProviderPreset = PROVIDER_PRESETS[provider] ?? { protocol: 'anthropic', sendThinking: false };

  // apiKey 只从环境变量取：key 是端点凭据，配置文件里它只能长在 [providers.<id>] 渠道上
  //（顶层没有渠道归属、不知该发给谁）。这里的两级是「隐式渠道」的凭据来源——
  // 不配任何 [providers] 时，内置预设充当渠道，key 由环境变量提供，保证零配置可用。
  // 命中 [models.<别名>] 时会经 resolveModelEntry 的渠道/别名链重新解析，此值仅作最后回落。
  const apiKey = envValue('STEP_CODE_API_KEY') ?? envValue(conventionalApiKeyEnvVar(provider));

  // 用户显式配置（override > env > toml）永远优先；未配才落 provider 预设默认。
  const model =
    overrides.model ??
    process.env['STEP_CODE_MODEL'] ??
    asString(toml.model) ??
    preset.model ??
    '';
  const baseUrl =
    process.env['STEP_CODE_BASE_URL'] ??
    asString(toml.base_url) ??
    preset.baseUrl ??
    DEFAULT_BASE_URL;

  const cfg: StepCodeConfig = {
    provider,
    apiKey,
    baseUrl,
    model,
    maxContextSize: asNumber(toml.max_context_size) ?? DEFAULT_MAX_CONTEXT,
    maxTokens: asNumber(toml.max_tokens) ?? DEFAULT_MAX_TOKENS,
    subagent: resolveSubagentLimits(toml.subagent),
    compaction: resolveCompactionConfig(toml.compaction),
    continuation: resolveContinuationConfig(toml.continuation),
    background: resolveBackgroundConfig(toml.background),
    language: resolveLanguage(toml.language),
  };
  // thinking 请求配置：余量校验以最终生效的 maxTokens 为基准（启用且余量不足时抛配置错误）
  cfg.thinking = resolveThinkingConfig(toml.thinking, cfg.maxTokens);
  // memory 观察池开关：默认关闭；恒赋值（默认 { enabled: false }）
  cfg.memory = resolveMemoryConfig(toml.memory);
  // TUI 渲染配置：未配置时键不进结果对象，消费方用 ?? 落默认
  const tui = resolveTuiConfig(toml.tui);
  if (tui !== undefined) cfg.tui = tui;
  // 联网搜索配置：所有字段可选，缺省时消费方缺省回退主会话渠道（零配置默认策略）
  cfg.search = resolveSearchConfig(toml.search);
  // 网页结果缓存容量：三个维度全部可选，未配置时使用内置默认值
  const webCache = resolveWebCacheConfig(toml.tools);
  if (webCache !== undefined) cfg.web = webCache;
  // 自定义加载路径：未配置或非法时键不进结果对象（下游 toEqual 精确断言依赖此形态）
  const agentsPaths = resolveStringArray(toml.agents_paths);
  if (agentsPaths !== undefined) cfg.agentsPaths = agentsPaths;
  const agentsMdMaxBytes = asNumber(toml.agents_md_max_bytes);
  if (agentsMdMaxBytes !== undefined) cfg.agentsMdMaxBytes = agentsMdMaxBytes;
  const mediaKeepRecent = asNumber(toml.media_keep_recent);
  if (mediaKeepRecent !== undefined) cfg.mediaKeepRecentImages = Math.max(0, Math.floor(mediaKeepRecent));
  const extraSkillDirs = resolveStringArray(toml.extra_skill_dirs);
  if (extraSkillDirs !== undefined) cfg.extraSkillDirs = extraSkillDirs;
  const disabledSkills = resolveStringArray(toml.disabled_skills);
  if (disabledSkills !== undefined) cfg.disabledSkills = disabledSkills;
  const skillListingBudget = asNumber(toml.skill_listing_budget);
  if (skillListingBudget !== undefined && skillListingBudget > 0) cfg.skillListingBudget = Math.floor(skillListingBudget);
  // 权限模式默认值：未配置时键不进结果对象；非法值抛配置错误（安全相关，不静默吞）
  const permissionMode = resolvePermissionMode(toml.permission_mode);
  if (permissionMode !== undefined) cfg.permissionMode = permissionMode;
  // 代理 URL：未配置时键不进结果对象；形态非法抛配置错误（doctor 复用抛错路径 exit 1）
  const proxy = resolveProxy(toml.proxy);
  if (proxy !== undefined) cfg.proxy = proxy;
  // 模型别名表：未配置或全部无效时键不进结果对象（下游 toEqual 精确断言依赖此形态）
  const models = resolveModels(toml.models);
  if (models !== undefined) cfg.models = models;
  // 渠道表：未配置或全部无效时键不进结果对象（下游 toEqual 精确断言依赖此形态）
  const providers = resolveProviders(toml.providers);
  if (providers !== undefined) cfg.providers = providers;
  // 用户可配置 hooks：未配置或全部无效时键不进结果对象（下游 toEqual 精确断言依赖此形态）
  const hooks = resolveHooks(toml.hooks);
  if (hooks !== undefined) cfg.hooks = hooks;
  // 最终 model 命中别名时展开一次（--model 别名 / env / toml 顶层 model 写别名均可工作）
  const resolved = resolveModelEntry(cfg, cfg.model);
  if (resolved !== null) {
    // 保留原始别名指针：App 侧需要知道用户选的是哪个别名（多别名指向同一真实 id 时消歧）
    resolved.modelAlias = cfg.model;
    return resolved;
  }
  return cfg;
}

/**
 * 从 config.toml 顶层 language 字段解析界面语言，缺失或非法落到 'zh'。纯函数，便于单测。
 * @param raw config.toml 里 language 的原始值（可能为 undefined / 非字符串）。
 */
export function resolveLanguage(raw: unknown): Locale {
  return raw === 'en' || raw === 'zh' ? raw : 'zh';
}

/**
 * 从 config.toml 顶层 permission_mode 字段解析权限模式默认值。纯函数，便于单测。
 * 未配置返回 undefined（键不进结果对象，缺省 manual 由消费方落）；合法值原样返回；
 * 非法值抛配置错误（对齐 [thinking] default_level 的校验口径——权限默认值是安全相关配置，
 * 写错不能静默吞掉，doctor 复用本抛错路径 exit 1）。
 * @param raw config.toml 里 permission_mode 的原始值（可能为 undefined / 非字符串）。
 * @throws 值存在但不是 'manual' | 'auto' | 'yolo'。
 */
export function resolvePermissionMode(raw: unknown): PermissionMode | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'manual' || raw === 'auto' || raw === 'yolo') return raw;
  throw new Error(`permission_mode=${JSON.stringify(raw)} 非法（可用：manual | auto | yolo）。`);
}

/**
 * 从 config.toml 顶层 proxy 字段解析代理 URL。纯函数，便于单测。
 * 未配置返回 undefined（键不进结果对象，语义为直连）；合法值原样返回；
 * 非法值抛配置错误（doctor 复用本抛错路径 exit 1）。
 * 只接受 http:// 或 https:// 开头的 URL（socks 等其他 scheme 暂不展开）。
 */
export function resolveProxy(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new Error(`proxy=${JSON.stringify(raw)} 非法（应为 http(s):// 代理 URL）。`);
  const v = raw.trim();
  if (v === '') return undefined;
  if (!/^https?:\/\//i.test(v)) {
    throw new Error(`proxy=${JSON.stringify(raw)} 非法（只接受 http:// 或 https:// 开头的代理 URL）。`);
  }
  return v;
}

/**
 * 改写/追加 ~/.step-code/config.toml 的 `[providers.<providerName>]` section 内的一个字段。
 * 只动目标那一行，其余内容（注释、其他字段、其他 section）原样保留，不做整文件重序列化。
 * 文件不存在时创建最小内容。保留原文件的换行风格（CRLF/LF）。
 *
 * TOML section 边界：从 `[providers.<name>]` 头到下一个 `[` 开头行为止，是此 section 的管辖范围。
 * section 不存在时在文件末尾追加 `[providers.<name>]\nkey = "value"\n`。
 */
export function saveProviderKey(providerName: string, key: 'base_url' | 'api_key', value: string): void {
  // 防御：base_url / api_key 是单行字段，任何来源（粘贴折行、程序拼接）混入的换行
  // 若写进 TOML 字符串即成非法控制字符、毁掉整文件解析。写入前一律剥掉。
  const safeValue = value.replace(/[\r\n]+/g, '');
  const dir = join(homedir(), '.step-code');
  const tomlPath = join(dir, 'config.toml');
  const sectionHeader = `[providers.${providerName}]`;
  const line = `${key} = "${safeValue}"`;
  const text = existsSync(tomlPath) ? readFileSync(tomlPath, 'utf8') : '';
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/) || [];

  // 先定位目标 section 的起止行索引
  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === sectionHeader) {
      sectionStart = i;
      // 从 section 头向下找下一个 section 边界
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trim().startsWith('[')) {
          sectionEnd = j;
          break;
        }
      }
      break;
    }
  }

  const out = [...lines];
  if (sectionStart === -1) {
    // section 不存在：在文件末尾追加。先清理尾部空行再追加块。
    while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
    out.push('', sectionHeader, line, '');
  } else {
    // section 存在：在 [sectionStart, sectionEnd) 区间内改/插字段
    const keyPattern = new RegExp(`^${key.replace(/[.*+?^=!:{}()|[\]/\\]/g, (m) => `\\${m}`)}\\s*=`);
    let written = false;
    // 收集 section 内的行（保留注释和空行，只改目标键）
    for (let i = sectionStart + 1; i < sectionEnd; i++) {
      const trimmed = out[i]!.trim();
      if (!written && keyPattern.test(trimmed) && !trimmed.startsWith('#')) {
        out[i] = `  ${line}`;
        written = true;
      }
    }
    if (!written) {
      // 在 section 头部后第一个位置插入（紧跟 section 头下方）
      out.splice(sectionStart + 1, 0, `  ${line}`);
    }
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(tomlPath, out.join(newline), 'utf8');
}

/**
 * 改写/追加 ~/.step-code/config.toml 的 `[models.<alias>]` section 内的字段。
 * 只动目标那一行，其余内容（注释、其他字段、其他 section）原样保留，不做整文件重序列化。
 * 文件不存在时创建最小内容。保留原文件的换行风格（CRLF/LF）。
 *
 * TOML section 边界：从 `[models.<alias>]` 头到下一个 `[` 开头行为止，是此 section 的管辖范围。
 * section 不存在时在文件末尾追加 `[models.<alias>]\nkey = "value"\n`。
 *
 * 为什么单独写这个函数而不复用 saveProviderKey：providers 与 models 是两个独立段，
 * 且 models 段字段名（provider / model / max_context_size / display_name）与 providers 段
 * （base_url / api_key）完全不同；另外首次运行引导需要把「刚选的渠道」与「刚选的模型」
 * 显式绑定写入 [models.<alias>]，否则顶层 model 别名无法解析到正确渠道，正是本次修复的设计缺陷。
 */
export function saveModelAlias(
  alias: string,
  fields: Record<string, string | number>,
): void {
  const dir = join(homedir(), '.step-code');
  const tomlPath = join(dir, 'config.toml');
  const sectionHeader = `[models.${alias}]`;
  const text = existsSync(tomlPath) ? readFileSync(tomlPath, 'utf8') : '';
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/) || [];

  // 先定位目标 section 的起止行索引
  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === sectionHeader) {
      sectionStart = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trim().startsWith('[')) {
          sectionEnd = j;
          break;
        }
      }
      break;
    }
  }

  const out = [...lines];
  if (sectionStart === -1) {
    while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
    out.push('', sectionHeader);
    for (const [key, value] of Object.entries(fields)) {
      const safeValue =
        typeof value === 'number' ? String(value) : String(value).replace(/[\r\n]+/g, '');
      out.push(`  ${key} = ${typeof value === 'number' ? safeValue : `"${safeValue}"`}`);
    }
    out.push('');
  } else {
    for (const [key, value] of Object.entries(fields)) {
      const safeValue =
        typeof value === 'number' ? String(value) : String(value).replace(/[\r\n]+/g, '');
      const targetLine = `  ${key} = ${typeof value === 'number' ? safeValue : `"${safeValue}"`}`;
      const keyPattern = new RegExp(
        `^${key.replace(/[.*+?^=!:{}()|[\]/\\]/g, (m) => `\\${m}`)}\\s*=`,
      );
      let written = false;
      for (let i = sectionStart + 1; i < sectionEnd; i++) {
        const trimmed = out[i]!.trim();
        if (!written && keyPattern.test(trimmed) && !trimmed.startsWith('#')) {
          out[i] = targetLine;
          written = true;
        }
      }
      if (!written) {
        out.splice(sectionStart + 1, 0, targetLine);
      }
    }
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(tomlPath, out.join(newline), 'utf8');
}

/**
 * 改写/追加 ~/.step-code/config.toml 的一个顶层字符串键：只动目标那一行，
 * 其余内容（注释、其他字段、[section]）原样保留，不做整文件重序列化。
 * 文件不存在时创建最小内容。保留原文件的换行风格（CRLF/LF）。
 *
 * 只在顶层区间（第一个 `[section]` 头之前）改/插——插到 section 之后会变成段内字段，
 * 语义完全不同。重复的顶层同名键只留第一条（防御手工编辑出的重复）。
 * 注释掉的行（`# key = ...`）不匹配，会在其上方新插一行，旧注释保留。
 */
export function saveTopLevelKey(key: string, value: string): void {
  const dir = join(homedir(), '.step-code');
  const tomlPath = join(dir, 'config.toml');
  const line = `${key} = "${value}"`;
  const text = existsSync(tomlPath) ? readFileSync(tomlPath, 'utf8') : '';
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const keyPattern = new RegExp(`^${key.replace(/[.*+?^=!:{}()|[\]/\\]/g, (m) => `\\${m}`)}\\s*=`);

  const out: string[] = [];
  let inTopLevel = true;
  let written = false;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (inTopLevel && trimmed.startsWith('[')) inTopLevel = false;
    if (inTopLevel && keyPattern.test(trimmed)) {
      if (!written) {
        out.push(line);
        written = true;
      }
      continue;
    }
    out.push(rawLine);
  }
  if (!written) {
    // 有 section 时必须插到第一个 section 之前，否则落进 section 里成了段内字段
    const sectionIdx = out.findIndex((l) => l.trim().startsWith('['));
    if (sectionIdx === -1) {
      while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
      out.push(line, '');
    } else {
      out.splice(sectionIdx, 0, line);
    }
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(tomlPath, out.join(newline), 'utf8');
}

/**
 * 把界面语言写回 ~/.step-code/config.toml 的顶层 `language`。
 */
export function saveLanguage(l: Locale): void {
  saveTopLevelKey('language', l);
}

/**
 * 把默认模型指针写回 ~/.step-code/config.toml 的顶层 `model`，使下次启动的新会话沿用
 * 用户最后一次 /model 选择，不必手改配置文件。
 *
 * 写入的是**别名**（`[models.<别名>]` 的 key）而非解析后的真实模型 id：别名承载
 * 渠道 + 模型 + max_context_size + displayName 一整组绑定，写真实 id 会丢掉这组绑定，
 * 下次启动 resolveModelEntry 查不到别名，上下文窗口会回落到顶层默认值（压缩判定随之失准）。
 *
 * 与会话级 `SessionData.model` 分工不同：后者存真实 id 供 provider 重建，两者不要统一。
 * 幂等：与当前值相同则不写（省掉无谓的文件写入，缩小与其他 step 进程的写竞争窗口）。
 */
export function saveDefaultModel(modelOrAlias: string, current?: string): void {
  if (current !== undefined && current === modelOrAlias) return;
  saveTopLevelKey('model', modelOrAlias);
}

/**
 * 改写/追加 ~/.step-code/config.toml 指定 TOML section 内的一个字段。
 * 只动目标那一行，其余内容（注释、其他字段、其他 section）原样保留。
 * 文件不存在时创建最小内容。保留原文件的换行风格（CRLF/LF）。
 *
 * section 不存在时在文件末尾追加 `[section]\nkey = value\n`；
 * section 已存在时在 section 范围内改/插字段，插在 section 头正下方。
 * 注释掉的行（`# key = ...`）不匹配，会在其上方新插一行，旧注释保留。
 * 数字值不加引号（TOML 原生数字），字符串值加引号。
 *
 * @param sectionHeader section 全名（含方括号），如 `[thinking]` / `[providers.foo]`
 * @param key 字段名
 * @param value 字段值（数字或字符串）
 */
function saveSectionKey(sectionHeader: string, key: string, value: string | number | boolean): void {
  const dir = join(homedir(), '.step-code');
  const tomlPath = join(dir, 'config.toml');
  const safeValue =
    typeof value === 'number' ? String(value) : String(value).replace(/[\r\n]+/g, '');
  // boolean 走 TOML 裸值（true/false），字符串加引号，数字原样
  const line = `  ${key} = ${typeof value === 'string' ? `"${safeValue}"` : safeValue}`;
  const text = existsSync(tomlPath) ? readFileSync(tomlPath, 'utf8') : '';
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/) || [];

  // 先定位目标 section 的起止行索引
  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === sectionHeader) {
      sectionStart = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trim().startsWith('[')) {
          sectionEnd = j;
          break;
        }
      }
      break;
    }
  }

  const out = [...lines];
  if (sectionStart === -1) {
    // section 不存在：在文件末尾追加
    while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
    out.push('', sectionHeader, line, '');
  } else {
    const keyPattern = new RegExp(`^${key.replace(/[.*+?^=!:{}()|[\]/\\]/g, (m) => `\\${m}`)}\\s*=`);
    let written = false;
    for (let i = sectionStart + 1; i < sectionEnd; i++) {
      const trimmed = out[i]!.trim();
      if (!written && keyPattern.test(trimmed) && !trimmed.startsWith('#')) {
        out[i] = line;
        written = true;
      }
    }
    if (!written) {
      out.splice(sectionStart + 1, 0, line);
    }
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(tomlPath, out.join(newline), 'utf8');
}

/**
 * 把默认思考档位写回 ~/.step-code/config.toml 的 [thinking] default_level。
 *
 * 'off' 不写入——off 是会话级临时关闭，不应污染全局默认。
 * 幂等：与当前值相同则不写（省掉无谓的文件写入）。
 * 失败只提示不阻断——本次切换已在内存生效，配置写入只影响下次启动。
 *
 * @param level 合法档位名（low / medium / high）；'off' 被静默忽略
 */
/** memory 开关写回 config.toml 的 [memory] enabled（TOML 裸布尔值）。 */
export function saveMemoryEnabled(enabled: boolean): void {
  saveSectionKey('[memory]', 'enabled', enabled);
}

export function saveDefaultThinkingLevel(level: ThinkingLevelName | 'off'): void {
  if (level === 'off') return;
  const current = (() => {
    try {
      const { toml } = loadTomlConfig();
      const raw = (toml as Record<string, unknown>)['thinking'];
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        const val = (raw as Record<string, unknown>)['default_level'];
        if (typeof val === 'string' && isThinkingLevelName(val)) return val;
      }
    } catch {
      // 配置文件不存在或解析失败：继续写入（create-or-update 语义）
    }
    return undefined;
  })();
  if (current !== undefined && current === level) return;
  saveSectionKey('[thinking]', 'default_level', level);
}

/**
 * 把默认服务商标识写回 ~/.step-code/config.toml 的顶层 `provider`。
 *
 * 幂等：与当前值相同则不写（省掉无谓的文件写入）。
 * 失败只提示不阻断——本次切换已在内存生效，配置写入只影响下次启动。
 *
 * @param provider 服务商预设名（如 'stepfun' / 'anthropic' / 'openai'）
 * @param current 当前顶层 provider 值（用于幂等判断，缺省时不判断）
 */
export function saveDefaultProvider(provider: string, current?: string): void {
  if (current !== undefined && current === provider) return;
  saveTopLevelKey('provider', provider);
}
