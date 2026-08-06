import type Anthropic from '@anthropic-ai/sdk';
import { capabilitiesToOverride, resolveCapability, type CapabilityOverride } from './capability-registry.js';
import {
  applyReprojectionLevel,
  degradeMessages,
  nextReprojectionLevel,
  type ReprojectionLevel,
} from './degrader.js';
import { projectMessages } from './projector.js';
import { StepMessagesProvider } from './step/stepMessages.js';
import type { ChatProvider, ThinkingParam } from './types.js';

/**
 * 统一 provider adapter 接口与第一个落地实现（stepfun 通道）。
 *
 * 设计来源：消息事件日志与后台通知设计 §5.3 / §7.5.2——「一厂一 adapter +
 * 共享边界基础设施」。每个 adapter 接收 `Anthropic.MessageParam[]`（内部权威
 * wire 格式），内部依次走 projector → degrader → 协议发送逻辑；共享的整形与
 * 降级都在 projector / degrader / capability-registry 里，adapter 只保留
 * 通道自身的接线。
 *
 * 接线现状：`factory.ts` 的 createProvider stepfun 分支已改为返回
 * {@link StepfunAdapter}（capabilityOverrides 待 config.toml 能力声明段解析
 * 实现后再传入，目前走静态表）；`runTurn.ts` 零改动，adapter.stream 签名与
 * ChatProvider 完全一致，直接当 ChatProvider 注入。send() 是新增的非流式
 * 便捷路径（含错误驱动重投影），供不需要逐字渲染的调用方（如 compaction、
 * 子 agent 收尾）使用。runTurn 现有的重试循环（withRetry）与 adapter 的
 * 重投影正交：重投影处理「请求本身被拒」（413/400），重试处理「瞬时故障」
 * （429/5xx/网络）。
 */

/** 一次补全的请求参数（与 ChatProvider.stream 同形，adapter 双方法共用）。 */
export interface ProviderSendParams {
  system: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  signal?: AbortSignal;
  /** 模型覆盖；省略用构造时的默认模型。 */
  model?: string;
  /** thinking 覆盖（三态）。阶跃三接口取 level，原生 Anthropic 取 budgetTokens。 */
  thinking?: ThinkingParam | null;
}

/** send() 的返回：最终 assistant 消息（usage 在 message.usage 内）。 */
export interface ProviderResponse {
  message: Anthropic.Message;
}

/**
 * 统一 adapter 接口。stream 对齐现状 ChatProvider 的流式签名（消费方零改动），
 * send 是新增的非流式路径。
 */
export interface StepProvider {
  /** 通道名（provider 预设 key，如 'stepfun'），供能力查表与日志展示。 */
  readonly name: string;
  /** 构造时配置的单次响应最大输出 token。 */
  readonly maxTokens?: number;
  /** 非流式发送：内部跑完流并取 finalMessage，错误驱动重投影在此层执行。 */
  send(params: ProviderSendParams): Promise<ProviderResponse>;
  /** 流式发送：签名与 ChatProvider.stream 完全一致，仅做投影 + 主动降级。 */
  stream(params: ProviderSendParams): ReturnType<Anthropic['messages']['stream']>;
}

/** {@link StepfunAdapter} 构造参数。 */
export interface StepfunAdapterOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  /** config.toml 的显式能力声明（装配层解析后传入；缺省只用静态表）。 */
  capabilityOverrides?: CapabilityOverride[];
  /**
   * 是否允许发送 thinking 字段。默认 false（通道硬约束）；用户 [thinking] 配置
   * 显式 enabled=true 时由工厂覆盖为 true（沿用 createProvider 既有口径）。
   */
  sendThinking?: boolean;
  /** thinking 构造默认（[thinking] 配置启用时由工厂注入），sendThinking 为 true 才生效。 */
  thinking?: ThinkingParam;
  /**
   * media-degraded 档保留的最近图片张数（config.toml media_keep_recent，缺省 10 由
   * 工厂解析后传入）。0 = 旧行为（全部换占位）。仅 send() 的错误驱动重投影使用。
   */
  mediaKeepRecentImages?: number;
  /** 测试注入：替换内部协议 provider（生产缺省用 AnthropicMessagesProvider）。 */
  inner?: ChatProvider;
}

/**
 * stepfun 通道 adapter（第一个落地的 adapter）。
 *
 * 通道 quirk（收敛自能力表，不在此处特判）：
 * - 默认不发 thinking 请求字段（sendThinking 缺省 false，沿用现状硬约束；
 *   用户 [thinking] 配置可经工厂覆盖开启）；
 * - cache_control 不支持（capability-registry 静态表声明）——degrader 剥离
 *   消息块上的 cache_control，内部 provider 同时以 sendCacheControl:false 构造，
 *   关掉 prepare 阶段的注入，两侧合力保证 wire 上完全不出现该字段。
 */
