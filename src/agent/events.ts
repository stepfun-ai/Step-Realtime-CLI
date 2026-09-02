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
  /**
   * 工具调用开始成形：模型刚开始流式吐 tool_use 块（Anthropic 原生 content_block_start，
   * OpenAI 通道由 provider 合成同形事件）。比 tool_start 早——后者要等参数 JSON 完整。
   * UI 据此先挂「成形中」的工具卡，填掉参数流的等待空窗。
   */
  | { type: 'tool_forming'; id: string; name: string }
  /** 工具参数的流式增量（半截 JSON 片段）。UI 只抠关键字段做预览，不解析全量。 */
  | { type: 'tool_args_delta'; id: string; partialJson: string }
  | { type: 'tool_end'; id: string; name: string; result: string; isError: boolean; errorCode?: string }
  /**
   * 重试。hadPartial 为 true 表示本次失败尝试已吐过正文（屏幕上有残文条目），
   * UI 据此在重试前移除该残文（B 方案：撤回气泡，只留重发的完整版）；
   * 缺省/false 表示未吐字（连接期失败），无残文可撤，仅提示重试。
   * cause：触发本次重试的原始错误（内部元数据，UI 不消费），供 wire 落盘定位
   * 空响应/断连成因（EmptyResponseError 带 stop_reason/hadReasoning/token 诊断上下文）。
   */
  | { type: 'retry'; attempt: number; delayMs: number; message: string; hadPartial?: boolean; cause?: unknown }
  /**
   * thinking 预算耗尽自动降档：首轮 thinkingExhausted（仅 thinking 块、无正文/工具调用）
   * 且当前档位可降时，自动降到 low 重试 1 次。成功后恢复原档位，用户无感知；
   * 失败退到 loop 的提示路径。fromLevel 为 undefined 表示构造默认（[thinking] default_level）。
   */
  | { type: 'thinking_downgrade'; fromLevel: string | undefined; toLevel: string }
  /**
   * think-only 自动恢复：降档重试仍耗尽时，把耗尽轮次的 thinking 落盘为 assistant 消息，
   * 注入「直接回答」user 消息，用同一份 messages 发新请求。retried=true 表示这是注入后的重试。
   */
  | { type: 'thinking_recover'; retried: boolean }
  /**
   * thinking 流死循环：流式检测发现思考在周期性重复（sample 为重复单元预览），
   * 当前流已中止，客户端自动以「诱导跳出」提示重试一次。注入会污染上下文
   * （reasoning leakage 风险，arXiv:2510.11713），故采用「终止当前流 + 新请求重试」
   * 而非在同流内续写。retried=true 表示这是注入后的重试。
   */
  | { type: 'thinking_loop'; sample: string; repeats: number; retried: boolean }
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
   * billedDelta：本轮请求的计费 token 增量（input + output；input_tokens 本身已排除缓存命中部分）。
   * usage 携带；压缩后的纯估算事件不带（无增量可计）。供子 agent 运行器逐轮累计成本。
   */
  | { type: 'usage'; totalTokens: number; measuredLength?: number; billedDelta?: number }
  /** cause：原始错误对象（内部元数据，UI 不消费），供子 agent 运行器识别 429 做重排队判定。 */
  | { type: 'error'; message: string; cause?: unknown };

/** 编排步骤进度事件（onWorkflowStep 回调参数，供 UI 步骤面板推进）。
 * dynamic_workflow 的 phase 事件是哨兵值 `index: -1, total: 0`——阶段在运行时才知道、
 * 无法预先编号，UI 应走「按 title 追加」的动态分支而非按 index 定位。
 *（本类型原在 src/agent/workflow.ts，随声明式 workflow 删除迁至此处：dynamic_workflow 仍在用。） */
export interface WorkflowStepEvent {
  index: number;
  total: number;
  /** 事件类型。dynamic_workflow 的阶段切换为 'phase'；历史上声明式 workflow（已删除）也用其余 kind 值。 */
  kind: string;
  status: 'start' | 'done';
  /** phase 事件的阶段标题（dynamic_workflow 脚本内 phase(title) 发出；其余 kind 无此字段）。 */
  title?: string;
}

/** 子 agent 进度事件（独立通道，经 runner 的 onEvent 上抛，带 id 区分并行子 agent）。 */
export type SubagentProgressEvent =
  | { kind: 'start'; subagentType: string; description: string }
  | { kind: 'tool'; name: string }
  | { kind: 'tool_end'; name: string; isError: boolean }
  | { kind: 'error'; message: string }
  /** 累计计费 token（runner 已逐轮累加，消费者只赋值不加法）。 */
  | { kind: 'usage'; tokens: number }
  /**
   * 终态。除 isError 外的字段是给程序消费方的（stream-json 外部脚本、TUI 统计）：
   * - summary：子 agent 产出的结论文本，对外消费方最想要的东西——没有它，外部只知道
   *   「跑完了、没出错」，拿不到干了什么。中断/无产出等路径给占位说明而非空串。
   * - toolUses / durationMs：工具调用次数与墙钟耗时。只报 token 无法回答「是卡在慢工具还是烧在长上下文」。
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
