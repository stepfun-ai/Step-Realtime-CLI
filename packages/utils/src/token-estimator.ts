import type {
  ChatMessage,
  CompletionRequest,
  CompletionUsage,
  OpenAIToolDefinition,
} from "@step-cli/protocol";
import { estimateUserAttachmentTokens } from "./user-message.js";

const DEFAULT_CHARS_PER_TOKEN = 4;
const BASE_MESSAGE_OVERHEAD = 8;

const PROVIDER_REQUEST_OVERHEAD: Record<TokenEstimatorProvider, number> = {
  generic: 18,
  openai: 24,
  anthropic: 28,
};

const PROVIDER_TOOL_OVERHEAD: Record<TokenEstimatorProvider, number> = {
  generic: 24,
  openai: 32,
  anthropic: 96,
};

const PROVIDER_TOOL_CHOICE_OVERHEAD: Record<TokenEstimatorProvider, number> = {
  generic: 8,
  openai: 8,
  anthropic: 24,
};

export type TokenEstimatorProvider = "generic" | "openai" | "anthropic";

export interface CompletionRequestTokenEstimateOptions {
  provider?: TokenEstimatorProvider;
  calibrationFactor?: number;
}

export interface AdaptivePromptTokenEstimatorOptions {
  provider: TokenEstimatorProvider;
}

export function estimateTextTokens(
  text: string,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
): number {
  if (text.length === 0) {
    return 0;
  }

  return Math.ceil(text.length / charsPerToken);
}

export function estimateMessageTokens(message: ChatMessage): number {
  let total = BASE_MESSAGE_OVERHEAD;
  total += estimateTextTokens(message.content ?? "");

  if (message.role === "user") {
    total += estimateUserAttachmentTokens(message.attachments);
  }

  if (message.role === "assistant" && message.tool_calls) {
    for (const toolCall of message.tool_calls) {
      total += estimateTextTokens(toolCall.id);
      total += estimateTextTokens(toolCall.function.name);
      total += estimateTextTokens(toolCall.function.arguments);
    }
  }

  if (message.role === "tool") {
    total += estimateTextTokens(message.name);
    total += estimateTextTokens(message.tool_call_id);
  }

  return total;
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    0,
  );
}

export function estimateToolDefinitionTokens(
  tools: OpenAIToolDefinition[] | undefined,
): number {
  if (!tools || tools.length === 0) {
    return 0;
  }

  return tools.reduce((total, tool) => {
    const schemaText = safeStableStringify(tool.function.parameters ?? {});
    return (
      total +
      BASE_MESSAGE_OVERHEAD +
      estimateTextTokens(tool.function.name) +
      estimateTextTokens(tool.function.description ?? "") +
      estimateTextTokens(schemaText)
    );
  }, 0);
}

export function estimateCompletionRequestPromptTokens(
  request: CompletionRequest,
  options: CompletionRequestTokenEstimateOptions = {},
): number {
  const provider =
    options.provider ?? inferTokenEstimatorProviderFromModel(request.model);
  const calibrationFactor = clampNumber(
    options.calibrationFactor ?? 1,
    0.5,
    2.5,
  );
  const modelFactor = estimateModelFamilyFactor(provider, request.model);

  let total = estimateMessagesTokens(request.messages);
  total += PROVIDER_REQUEST_OVERHEAD[provider];
  total += estimateToolDefinitionTokens(request.tools);

  if (request.tools && request.tools.length > 0) {
    total += PROVIDER_TOOL_OVERHEAD[provider];
    total += PROVIDER_TOOL_CHOICE_OVERHEAD[provider];

    if (request.tool_choice === "required") {
      total += PROVIDER_TOOL_CHOICE_OVERHEAD[provider];
    }

    if (request.parallel_tool_calls === false) {
      total += 4;
    }
  }

  return Math.max(0, Math.round(total * modelFactor * calibrationFactor));
}

export function inferTokenEstimatorProviderFromModel(
  model: string,
): TokenEstimatorProvider {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes("claude")) {
    return "anthropic";
  }
  if (
    normalized.includes("gpt") ||
    normalized.includes("o1") ||
    normalized.includes("o3") ||
    normalized.includes("o4") ||
    normalized.includes("o5")
  ) {
    return "openai";
  }

  return "generic";
}

export class AdaptivePromptTokenEstimator {
  private readonly provider: TokenEstimatorProvider;
  private readonly calibrationByModel = new Map<
    string,
    { factor: number; samples: number }
  >();

  constructor(options: AdaptivePromptTokenEstimatorOptions) {
    this.provider = options.provider;
  }

  estimatePromptTokens(request: CompletionRequest): number {
    const calibration = this.calibrationByModel.get(
      normalizeModelKey(request.model),
    );

    return estimateCompletionRequestPromptTokens(request, {
      provider: this.provider,
      calibrationFactor: calibration?.factor ?? 1,
    });
  }

  observeUsage(
    request: CompletionRequest,
    usage: CompletionUsage | undefined,
  ): void {
    const promptTokens = usage?.prompt_tokens;
    if (
      !Number.isFinite(promptTokens) ||
      promptTokens === undefined ||
      promptTokens <= 0
    ) {
      return;
    }

    const modelKey = normalizeModelKey(request.model);
    const current = this.calibrationByModel.get(modelKey) ?? {
      factor: 1,
      samples: 0,
    };
    const rawEstimate = estimateCompletionRequestPromptTokens(request, {
      provider: this.provider,
      calibrationFactor: 1,
    });

    if (rawEstimate <= 0) {
      return;
    }

    const observedFactor = clampNumber(promptTokens / rawEstimate, 0.5, 2.5);
    const weight = current.samples === 0 ? 1 : 0.25;
    const nextFactor = clampNumber(
      current.factor * (1 - weight) + observedFactor * weight,
      0.5,
      2.5,
    );

    this.calibrationByModel.set(modelKey, {
      factor: nextFactor,
      samples: Math.min(32, current.samples + 1),
    });
  }

  getCalibrationFactor(model: string): number {
    return this.calibrationByModel.get(normalizeModelKey(model))?.factor ?? 1;
  }
}

function estimateModelFamilyFactor(
  provider: TokenEstimatorProvider,
  model: string,
): number {
  const normalized = model.trim().toLowerCase();

  if (provider === "anthropic" || normalized.includes("claude")) {
    if (normalized.includes("opus-4") || normalized.includes("sonnet-4")) {
      return 1.06;
    }
    return 1.03;
  }

  if (provider === "openai") {
    if (normalized.includes("gpt-5")) {
      return 1.05;
    }
    if (normalized.includes("gpt-4.1") || normalized.includes("gpt-4o")) {
      return 1.02;
    }
    if (normalized.startsWith("o")) {
      return 1.08;
    }
    return 1;
  }

  return 1;
}

function normalizeModelKey(model: string): string {
  return model.trim().toLowerCase() || "unknown";
}

function safeStableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, stableStringifyReplacer);
  } catch {
    return String(value);
  }
}

function stableStringifyReplacer(_key: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  return Object.keys(value as Record<string, unknown>)
    .sort((left, right) => left.localeCompare(right))
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = (value as Record<string, unknown>)[key];
      return result;
    }, {});
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
