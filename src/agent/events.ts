/** agent 循环向外发出的事件，供 UI（Ink 或非交互打印）消费。 */
export type AgentEvent =
  | { type: 'text'; text: string }
  /** 思考（推理过程）文本增量。渲染无条件消费：恒思考模型即使请求未发 thinking 字段也会返回 thinking 块。 */
  | { type: 'thinking_delta'; text: string }
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
  | { kind: 'end'; isError: boolean };
