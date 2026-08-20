import Anthropic from '@anthropic-ai/sdk';
import { buildSystemBlocks, prepareMessages, withToolCacheControl } from './prepare.js';
import type { ChatProvider } from './types.js';

/** {@link AnthropicMessagesProvider} 构造参数。 */
export interface AnthropicMessagesProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  /**
   * 是否允许发送 thinking 字段。默认 false（对未确认支持的服务商绝不传，避免 400）。
   * 为 true 时也仅是「开关打开」：实际发不发还看 thinking 参数是否给出（见 stream）。
   */
  sendThinking?: boolean;
  /**
   * thinking 请求参数（[thinking] 配置启用时由工厂注入）。存在且 sendThinking 为 true 时，
   * 请求带 {type:'enabled', budget_tokens?}；否则绝不带 thinking 字段（也不发 disabled——
   * 实测被服务端忽略，发了是撒谎）。
   */
  thinking?: { budgetTokens?: number };
  /**
   * 是否注入 cache_control（system / 末位 tool / 末条消息末块）。默认 true（历史行为）。
   * 能力声明不支持 cache_control 的通道（见 capability-registry）由 adapter 置 false，
   * 让 degrader 的主动剥离真正生效，而不是在请求代码里特判。
   */
  sendCacheControl?: boolean;
}

/**
 * 参数化的 Anthropic Messages 协议 provider。把原 StepProvider 泛化，用 quirk 开关
 * 适配不同服务商。硬约束（对 StepFun 实测确认，作为默认行为）：
 * - 走 Anthropic Messages 协议，base_url 不带 /v1（SDK 自动拼 /v1/messages）。
 * - 鉴权走 x-api-key（SDK 的 apiKey 即映射到此）。
 * - sendThinking 不为 true 时绝不传 thinking 字段（部分服务端不接受该字段，传了会 400）。
 * - system 走顶层 system 参数。
 */
export class AnthropicMessagesProvider implements ChatProvider {
  private readonly client: Anthropic;
  private readonly model: string;
  readonly maxTokens: number;
  private readonly sendThinking: boolean;
  private readonly thinking?: { budgetTokens?: number };
  private readonly sendCacheControl: boolean;

  constructor(options: AnthropicMessagesProviderOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
    });
    this.model = options.model;
    this.maxTokens = options.maxTokens;
    this.sendThinking = options.sendThinking ?? false;
    this.thinking = options.thinking;
    this.sendCacheControl = options.sendCacheControl ?? true;
  }

  /**
   * 发起一次流式补全。返回 SDK 的 MessageStream：
   * 可 `for await` 消费增量事件，也可 `await stream.finalMessage()` 拿最终消息。
   * 会注入 Anthropic prompt cache（system / 最后一个 tool / 最后一条消息末块）。
   */
  stream(params: {
    system: string;
    tools: Anthropic.Tool[];
    messages: Anthropic.MessageParam[];
    signal?: AbortSignal;
    /** 模型覆盖；省略用构造时的默认模型。 */
    model?: string;
    /** thinking 覆盖（三态）：undefined 用构造默认；对象本次覆盖；null 本次强制不发 thinking 字段。 */
    thinking?: { budgetTokens?: number } | null;
  }): ReturnType<Anthropic['messages']['stream']> {
    const body: Anthropic.MessageStreamParams = {
      model: params.model ?? this.model,
      max_tokens: this.maxTokens,
      system: buildSystemBlocks(params.system, this.sendCacheControl),
      tools: withToolCacheControl(params.tools, this.sendCacheControl),
      messages: prepareMessages(params.messages, this.sendCacheControl),
    };
    // thinking 三态：undefined 跟随构造默认（[thinking] 配置），对象本次覆盖（/think 选档），
    // null 本次抑制（/think off）。sendThinking 为 true 且最终值非 null/undefined 时才带 thinking
    // 字段（budget 未配只带 enabled）；其余情况绝不带，也绝不发 {type:'disabled'}（实测被忽略，发了是撒谎）。
    const thinking = params.thinking === undefined ? this.thinking : params.thinking;
    if (this.sendThinking && thinking !== null && thinking !== undefined) {
      // SDK 类型把 budget_tokens 标为必填，但 StepFun 实测接受仅 {type:'enabled'}（服务端默认预算），故做断言
      body.thinking = (
        thinking.budgetTokens !== undefined
          ? { type: 'enabled', budget_tokens: thinking.budgetTokens }
          : { type: 'enabled' }
      ) as Anthropic.ThinkingConfigParam;
    }
    return this.client.messages.stream(
      body,
      params.signal !== undefined ? { signal: params.signal } : undefined,
    );
  }
}
