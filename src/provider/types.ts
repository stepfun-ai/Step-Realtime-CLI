import type Anthropic from '@anthropic-ai/sdk';
import type { ThinkingLevelName } from '../config/config.js';

/**
 * 运行时思考强度参数（构造默认 / 会话级 `/think` 覆盖 / 单次请求覆盖共用同一形态）。
 *
 * 同时携带两种表达，因为两类协议要的东西不同且不可互相推导：
 * - `level`：阶跃三接口收的档位字符串，原样作为 effort 值发出
 *   （messages→`output_config.effort`、chat→`reasoning_effort`、responses→`reasoning.effort`）；
 * - `budgetTokens`：原生 Anthropic 渠道收的数字，作为 `thinking.budget_tokens` 发出。
 *
 * 各 provider 只取自己那一份，另一份忽略。曾经只传 budgetTokens 让 provider 反推档位，
 * 反推阈值硬编码，用户改 `[thinking.levels]` 数字就会静默错档，现已改为档位名直达。
 */
export interface ThinkingParam {
  /** 档位名；阶跃三协议直接用它作 effort 值。 */
  level?: ThinkingLevelName;
  /** 预算 token 数；仅原生 Anthropic 渠道会真实发出。 */
  budgetTokens?: number;
}

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
     * 所有协议实现都消费此参数（阶跃三接口取 level，原生 Anthropic 取 budgetTokens）。
     */
    thinking?: ThinkingParam | null;
  }): ReturnType<Anthropic['messages']['stream']>;
  /**
   * 动态注入运行时能力标记（子 agent 跨渠道/跨模型时，由 runner 在 resolveBinding 后调用）。
   * 未实现者留空：默认行为是构造时能力声明不变。
   */
  setRuntimeCapabilities?(capabilities: readonly string[] | undefined): void;
}
