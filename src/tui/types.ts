/** UI 展示用的会话条目（独立于回灌给模型的 Anthropic 消息历史）。 */
export type DisplayItem =
  | { kind: 'user'; text: string }
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
      /** 工具开始时间戳（tool_start 时埋入），用于 running 态显示已运行秒数。 */
      startedAt?: number;
      /** workflow 工具的步骤面板状态（tool_start 时从 input.steps 装配，onWorkflowStep/子 agent 事件推进）。 */
      workflow?: import('./WorkflowPanel.js').WorkflowPanelState;
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
  | { kind: 'error'; text: string }
  | { kind: 'goalPanel'; data: import('./GoalPanel.js').GoalPanelData }
  | { kind: 'cron'; data: import('./CronCard.js').CronCardData };
