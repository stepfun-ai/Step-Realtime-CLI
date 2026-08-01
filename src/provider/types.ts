import type Anthropic from '@anthropic-ai/sdk';

/**
 * 服务商（provider）抽象接口。
 *
 * 签名与历史上的 StepProvider.stream 完全一致，所以所有消费方（loop / runTurn /
 * subagent / compaction / TUI）只需依赖此接口即可零改动地兼容任意实现。
 * 当前唯一实现是 {@link AnthropicMessagesProvider}（Anthropic Messages 协议家族，
 * 覆盖 StepFun 与 Anthropic 官方）。
 */
export interface ChatProvider {
  /** 构造时配置的单次响应最大输出 token（用于截断提示展示）。实现可缺省。 */
  readonly maxTokens?: number;
  /**
   * 发起一次流式补全，返回 Anthropic SDK 的 MessageStream：
   * 可 `for await` 消费增量事件，也可 `await stream.finalMessage()` 拿最终消息。
   */
  stream(params: {
    system: string;
    tools: Anthropic.Tool[];
    messages: Anthropic.MessageParam[];
    signal?: AbortSignal;
    /** 模型覆盖；省略用构造时的默认模型。 */
    model?: string;
    /**
     * thinking 覆盖（三态）：undefined 用构造默认；对象本次覆盖；null 本次强制不发 thinking 字段。
     * 仅 anthropic 协议实现消费；其余协议实现忽略此参数。
     */
    thinking?: { budgetTokens?: number } | null;
  }): ReturnType<Anthropic['messages']['stream']>;
}