export class StepfunAdapter implements StepProvider {
  readonly name = 'stepfun';
  readonly maxTokens: number;
  private readonly model: string;
  private readonly overrides?: CapabilityOverride[];
  private readonly mediaKeepRecentImages: number;
  /** 与工厂口径一致的 thinking 开关与构造默认，透传给内部协议 provider。 */
  private readonly sendThinking: boolean;
  private readonly thinking?: ThinkingParam;
  private readonly inner: ChatProvider;

  constructor(options: StepfunAdapterOptions) {
    this.model = options.model;
    this.maxTokens = options.maxTokens;
    this.overrides = options.capabilityOverrides;
    this.sendThinking = options.sendThinking ?? false;
    this.thinking = options.thinking;
    this.mediaKeepRecentImages = options.mediaKeepRecentImages ?? 0;
    // 内部协议 provider 用 StepMessagesProvider（不是 AnthropicMessagesProvider）：
    // Step 的 /v1/messages 只认顶层 effort，官方的 thinking.budget_tokens 会被接受但
    // 静默无效（实测见 step/stepCommon.ts 头注释）。用官方类等于思考深度完全不受控。
    this.inner =
      options.inner ??
      new StepMessagesProvider({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        model: options.model,
        maxTokens: options.maxTokens,
        sendThinking: this.sendThinking,
        ...(this.thinking !== undefined ? { thinking: this.thinking } : {}),
        sendCacheControl: false,
      });
  }

  /** 运行时动态能力覆盖（子 agent 跨渠道时由 runner 注入）。 */
  private runtimeOverrides: CapabilityOverride | undefined;

  /** 查本次请求模型的能力声明（model 覆盖优先，其次构造默认，最终 runtimeOverrides 最优先）。 */
  private capability(model?: string) {
    const overrides: CapabilityOverride[] = [];
    if (this.runtimeOverrides !== undefined) overrides.push(this.runtimeOverrides);
    if (this.overrides !== undefined) overrides.push(...this.overrides);
    return resolveCapability(this.name, model ?? this.model, overrides);
  }

  /** 动态注入子 agent 别名能力声明（runner 在 resolveBinding 后调用）。 */
  setRuntimeCapabilities(capabilities: readonly string[] | undefined): void {
    this.runtimeOverrides =
      capabilities === undefined ? undefined : capabilitiesToOverride(this.name, this.model, capabilities);
  }

  /** 公共前置：投影 + 按能力主动降级。stream 与 send 共用。 */
  private prepare(messages: Anthropic.MessageParam[], model?: string): Anthropic.MessageParam[] {
    return degradeMessages(projectMessages(messages), this.capability(model));
  }

  /**
   * 流式发送：投影 + 主动降级后透传内部 provider。
   * 错误驱动重投影不在此层（流式消费方要自己感知重发），需要重投影的调用方
   * 用 send()，或自行组合 degrader 的 nextReprojectionLevel / applyReprojectionLevel。
   */
  stream(params: ProviderSendParams): ReturnType<Anthropic['messages']['stream']> {
    return this.inner.stream({ ...params, messages: this.prepare(params.messages, params.model) });
  }

  /**
   * 非流式发送：投影 + 主动降级 → 发送；遇 413/400 沿重投影链逐档降级重发，
   * 每档每请求最多用一次（used 集合在本次调用内持有），档位用尽或错误不可
   * 重投影时原样抛出。
   */
  async send(params: ProviderSendParams): Promise<ProviderResponse> {
    // 基线：投影 + 主动降级的结果。每一档重投影都从基线重新整体施加
    // （applyReprojectionLevel 的语义是「该档的完整形态」），不在上一档结果上
    // 累加，否则 strict 档无法撤掉 media-degraded 档留下的占位文本。
    const prepared = degradeMessages(projectMessages(params.messages), this.capability(params.model));
    const used = new Set<ReprojectionLevel>(['normal']);
    let messages = prepared;
    for (;;) {
      try {
        const stream = this.inner.stream({ ...params, messages });
        const message = await stream.finalMessage();
        return { message };
      } catch (err) {
        const level = nextReprojectionLevel(err, used);
        if (level === null) throw err;
        used.add(level);
        messages = applyReprojectionLevel(prepared, level, this.mediaKeepRecentImages);
      }
    }
  }
}
