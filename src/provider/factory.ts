import { PROVIDER_PRESETS, type StepCodeConfig } from '../config/config.js';
import { t } from '../i18n.js';
import { StepfunAdapter } from './adapter.js';
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

  if (preset.protocol === 'openai') {
    return new OpenAiChatProvider({
      apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      maxTokens: config.maxTokens,
    });
  }
  if (preset.protocol === 'openai_responses') {
    return new OpenAiResponsesProvider({
      apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      maxTokens: config.maxTokens,
    });
  }

  // anthropic 协议家族：thinking 请求字段仅当用户显式配置 [thinking] enabled=true 时发。
  // stepfun 预设 sendThinking 为 false（历史实测部分模型 400），此处由用户配置覆盖为 true；
  // anthropic 预设虽为 true，未配 [thinking] 时 thinking 参数为空，照样不发。
  // [thinking] 的 budget 语义只对 anthropic 协议家族有效；openai 协议下上面已分发、不走到这里，故忽略。
  // default_level 命中档位表时其 budget 作为构造默认（会话级 /think 覆盖之外的基线）；
  // 未配 default_level 时回落 budget_tokens（旧行为）。
  const thinkingEnabled = config.thinking?.enabled === true;
  const defaultLevelBudget =
    config.thinking?.defaultLevel !== undefined
      ? config.thinking.levels[config.thinking.defaultLevel]
      : undefined;
  const sendThinking = preset.sendThinking || thinkingEnabled;
  const thinking = thinkingEnabled ? { budgetTokens: defaultLevelBudget ?? config.thinking?.budgetTokens } : undefined;

  // stepfun 通道走 adapter：请求整形（projector）、主动降级（degrader）、能力表
  // （capability-registry）在边界层统一生效；sendCacheControl:false 由 adapter 内部处理。
  if (config.provider === 'stepfun') {
    return new StepfunAdapter({
      apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      maxTokens: config.maxTokens,
      sendThinking,
      thinking,
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
