/** agent 循环向外发出的事件，供 UI（Ink 或非交互打印）消费。 */
export type AgentEvent =
  | { type: 'text'; text: string }
  /**
   * 思考块开始（Anthropic 协议的 content_block_start[type=thinking | redacted_thinking]）。
   * 存在的意义：有的模型不吐可见思考文本（只吐 signature_delta），此时 thinking_delta 一条都没有，
   * UI 若只认 delta 就只能显示通用忙碌态——与「卡死」无从区分。有了边界事件，无痕思考也能显示「思考中」。
   */
  | { type: 'thinking_start' }
  /** 思考（推理过程）文本增量。渲染无条件消费：恒思考模型即使请求未发 thinking 字段也会返回 thinking 块。 */
  | { type: 'thinking_delta'; text: string }
  /** 思考块结束（对应 index 的 content_block_stop）。UI 据此收起「思考中」指示。 */
  | { type: 'thinking_end' }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_end'; id: string; name: string; result: string; isError: boolean }
  | { type: 'retry'; attempt: number; delayMs: number; message: string }
  | { type: 'aborted' }
  /** goal 等自主续接：本 run 结束，inject 为下一轮注入文本。 */
  | { type: 'continuation'; inject: string }
  | { type: 'turn_done' }
  | { type: 'notice'; message: string }
  /**
   * 上下文用量。totalTokens 为该事件覆盖范围的 token 总量。
   * measuredLength：此 totalTokens 已测量/覆盖的 messages 前缀长度——真实 usage 覆盖当轮完整 messages
   * （= messages.length），供 UI 对「此后新 append、尚未经历 API 往返」的尾部消息做字符估算叠加，
   * 使状态栏在两次往返之间也能反映新增内容。压缩后的纯估算回落传压缩后全长（= messages.length）：
   * totalTokens 已是全量估算、覆盖当前全部消息，游标设为全长使尾部为空、不重复叠加。
   * measuredLength=0 表示无已测量前缀（如 resume 尚未往返），UI 对全部消息做估算。
   * 省略时 UI 退化为「只显示 totalTokens、不叠加尾部」的旧行为。
   * billedDelta：本轮请求的计费 token 增量（input − cache_read + output），仅真实 API 往返的
   * usage 携带；压缩后的纯估算事件不带（无增量可计）。供子 agent 运行器逐轮累计成本。
   */
  | { type: 'usage'; totalTokens: number; measuredLength?: number; billedDelta?: number }
  /** cause：原始错误对象（内部元数据，UI 不消费），供子 agent 运行器识别 429 做重排队判定。 */
  | { type: 'error'; message: string; cause?: unknown };

/** 子 agent 进度事件（独立通道，经 runner 的 onEvent 上抛，带 id 区分并行子 agent）。 */
export type SubagentProgressEvent =
  | { kind: 'start'; subagentType: string; description: string }
  | { kind: 'tool'; name: string }
  | { kind: 'error'; message: string }
  /** 累计计费 token（runner 已逐轮累加，消费者只赋值不加法）。 */
  | { kind: 'usage'; tokens: number }
  /**
   * 终态。除 isError 外的字段是给程序消费方的（stream-json 外部脚本、TUI 统计）：
   * - summary：子 agent 产出的结论文本，对外消费方最想要的东西——没有它，外部只知道
   *   「跑完了、没出错」，拿不到干了什么。中断/无产出等路径给占位说明而非空串。
   * - toolUses / durationMs：工具调用次数与墙钟耗时。
   * 只报 token 无法回答「是卡在慢工具还是烧在长上下文」。
   * - sessionId：summary 在 wire 上会被截断，消费方凭它取回完整产出，也是 resume 入口。
   * 均为可选：TUI 等既有消费方不读也不受影响，新增字段不构成 breaking change。
   */
  | {
      kind: 'end';
      isError: boolean;
      summary?: string;
      toolUses?: number;
      durationMs?: number;
      sessionId?: string;
    };
