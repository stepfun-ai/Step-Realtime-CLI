import type { GoalStatus } from '../agent/goal/mode.js';
/** 嵌套子 agent 的工具调用事件（由 runner onEvent 实时回传，挂到父 spawn_agent 条目下）。 */
export interface SubagentToolEvent {
  name: string;
  status: 'ok' | 'error' | 'running';
}

/** 启动欢迎框的展示数据。 */
export interface WelcomeData {
  cwd: string;
  sessionId: string;
  model: string;
  version: string;
}

/** UI 展示用的会话条目（独立于回灌给模型的 Anthropic 消息历史）。 */
export type DisplayItem =
  | { kind: 'welcome'; data: WelcomeData }
  | { kind: 'user'; text: string; /** 压缩保真原话（origin=user_verbatim）：视觉上应与真人输入区分，降权显示。缺省/false = 真人输入。 */ verbatim?: boolean }
  | { kind: 'assistant'; text: string }
  /** 思考（推理过程）定稿块：流式期不进历史区（状态行预览），完成后才落成此条目。 */
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: unknown;
      status: 'running' | 'ok' | 'error';
      result?: string;
      /** 参数流式中（tool_forming 已挂卡、tool_start 未到）：卡片显示「参数成形中」+ 关键字段预览。 */
      forming?: boolean;
      /** 半截参数 JSON 的累积（tool_args_delta 拼接），仅供渲染层抠关键字段预览。 */
      partialArgs?: string;
      /** 工具开始时间戳（tool_start 时埋入），用于 running 态显示已运行秒数。 */
      startedAt?: number;
      /** dynamic_workflow 的动态阶段面板状态（tool_start 时造空序列，phase 事件逐个追加阶段）。 */
      dynamicWorkflow?: DynamicWorkflowPanelState;
      /** spawn_agent 角色名（tool_start 时从 ev.input.subagent_type 提取）。 */
      subagentType?: string;
      /** spawn_agent 任务简述（tool_start 时从 ev.input.description 提取）。 */
      description?: string;
      /** 嵌套子工具调用事件（仅 spawn_agent 工具使用，由 runner 的 onEvent 实时回传）。 */
      subagentToolEvents?: SubagentToolEvent[];
      /** 子 agent 累计计费 token（runner 已逐轮累加，这里只赋值）。0/缺省不显示。 */
      subagentTokens?: number;
      /** 子 agent 终态统计：工具调用次数与墙钟耗时（end 事件带回）。 */
      subagentToolUses?: number;
      subagentDurationMs?: number;
      /** 结构化错误码（可选）。TUI 可按 code 做特殊渲染，如 PLAN_MODE_BLOCKED。 */
      errorCode?: string;
    }
  | {
      kind: 'note';
      text: string;
      /**
       * 为 true 表示这是 agent 流事件（retry/notice），构成消息边界：流式正文不得越过它
       * 续接前面的 assistant（重试/新一轮的消息必须另开条目）。缺省为 UI 侧提示
       * （队列回执、斜杠命令输出等），不构成边界——流式正文可越过它续接，一条消息不被劈开。
       */
      boundary?: boolean;
    }
  | {
      /**
       * 折叠摘要块：Transcript 逐回合折叠旧块时产出（OOM 第二道防线，`5cb73d3` 之外）。
       * 它是一行的结构性占位，代表「更早的 N 轮已被折成摘要」，不是流式内容也不构成消息边界。
       * 历史本身不丢（仍在 this.history 与日志），只是渲染块被替换。
       */
      kind: 'foldSummary';
      /** 被折叠的旧块数（供摘要行与测试断言用）。 */
      count: number;
    }
  | { kind: 'error'; text: string }
  | { kind: 'goalPanel'; data: GoalPanelData }
  | { kind: 'cron'; data: CronCardData };

/** dynamic_workflow 的阶段面板状态（原住 DynamicWorkflowPanel.tsx，与渲染无关，迁移时下沉到这里）。 */
export interface DynamicWorkflowPanelState {
  name: string;
  phases: DynamicPhase[];
}

/** 一个编排阶段（tool_start 时造空序列，phase 事件逐个追加）。 */
export interface DynamicPhase {
  title: string;
  status: 'running' | 'done';
}

/** goal 状态面板的展示数据。 */
export interface GoalPanelData {
  objective: string;
  completionCriterion?: string;
  status: GoalStatus;
  turnsUsed: number;
  turnBudget?: number;
  tokensUsed?: number;
  tokenBudget?: number;
  terminalReason?: string;
  elapsedMs: number;
}

/** cron 触发卡片的展示数据。 */
export interface CronCardData {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  coalesced: number;
}
