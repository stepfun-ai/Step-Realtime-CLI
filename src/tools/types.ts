import { z } from 'zod';
import type { RunSubagentFn } from '../agent/subagent/types.js';
import type { ToolAccess } from './access.js';

/** TODO 条目（与 todo_list 工具一致）。 */
export interface TodoItem {
  title: string;
  status: 'pending' | 'in_progress' | 'done';
}

/** TODO store：独立存储，不占对话历史。 */
export interface TodoStore {
  items: TodoItem[];
}

/** 工具执行上下文。 */
export interface ToolContext {
  /** 当前工作目录，所有相对路径以此为基准。 */
  cwd: string;
  /** 中断信号。长时间运行的工具应尽力监听它以支持用户取消。 */
  signal?: AbortSignal;
  /** StepFun API key，供联网搜索等需要调用平台接口的工具使用。 */
  apiKey?: string;
  /** StepFun API base_url（不带 /v1），供联网搜索拼接端点。 */
  baseUrl?: string;
  /**
   * 联网搜索独立配置（[search] 段，组合根注入）。web_search / web_image_search 按
   * 「专用段 → 通用段 → 主会话 apiKey/baseUrl」的优先级解析 endpoint；缺失时仅走主会话渠道兜底。
   */
  searchConfig?: import('../config/config.js').SearchConfig;
  /** 当前 agent 深度：主 agent = 0（缺省视为 0），子 agent = 1。用于递归防护。 */
  depth?: number;
  /** 子 agent 运行器（由组合根注入）。缺失表示当前上下文不支持派生子 agent。 */
  runSubagent?: RunSubagentFn;
  /** TODO store（共享引用，工具直接改、组合根持久化）。缺失表示当前上下文不支持任务清单。 */
  todos?: TodoStore;
  /** 后台任务管理器（组合根注入）。缺失表示当前上下文不支持后台任务。 */
  background?: import('../agent/background/manager.js').BackgroundManager;
  /** bash 前台超时后自动转后台（来自 [background].bash_auto_background_on_timeout）。缺省视为 true；false 保持超时即杀。 */
  bashAutoBackgroundOnTimeout?: boolean;
  /** skill 注册表（组合根注入，供 skill 激活工具查询）。缺失表示当前上下文不支持技能。 */
  skills?: import('../skill/registry.js').SkillRegistry;
  /** goal 管理器（组合根注入，主 agent 自主目标）。缺失表示当前上下文不支持 goal。 */
  goal?: import('../agent/goal/mode.js').GoalMode;
  /** team 团队模式状态（组合根注入）。缺失表示当前上下文不支持 team。 */
  team?: import('../agent/team/mode.js').TeamMode;
  /** cron 调度器（组合根注入，定时任务）。缺失表示当前上下文不支持定时任务。 */
  cron?: import('../agent/cron/scheduler.js').CronScheduler;
  /** tool_search 外部工具注册表（组合根注入，懒加载）。缺失表示无可搜索外部工具。 */
  toolSearch?: import('./toolSearch.js').ToolSearchRegistry;
  /** 引用式附件存储（组合根注入）：发 provider 前把消息里的 stepref 图片还原成 base64。缺失表示不做 rehydrate。 */
  attachments?: import('../session/attachments.js').AttachmentStore;
  /** 向用户提问回调（组合根注入，前台阻塞收集答案）。缺失表示当前上下文不支持提问（如子 agent 无 UI）。 */
  askUser?(req: import('./askUser.js').AskUserRequest): Promise<import('./askUser.js').QuestionAnswers>;
  /** 并行子 agent 与编排原语的并发上限（来自 config.subagent.maxConcurrent）。 */
  subagentMaxConcurrent?: number;
  /** 编排步骤进度回调（组合根注入，供 TUI 步骤面板实时更新）。缺失表示无 UI 消费方。 */
  onWorkflowStep?: (info: import('../agent/events.js').WorkflowStepEvent) => void;
  /**
   * 当前模型的能力标记（来自模型别名 [models.<别名>] capabilities，如 image_in）。
   * 裸模型 / 未命中别名时为 undefined。供 read_media 等多模态工具做能力门控。
   */
  capabilities?: readonly string[];
  /** 当前模型的图片输入长边上限（像素，来自别名 image_max_edge_px）。缺省由 read_media 回退全局保守值 1568。 */
  imageMaxEdgePx?: number;
  /** 当前模型的单图交付字节预算（来自别名 image_budget_bytes）。缺省由 read_media 回退 256KB。 */
  imageBudgetBytes?: number;
  /** 当前模型的单视频交付字节预算（来自别名 video_budget_bytes）。缺省由 read_media 回退 32MB。 */
  videoBudgetBytes?: number;
}

/** 工具结果附带的图片载荷（如 read_media 读图），回灌时内嵌进 tool_result 的 content 块数组。 */
export interface ToolResultImage {
  mediaType: string;
  base64: string;
}

/** 工具结果附带的视频载荷（如 read_media 读视频），回灌时内嵌进 tool_result 的 content 块数组。 */
export interface ToolResultVideo {
  mediaType: string;
  base64: string;
}

/** 工具执行结果。 */
export interface ToolResult {
  /** 返回给模型的文本内容。images 非空时作为块数组的首个 text 块回灌。 */
  content: string;
  /** 是否为错误结果（会以 is_error 回灌给模型）。 */
  isError: boolean;
  /** 导致失败的原始错误对象（内部元数据，不进 wire）：调度层据此识别 429 做重排队。 */
  cause?: unknown;
  /**
   * 返回给模型的图片（可选）。非空时 tool_result 的 content 从纯文本升格为块数组
   * [{type:'text'}, ...imageBlocks]（Anthropic.ToolResultBlockParam.content 官方支持内嵌 image）。
   * 不参与 tool_end 事件（UI 只回 text 部分）。
   */
  images?: ToolResultImage[];
  /**
   * 返回给模型的视频（可选）。与 images 同通道升格进 tool_result 块数组；
   * Anthropic 官方类型无 video 块，wire 形态由各协议适配层负责（openai → video_url，
   * anthropic → 同形状 video 扩展块），能力不支持时由投影层换占位文本。
   */
  videos?: ToolResultVideo[];
  /** 结构化错误码（可选）。TUI / 协议层可按 code 区分错误类型，不再只靠 content 文本推断。 */
  errorCode?: string;
}

/**
 * 工具定义。用 zod schema 同时承担运行时校验与 JSON Schema 生成（供 Anthropic tools）。
 */
export interface ToolDef<T = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<T>;
  execute(input: T, ctx: ToolContext): Promise<ToolResult>;
  /**
   * 资源访问声明（按入参产出，路径类工具从 input 取 path），供 runTurn 并行调度做冲突判定。
   * 缺省 = all（独占串行）：副作用不可判定的工具不声明即为安全行为。
   */
  access?(input: T, ctx: ToolContext): ToolAccess;
}

export function ok(content: string): ToolResult {
  return { content, isError: false };
}

export function fail(content: string): ToolResult {
  return { content, isError: true };
}
