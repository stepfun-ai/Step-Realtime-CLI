import { PROVIDER_PRESETS, type StepCodeConfig } from '../config/config.js';
import { t } from '../i18n.js';
import { StepfunAdapter } from './adapter.js';
import { capabilitiesToOverride } from './capability-registry.js';
import { AnthropicMessagesProvider } from './anthropicMessages.js';
import { OpenAiChatProvider } from './openaiChat.js';
import { OpenAiResponsesProvider } from './openaiResponses.js';
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
  // （messages→effort、chat→reasoning_effort、responses→reasoning.effort），
  // 此前这段解析放在 openai 分支之后，那两条路径根本拿不到值，注释还写着
  // 「openai 协议下忽略」——实测证明它们都支持且单调生效，忽略等于放任服务端默认深度。
  //
  // sendThinking：stepfun 预设为 false（历史实测部分模型 400），用户显式配置
  // [thinking] enabled=true 时覆盖为 true；anthropic 预设虽为 true，未配 [thinking]
  // 时 thinking 参数为空，照样不发。
  // default_level 命中档位表时其 budget 作为构造默认（会话级 /think 覆盖之外的基线）；
  // 未配 default_level 时回落 budget_tokens。
  const thinkingEnabled = config.thinking?.enabled === true;
  const defaultLevelBudget =
    config.thinking?.defaultLevel !== undefined
      ? config.thinking.levels[config.thinking.defaultLevel]
      : undefined;
  const sendThinking = preset.sendThinking || thinkingEnabled;
  const budgetTokens = defaultLevelBudget ?? config.thinking?.budgetTokens;
  const thinking =
    thinkingEnabled && budgetTokens !== undefined ? { budgetTokens } : undefined;

  if (preset.protocol === 'openai') {
    return new OpenAiChatProvider({
      apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      maxTokens: config.maxTokens,
      sendThinking,
      ...(thinking !== undefined ? { thinking } : {}),
    });
  }
  if (preset.protocol === 'openai_responses') {
    return new OpenAiResponsesProvider({
      apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      maxTokens: config.maxTokens,
      sendThinking,
      ...(thinking !== undefined ? { thinking } : {}),
    });
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
      ...(override !== undefined ? { capabilityOverrides: [override] } : {}),
    });
  }

  return new AnthropicMessagesProvider({
    apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    maxTokens: config.maxTokens,
    sendThinking,
    thinking,
  });
}
