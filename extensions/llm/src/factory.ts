import type { ChatCompletionClient } from "@step-cli/core/model-client.js";
import type { OpenAIReasoningEffort } from "@step-cli/protocol";
import { AnthropicMessagesClient } from "./anthropic-client.js";
import { FetchHttpTransport } from "./http-transport.js";
import type { HttpTransport } from "./http-transport.js";
import {
  OpenAICompatibleClient,
  type OpenAIEndpointKind,
} from "./openai-client.js";

const DEFAULT_TIMEOUT_MS = 60_000;

export interface CreateChatCompletionClientConfig {
  provider: "anthropic" | "openai-compat";
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  anthropicThinkingBudgetTokens?: number;
  openaiReasoningEffort?: OpenAIReasoningEffort;
  openaiEndpointKind?: OpenAIEndpointKind;
  transport?: HttpTransport;
}

export function createChatCompletionClient(
  config: CreateChatCompletionClientConfig,
): ChatCompletionClient {
  const transport = config.transport ?? new FetchHttpTransport();
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (config.provider === "anthropic") {
    return new AnthropicMessagesClient(
      {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        timeoutMs,
        ...(config.anthropicThinkingBudgetTokens != null
          ? {
              anthropicThinkingBudgetTokens:
                config.anthropicThinkingBudgetTokens,
            }
          : undefined),
      },
      transport,
    );
  }

  if (config.provider === "openai-compat") {
    return new OpenAICompatibleClient(
      {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        timeoutMs,
        ...(config.openaiReasoningEffort != null
          ? { reasoningEffort: config.openaiReasoningEffort }
          : undefined),
        ...(config.openaiEndpointKind != null
          ? { endpointKind: config.openaiEndpointKind }
          : undefined),
      },
      transport,
    );
  }

  const exhaustiveCheck: never = config.provider;
  throw new Error(`Unsupported provider: ${String(exhaustiveCheck)}`);
}
