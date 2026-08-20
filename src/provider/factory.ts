import {
  DEFAULT_THINKING_LEVEL,
  DEFAULT_THINKING_LEVELS,
  PROVIDER_PRESETS,
  type StepCodeConfig,
} from '../config/config.js';
import { t } from '../i18n.js';
import { StepfunAdapter } from './adapter.js';
import { capabilitiesToOverride, resolveCapability } from './capability-registry.js';
import { AnthropicMessagesProvider } from './anthropicMessages.js';
import { withCapabilityProjection } from './degrader.js';
import { withMediaDegradation } from './mediaDegradation.js';
import { OpenAiChatProvider } from './openaiChat.js';
import { OpenAiResponsesProvider } from './openaiResponses.js';
import { withHistoryNormalization } from './normalizedProvider.js';
import type { ChatProvider } from './types.js';

/**
 * 按 config.provider 构造对应的 ChatProvider。
 *
 * 分发规则：
 * - stepfun → {@link StepfunAdapter}（一厂一 adapter：projector/degrader/能力表在边界层生效）
 * - 其余 anthropic 协议预设（anthropic）→ {@link AnthropicMessagesProvider}
 * - openai → {@link OpenAiChatProvider}（/v1/chat/completions）
 * - openai_responses → {@link OpenAiResponsesProvider}（/v1/responses）
 * 未知 provider（不在 PROVIDER_PRESETS 内）抛错；apiKey 缺失/空串抛带配置指引的错误
 * （loadConfig 起不再强制 key，密钥解析允许多渠道独立配置，缺失在此兜底）。
 *
 * 装配不对称说明：
 * - openai / openai_responses / anthropic 三条路径的返回值用 {@link withHistoryNormalization}
 *   包一层，保证请求前历史整形覆盖全部通道；
 * - stepfun 路径不包：`StepfunAdapter` 内部已调 `projectMessages`（含 normalizeHistory +
 *   ensureLeadingUser），且它还额外实现了 `send()`，用装饰器包装会丢掉那个方法。
 */
export function createProvider(config: StepCodeConfig): ChatProvider {
  const preset = PROVIDER_PRESETS[config.provider];
  if (preset === undefined) {
    throw new Error(
      t('factory.unknownProvider', { provider: config.provider, list: Object.keys(PROVIDER_PRESETS).join(' | ') }),
    );
  }
  if (config.apiKey === undefined || config.apiKey === '') {
    throw new Error(t('factory.missingApiKey', { provider: config.provider }));
  }
  const apiKey = config.apiKey;

  // thinking 解析必须在所有协议分支之前：Step 的三个接口都有思考控制字段
  // （messages→output_config.effort、chat→reasoning_effort、responses→reasoning.effort），
  // 此前这段解析放在 openai 分支之后，那两条路径根本拿不到值，注释还写着
  // 「openai 协议下忽略」——实测证明它们都支持且单调生效，忽略等于放任服务端默认深度。
  //
  // sendThinking：stepfun 预设为 false（历史实测部分模型 400），用户显式配置
  // [thinking] enabled=true 时覆盖为 true；anthropic 预设虽为 true，未配 [thinking]
  // 时 thinking 参数为空，照样不发。
  //
  // ## 为什么下发的对象同时带 level 和 budgetTokens
  //
  // 两类协议要的东西不同，且不可互相推导：
  // - 阶跃三接口只收档位字符串（low|medium|high），必须原样拿到 level；
  // - 原生 Anthropic 只收数字 thinking.budget_tokens，必须拿到 budgetTokens。
  //
  // 曾经只下发 budgetTokens，由 provider 用 budgetToEffort() 反推档位。那个反推
  // 阈值是硬编码的，用户改 [thinking.levels] 的数字就会错档（配 medium=20000
  // 反推出 high），且属于「先把档位编码成数字、再猜回档位」的无谓损耗。
  // 现在档位名直达，数字只喂给真正需要它的那一条路径。
  const thinkingEnabled = config.thinking?.enabled === true;
  const sendThinking = preset.sendThinking || thinkingEnabled;
  const level = config.thinking?.defaultLevel ?? DEFAULT_THINKING_LEVEL;
  const thinking = thinkingEnabled
    ? { level, budgetTokens: (config.thinking?.levels ?? DEFAULT_THINKING_LEVELS)[level] }
    : undefined;

  if (preset.protocol === 'openai') {
    const override = capabilitiesToOverride('openai', config.model, config.capabilities);
    const capability = resolveCapability('openai', config.model, override !== undefined ? [override] : undefined);
    // 能力投影最外层：image_in=false 时发送前把媒体块换占位文本（不等 400）；
    // 未声明/声明支持时零包装，400 方言降级链继续兜底未知端点。
    return withCapabilityProjection(
      withMediaDegradation(
        withHistoryNormalization(
          new OpenAiChatProvider({
            apiKey,
            baseUrl: config.baseUrl,
            model: config.model,
            maxTokens: config.maxTokens,
            sendThinking,
            ...(thinking !== undefined ? { thinking } : {}),
            reasoning: capability.reasoning,
          }),
        ),
        { keepRecentImages: config.mediaKeepRecentImages ?? 10 },
      ),
      capability,
    );
  }
  if (preset.protocol === 'openai_responses') {
    const override = capabilitiesToOverride('openai_responses', config.model, config.capabilities);
    const capability = resolveCapability(
      'openai_responses',
      config.model,
      override !== undefined ? [override] : undefined,
    );
    return withCapabilityProjection(
      withMediaDegradation(
        withHistoryNormalization(
          new OpenAiResponsesProvider({
            apiKey,
            baseUrl: config.baseUrl,
            model: config.model,
            maxTokens: config.maxTokens,
            sendThinking,
            ...(thinking !== undefined ? { thinking } : {}),
          }),
        ),
        { keepRecentImages: config.mediaKeepRecentImages ?? 10 },
      ),
      capability,
    );
  }

  // stepfun 通道走 adapter：请求整形（projector）、主动降级（degrader）、能力表
  // （capability-registry）在边界层统一生效；sendCacheControl:false 由 adapter 内部处理。
  // config.toml 的 [models.<别名>] capabilities 在此翻译成 CapabilityOverride 下发——
  // 此前这一步缺失，导致声明只对工具门控生效、对请求整形无效（explore 配了 image_in
  // 仍被 degrader 剥图）。
  if (config.provider === 'stepfun') {
    const override = capabilitiesToOverride('stepfun', config.model, config.capabilities);
    return new StepfunAdapter({
      apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      maxTokens: config.maxTokens,
      sendThinking,
      thinking,
      mediaKeepRecentImages: config.mediaKeepRecentImages ?? 10,
      ...(override !== undefined ? { capabilityOverrides: [override] } : {}),
    });
  }

  const anthropicOverride = capabilitiesToOverride('anthropic', config.model, config.capabilities);
  const anthropicCapability = resolveCapability(
    'anthropic',
    config.model,
    anthropicOverride !== undefined ? [anthropicOverride] : undefined,
  );
  return withCapabilityProjection(
    withMediaDegradation(
      withHistoryNormalization(
        new AnthropicMessagesProvider({
          apiKey,
          baseUrl: config.baseUrl,
          model: config.model,
          maxTokens: config.maxTokens,
          sendThinking,
          thinking,
        }),
      ),
      { keepRecentImages: config.mediaKeepRecentImages ?? 10 },
    ),
    anthropicCapability,
  );
}
