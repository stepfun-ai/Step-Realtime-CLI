import type {
  AssistantReasoningBlock,
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  CompletionUsage,
  ModelStreamEvent,
  OpenAIToolCall,
  OpenAIToolDefinition,
  UserAttachment,
} from "@step-cli/protocol";
import type { HttpStreamEvent, HttpTransport } from "./http-transport.js";
import { readImageAttachmentFile } from "@step-cli/utils/image-attachments.js";
import { AdaptivePromptTokenEstimator } from "@step-cli/utils/token-estimator.js";
import { repairIncompleteToolCalls } from "@step-cli/utils/tool-call-repair.js";
import { buildUserMessageTextWithAttachmentReferences } from "@step-cli/utils/user-message.js";
import type { ChatCompletionClient } from "@step-cli/core/model-client.js";

const MIN_ANTHROPIC_THINKING_BUDGET_TOKENS = 1_024;
const DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS = 16_000;

export interface AnthropicClientConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  anthropicVersion?: string;
  anthropicThinkingBudgetTokens?: number;
}

type AnthropicContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      source:
        | {
            type: "url";
            url: string;
          }
        | {
            type: "base64";
            media_type: string;
            data: string;
          };
    }
  | {
      type: "thinking";
      thinking: string;
      signature?: string;
    }
  | {
      type: "redacted_thinking";
      data: string;
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicToolChoice {
  type: "auto" | "any";
  disable_parallel_tool_use?: boolean;
}

interface AnthropicThinkingConfig {
  type: "enabled";
  budget_tokens: number;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string;
  tools?: AnthropicToolDefinition[];
  tool_choice?: AnthropicToolChoice;
  thinking?: AnthropicThinkingConfig;
  temperature?: number;
  stream?: boolean;
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: "assistant";
  model: string;
  content: Array<Record<string, unknown>>;
  stop_reason: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface AnthropicCountTokensResponse {
  input_tokens: number;
}

type AnthropicStreamBlockState =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "thinking";
      thinking: string;
      signature?: string;
    }
  | {
      type: "redacted_thinking";
      data: string;
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      initialInput?: unknown;
      partialJson: string;
    };

export class AnthropicMessagesClient implements ChatCompletionClient {
  private readonly endpoint: string;
  private readonly countEndpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly transport: HttpTransport;
  private readonly anthropicVersion: string;
  private readonly anthropicThinkingBudgetTokens?: number;
  private readonly promptTokenEstimator = new AdaptivePromptTokenEstimator({
    provider: "anthropic",
  });
  private countEndpointAvailable: boolean | undefined;

  constructor(config: AnthropicClientConfig, transport: HttpTransport) {
    this.endpoint = resolveAnthropicEndpoint(config.baseUrl);
    this.countEndpoint = resolveAnthropicCountTokensEndpoint(config.baseUrl);
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs;
    this.transport = transport;
    this.anthropicVersion = config.anthropicVersion ?? "2023-06-01";
    this.anthropicThinkingBudgetTokens =
      config.anthropicThinkingBudgetTokens ??
      DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS;
  }

  async createChatCompletion(
    request: CompletionRequest,
  ): Promise<CompletionResponse> {
    const anthropicRequest = await toAnthropicRequest(request, {
      anthropicThinkingBudgetTokens: this.anthropicThinkingBudgetTokens,
    });
    const response = await this.transport.request(
      this.buildHttpRequest(anthropicRequest, request.signal, request.trace),
    );

    if (!response.ok) {
      throw new Error(
        `Anthropic Messages API error (${response.status}): ${response.bodyText}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch {
      throw new Error(
        `Invalid JSON response from Anthropic endpoint: ${response.bodyText}`,
      );
    }

    if (!isAnthropicResponse(parsed)) {
      throw new Error(`Unexpected Anthropic payload: ${response.bodyText}`);
    }

    return toCompletionResponse(parsed, request.model, request.trace?.spanId);
  }

  async countPromptTokens(request: CompletionRequest): Promise<number> {
    if (this.countEndpointAvailable !== false) {
      try {
        const anthropicRequest = await toAnthropicRequest(request, {
          anthropicThinkingBudgetTokens: this.anthropicThinkingBudgetTokens,
        });
        const response = await this.transport.request({
          url: this.countEndpoint,
          method: "POST",
          headers: this.buildHeaders(anthropicRequest),
          body: JSON.stringify(anthropicRequest),
          timeoutMs: this.timeoutMs,
          signal: request.signal,
        });

        if (response.ok) {
          const parsed = JSON.parse(response.bodyText) as unknown;
          if (isAnthropicCountTokensResponse(parsed)) {
            this.countEndpointAvailable = true;
            return parsed.input_tokens;
          }
        } else if (
          isUnsupportedCountEndpointResponse(response.status, response.bodyText)
        ) {
          this.countEndpointAvailable = false;
        }
      } catch {
        // Fall through to the calibrated local estimator.
      }
    }

    return this.promptTokenEstimator.estimatePromptTokens(request);
  }

  recordUsage(
    request: CompletionRequest,
    usage: CompletionUsage | undefined,
  ): void {
    this.promptTokenEstimator.observeUsage(request, usage);
  }

  async streamChatCompletion(
    request: CompletionRequest,
    onEvent: (event: ModelStreamEvent) => Promise<void> | void,
  ): Promise<CompletionResponse> {
    if (!this.transport.requestStream) {
      return this.createChatCompletion(request);
    }

    const streamState = createAnthropicStreamState(request.model);
    const anthropicRequest = {
      ...(await toAnthropicRequest(request, {
        anthropicThinkingBudgetTokens: this.anthropicThinkingBudgetTokens,
      })),
      stream: true,
    };

    const response = await this.transport.requestStream(
      this.buildHttpRequest(anthropicRequest, request.signal, {
        ...request.trace,
        stream: true,
      }),
      async (event) => {
        await handleAnthropicStreamEvent(event, streamState, onEvent);
      },
    );

    if (!response.ok) {
      throw new Error(
        `Anthropic Messages API error (${response.status}): ${response.bodyText}`,
      );
    }

    return toCompletionResponse(
      finalizeAnthropicStream(streamState),
      request.model,
      request.trace?.spanId,
    );
  }

  private buildHeaders(request: AnthropicRequest): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": this.anthropicVersion,
    };

    if (shouldUseInterleavedThinkingBeta(request)) {
      headers["anthropic-beta"] = ANTHROPIC_INTERLEAVED_THINKING_BETA;
    }

    if (this.apiKey.trim().length > 0) {
      headers["x-api-key"] = this.apiKey;
    }

    return headers;
  }

  private buildHttpRequest(
    request: AnthropicRequest,
    signal?: AbortSignal,
    trace?: CompletionRequest["trace"],
  ) {
    return {
      url: this.endpoint,
      method: "POST" as const,
      headers: this.buildHeaders(request),
      body: JSON.stringify(request),
      timeoutMs: this.timeoutMs,
      trace: {
        ...trace,
        provider: "anthropic" as const,
        model: request.model,
        stream: request.stream === true,
      },
      signal,
    };
  }
}

const ANTHROPIC_INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

async function toAnthropicRequest(
  request: CompletionRequest,
  options: {
    anthropicThinkingBudgetTokens?: number;
  } = {},
): Promise<AnthropicRequest> {
  const { system, messages } = await convertMessages(request.messages);
  const includeTools = Boolean(
    request.tools && request.tools.length > 0 && request.tool_choice !== "none",
  );
  const thinkingBudgetTokens = resolveAnthropicThinkingBudgetTokens({
    configuredBudgetTokens: options.anthropicThinkingBudgetTokens,
    includeTools,
  });

  const payload: AnthropicRequest = {
    model: request.model,
    messages,
    max_tokens: request.max_tokens ?? 1024,
  };

  if (thinkingBudgetTokens !== undefined) {
    if (request.tool_choice === "required") {
      throw new Error(
        "Anthropic extended thinking is incompatible with required tool_choice",
      );
    }
    if (payload.max_tokens <= thinkingBudgetTokens) {
      throw new Error(
        `Anthropic thinking budget (${thinkingBudgetTokens}) must be smaller than max_tokens (${payload.max_tokens})`,
      );
    }
    payload.thinking = {
      type: "enabled",
      budget_tokens: thinkingBudgetTokens,
    };
  }

  if (system.trim().length > 0) {
    payload.system = system;
  }

  if (
    typeof request.temperature === "number" &&
    thinkingBudgetTokens === undefined
  ) {
    payload.temperature = request.temperature;
  }

  if (includeTools) {
    payload.tools = (request.tools ?? []).map(toAnthropicTool);

    if (request.tool_choice === "required") {
      payload.tool_choice = {
        type: "any",
        ...(request.parallel_tool_calls === false
          ? { disable_parallel_tool_use: true }
          : undefined),
      };
    } else {
      payload.tool_choice = {
        type: "auto",
        ...(request.parallel_tool_calls === false
          ? { disable_parallel_tool_use: true }
          : undefined),
      };
    }
  }

  return payload;
}

function resolveAnthropicThinkingBudgetTokens(input: {
  configuredBudgetTokens?: number;
  includeTools: boolean;
}): number | undefined {
  if (!input.includeTools) {
    return undefined;
  }

  const budgetTokens =
    input.configuredBudgetTokens ?? DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS;

  if (budgetTokens < MIN_ANTHROPIC_THINKING_BUDGET_TOKENS) {
    throw new Error(
      `Anthropic thinking budget must be >= ${MIN_ANTHROPIC_THINKING_BUDGET_TOKENS} tokens`,
    );
  }

  return budgetTokens;
}

function shouldUseInterleavedThinkingBeta(request: AnthropicRequest): boolean {
  return Boolean(
    request.thinking &&
    request.tools?.length &&
    supportsInterleavedThinking(request.model),
  );
}

function supportsInterleavedThinking(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    normalized.includes("claude-opus-4") ||
    normalized.includes("claude-sonnet-4")
  );
}

async function convertMessages(
  messages: ChatMessage[],
): Promise<{ system: string; messages: AnthropicMessage[] }> {
  const repairedMessages = repairIncompleteToolCalls(messages).messages;
  const systemParts: string[] = [];
  const anthropicMessages: AnthropicMessage[] = [];
  const pendingToolResults: AnthropicContentBlock[] = [];

  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) {
      return;
    }

    anthropicMessages.push({
      role: "user",
      content: [...pendingToolResults],
    });
    pendingToolResults.length = 0;
  };

  for (const message of repairedMessages) {
    if (message.role === "system") {
      if (message.content.trim().length > 0) {
        systemParts.push(message.content);
      }
      continue;
    }

    if (message.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: sanitizeToolUseId(message.tool_call_id),
        content: message.content,
      });
      continue;
    }

    flushToolResults();

    if (message.role === "user") {
      const contentBlocks = await toAnthropicUserContentBlocks(message);
      if (contentBlocks.length === 0) {
        continue;
      }
      anthropicMessages.push({
        role: "user",
        content: contentBlocks,
      });
      continue;
    }

    const contentBlocks: AnthropicContentBlock[] = [
      ...toAnthropicThinkingBlocks(message),
    ];
    if (message.content.trim().length > 0) {
      contentBlocks.push({
        type: "text",
        text: message.content,
      });
    }

    for (const toolCall of message.tool_calls ?? []) {
      contentBlocks.push({
        type: "tool_use",
        id: sanitizeToolUseId(toolCall.id),
        name: toolCall.function.name,
        input: parseToolArguments(toolCall.function.arguments),
      });
    }

    if (contentBlocks.length > 0) {
      anthropicMessages.push({
        role: "assistant",
        content: contentBlocks,
      });
    }
  }

  flushToolResults();

  return {
    system: systemParts.join("\n\n"),
    messages: anthropicMessages,
  };
}

async function toAnthropicUserContentBlocks(
  message: Extract<ChatMessage, { role: "user" }>,
): Promise<AnthropicContentBlock[]> {
  const contentBlocks: AnthropicContentBlock[] = [];

  const text = buildUserMessageTextWithAttachmentReferences(message);
  if (text.trim().length > 0) {
    contentBlocks.push({
      type: "text",
      text,
    });
  }

  for (const attachment of message.attachments ?? []) {
    contentBlocks.push(await toAnthropicImageBlock(attachment));
  }

  return contentBlocks;
}

async function toAnthropicImageBlock(
  attachment: UserAttachment,
): Promise<AnthropicContentBlock> {
  if (attachment.kind !== "image") {
    throw new Error(
      `Unsupported Anthropic attachment kind: ${String((attachment as { kind?: unknown }).kind)}`,
    );
  }

  if (attachment.source.type === "url") {
    return {
      type: "image",
      source: {
        type: "url",
        url: attachment.source.url,
      },
    };
  }

  const image = await readImageAttachmentFile(attachment.source.path);
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: image.mediaType,
      data: image.dataBase64,
    },
  };
}

function toAnthropicThinkingBlocks(
  message: Extract<ChatMessage, { role: "assistant" }>,
): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];

  for (const block of message.thinking_blocks ?? []) {
    const type =
      typeof block.type === "string" ? block.type.trim().toLowerCase() : "";
    if (type === "thinking") {
      const thinking =
        typeof block.thinking === "string"
          ? block.thinking
          : typeof block.text === "string"
            ? block.text
            : "";
      const signature =
        typeof block.signature === "string" ? block.signature : undefined;
      if (thinking.trim().length === 0) {
        continue;
      }
      if (!signature || signature.trim().length === 0) {
        continue;
      }

      blocks.push({
        type: "thinking",
        thinking,
        signature,
      });
      continue;
    }

    if (type === "redacted_thinking") {
      const data =
        typeof block.data === "string"
          ? block.data
          : typeof block.redacted_thinking === "string"
            ? block.redacted_thinking
            : "";
      if (data.trim().length === 0) {
        continue;
      }

      blocks.push({
        type: "redacted_thinking",
        data,
      });
    }
  }

  return blocks;
}

function toAnthropicTool(tool: OpenAIToolDefinition): AnthropicToolDefinition {
  return {
    name: tool.function.name,
    description: tool.function.description,
    input_schema: (tool.function.parameters as Record<string, unknown>) ?? {
      type: "object",
      properties: {},
    },
  };
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }

    return {
      value: parsed,
    };
  } catch {
    return {
      _raw: raw,
    };
  }
}

function normalizeToolInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (value === undefined) {
    return {};
  }

  return {
    value,
  };
}

function createAnthropicStreamState(fallbackModel: string): {
  id: string;
  model: string;
  stopReason: string | null;
  usage?: AnthropicResponse["usage"];
  blocks: AnthropicStreamBlockState[];
} {
  return {
    id: `anthropic-stream-${Date.now()}`,
    model: fallbackModel,
    stopReason: null,
    usage: undefined,
    blocks: [],
  };
}

async function handleAnthropicStreamEvent(
  event: HttpStreamEvent,
  state: ReturnType<typeof createAnthropicStreamState>,
  onEvent: (event: ModelStreamEvent) => Promise<void> | void,
): Promise<void> {
  if (event.data === "[DONE]") {
    return;
  }

  const parsed = parseAnthropicStreamPayload(event);
  const eventType = typeof parsed.type === "string" ? parsed.type : event.event;

  switch (eventType) {
    case "ping":
    case "content_block_stop":
    case "message_stop":
      return;

    case "error":
      throw new Error(extractAnthropicStreamError(parsed));

    case "message_start": {
      const message = asRecord(parsed.message);
      if (typeof message.id === "string" && message.id.trim().length > 0) {
        state.id = message.id;
      }
      if (
        typeof message.model === "string" &&
        message.model.trim().length > 0
      ) {
        state.model = message.model;
      }
      mergeAnthropicUsage(state, asRecord(message.usage));
      return;
    }

    case "content_block_start": {
      const index = toNonNegativeInteger(parsed.index);
      const contentBlock = asRecord(parsed.content_block);
      const blockType =
        typeof contentBlock.type === "string" ? contentBlock.type : "";
      if (index === null || blockType.length === 0) {
        return;
      }

      if (blockType === "text") {
        const text =
          typeof contentBlock.text === "string" ? contentBlock.text : "";
        state.blocks[index] = {
          type: "text",
          text,
        };
        if (text.length > 0) {
          await onEvent({
            type: "text-delta",
            text,
          });
        }
        return;
      }

      if (blockType === "thinking") {
        state.blocks[index] = {
          type: "thinking",
          thinking:
            typeof contentBlock.thinking === "string"
              ? contentBlock.thinking
              : "",
          ...(typeof contentBlock.signature === "string"
            ? { signature: contentBlock.signature }
            : undefined),
        };
        return;
      }

      if (blockType === "redacted_thinking") {
        state.blocks[index] = {
          type: "redacted_thinking",
          data: typeof contentBlock.data === "string" ? contentBlock.data : "",
        };
        return;
      }

      if (blockType === "tool_use") {
        const id = sanitizeToolUseId(
          typeof contentBlock.id === "string"
            ? contentBlock.id
            : `tool_${index + 1}`,
        );
        const name =
          typeof contentBlock.name === "string"
            ? contentBlock.name
            : "unknown_tool";
        const initialInput = contentBlock.input;
        state.blocks[index] = {
          type: "tool_use",
          id,
          name,
          initialInput,
          partialJson: "",
        };
        await onEvent({
          type: "tool-call",
          toolCall: {
            id,
            type: "function",
            function: {
              name,
              arguments: JSON.stringify(normalizeToolInput(initialInput)),
            },
          },
        });
      }
      return;
    }

    case "content_block_delta": {
      const index = toNonNegativeInteger(parsed.index);
      const delta = asRecord(parsed.delta);
      const deltaType = typeof delta.type === "string" ? delta.type : "";
      if (index === null || deltaType.length === 0) {
        return;
      }

      const block = state.blocks[index];
      if (!block) {
        return;
      }

      if (block.type === "text" && deltaType === "text_delta") {
        const text = typeof delta.text === "string" ? delta.text : "";
        if (text.length > 0) {
          block.text += text;
          await onEvent({
            type: "text-delta",
            text,
          });
        }
        return;
      }

      if (block.type === "thinking" && deltaType === "thinking_delta") {
        const thinking =
          typeof delta.thinking === "string" ? delta.thinking : "";
        if (thinking.length > 0) {
          block.thinking += thinking;
        }
        return;
      }

      if (block.type === "thinking" && deltaType === "signature_delta") {
        const signature =
          typeof delta.signature === "string" ? delta.signature : "";
        if (signature.length > 0) {
          block.signature = signature;
        }
        return;
      }

      if (block.type === "tool_use" && deltaType === "input_json_delta") {
        const partialJson =
          typeof delta.partial_json === "string" ? delta.partial_json : "";
        if (partialJson.length > 0) {
          block.partialJson += partialJson;
        }
      }
      return;
    }

    case "message_delta": {
      const delta = asRecord(parsed.delta);
      if (typeof delta.stop_reason === "string" || delta.stop_reason === null) {
        state.stopReason = delta.stop_reason as string | null;
      }
      mergeAnthropicUsage(state, asRecord(parsed.usage));
      return;
    }

    default:
      return;
  }
}

function finalizeAnthropicStream(
  state: ReturnType<typeof createAnthropicStreamState>,
): AnthropicResponse {
  const content: Array<Record<string, unknown>> = [];
  for (const block of state.blocks) {
    if (!block) {
      continue;
    }

    if (block.type === "text") {
      content.push({
        type: "text",
        text: block.text,
      });
      continue;
    }

    if (block.type === "thinking") {
      content.push({
        type: "thinking",
        thinking: block.thinking,
        ...(block.signature ? { signature: block.signature } : undefined),
      });
      continue;
    }

    if (block.type === "redacted_thinking") {
      content.push({
        type: "redacted_thinking",
        data: block.data,
      });
      continue;
    }

    content.push({
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: parseAnthropicToolInput(block),
    });
  }

  return {
    id: state.id,
    type: "message",
    role: "assistant",
    model: state.model,
    content,
    stop_reason: state.stopReason,
    usage: state.usage,
  };
}

function parseAnthropicToolInput(
  block: Extract<AnthropicStreamBlockState, { type: "tool_use" }>,
): Record<string, unknown> {
  const partialJson = block.partialJson.trim();
  if (partialJson.length === 0) {
    return normalizeToolInput(block.initialInput);
  }

  try {
    return normalizeToolInput(JSON.parse(partialJson));
  } catch {
    return {
      ...normalizeToolInput(block.initialInput),
      _raw: partialJson,
    };
  }
}

function parseAnthropicStreamPayload(
  event: HttpStreamEvent,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(event.data) as unknown;
    return asRecord(parsed);
  } catch {
    throw new Error(
      `Invalid Anthropic stream payload for event '${event.event}': ${event.data}`,
    );
  }
}

function extractAnthropicStreamError(payload: Record<string, unknown>): string {
  const error = asRecord(payload.error);
  const message =
    typeof error.message === "string"
      ? error.message
      : typeof payload.message === "string"
        ? payload.message
        : "Unknown Anthropic stream error";
  const type =
    typeof error.type === "string"
      ? error.type
      : typeof payload.type === "string"
        ? payload.type
        : "";
  return type.length > 0 ? `${type}: ${message}` : message;
}

function mergeAnthropicUsage(
  state: ReturnType<typeof createAnthropicStreamState>,
  usage: Record<string, unknown>,
): void {
  if (Object.keys(usage).length === 0) {
    return;
  }

  state.usage = {
    ...state.usage,
    ...(typeof usage.input_tokens === "number"
      ? { input_tokens: usage.input_tokens }
      : undefined),
    ...(typeof usage.output_tokens === "number"
      ? { output_tokens: usage.output_tokens }
      : undefined),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function toNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function toCompletionResponse(
  response: AnthropicResponse,
  fallbackModel: string,
  spanId?: string,
): CompletionResponse {
  const contentParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];
  const thinkingParts: string[] = [];
  const redactedThinkingParts: string[] = [];
  const thinkingBlocks: AssistantReasoningBlock[] = [];
  let reasoningSignature: string | undefined;

  for (const block of response.content) {
    const blockType = typeof block.type === "string" ? block.type : "";

    if (blockType === "text") {
      const text = typeof block.text === "string" ? block.text : "";
      if (text.length > 0) {
        contentParts.push(text);
      }
      continue;
    }

    if (blockType === "thinking") {
      const thinking = typeof block.thinking === "string" ? block.thinking : "";
      const signature =
        typeof block.signature === "string" ? block.signature : undefined;
      if (thinking.trim().length > 0) {
        thinkingParts.push(thinking);
      }
      if (signature && signature.trim().length > 0) {
        reasoningSignature = signature;
      }
      thinkingBlocks.push({
        type: "thinking",
        thinking,
        text: thinking,
        ...(signature ? { signature } : undefined),
      });
      continue;
    }

    if (blockType === "redacted_thinking") {
      const data = typeof block.data === "string" ? block.data : "";
      if (data.trim().length > 0) {
        redactedThinkingParts.push(data);
      }
      thinkingBlocks.push({
        type: "redacted_thinking",
        data,
        redacted_thinking: data,
      });
      continue;
    }

    if (blockType === "tool_use") {
      const id = sanitizeToolUseId(
        typeof block.id === "string"
          ? block.id
          : `tool_${toolCalls.length + 1}`,
      );
      const name = typeof block.name === "string" ? block.name : "unknown_tool";
      const input = block.input;
      toolCalls.push({
        id,
        type: "function",
        function: {
          name,
          arguments: JSON.stringify(input ?? {}),
        },
      });
    }
  }

  const usage = mapUsage(response.usage);
  const thinking = thinkingParts.join("\n\n");
  const redactedThinking = redactedThinkingParts.join("\n\n");

  return {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: response.model || fallbackModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: contentParts.join(""),
          ...(spanId ? { spanId } : undefined),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : undefined),
          ...(thinking.length > 0
            ? { thinking, reasoning_content: thinking }
            : undefined),
          ...(redactedThinking.length > 0
            ? { redacted_thinking: redactedThinking }
            : undefined),
          ...(reasoningSignature
            ? { reasoning_signature: reasoningSignature }
            : undefined),
          ...(thinkingBlocks.length > 0
            ? { thinking_blocks: thinkingBlocks }
            : undefined),
        },
        finish_reason: mapFinishReason(response.stop_reason),
      },
    ],
    ...(usage ? { usage } : undefined),
  };
}

function mapUsage(
  usage: AnthropicResponse["usage"],
): CompletionUsage | undefined {
  if (!usage) {
    return undefined;
  }

  const promptTokens =
    typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const completionTokens =
    typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;

  if (promptTokens === undefined && completionTokens === undefined) {
    return undefined;
  }

  const totalTokens =
    promptTokens !== undefined && completionTokens !== undefined
      ? promptTokens + completionTokens
      : undefined;

  return {
    ...(promptTokens !== undefined
      ? { prompt_tokens: promptTokens }
      : undefined),
    ...(completionTokens !== undefined
      ? { completion_tokens: completionTokens }
      : undefined),
    ...(totalTokens !== undefined ? { total_tokens: totalTokens } : undefined),
  };
}

function mapFinishReason(stopReason: string | null): string | null {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "pause_turn":
      return "stop";
    default:
      return stopReason;
  }
}

function resolveAnthropicEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/v1/messages") || normalized.endsWith("/messages")) {
    return normalized;
  }
  if (normalized.endsWith("/v1")) {
    return `${normalized}/messages`;
  }
  return `${normalized}/v1/messages`;
}

function resolveAnthropicCountTokensEndpoint(baseUrl: string): string {
  const endpoint = resolveAnthropicEndpoint(baseUrl);
  return endpoint.replace(/\/messages$/, "/messages/count_tokens");
}

function sanitizeToolUseId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return sanitized.length > 0 ? sanitized : "tool_1";
}

function isAnthropicResponse(value: unknown): value is AnthropicResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  if (typeof candidate.id !== "string") {
    return false;
  }

  if (typeof candidate.role !== "string") {
    return false;
  }

  if (!Array.isArray(candidate.content)) {
    return false;
  }

  return true;
}

function isAnthropicCountTokensResponse(
  value: unknown,
): value is AnthropicCountTokensResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  return typeof (value as Record<string, unknown>).input_tokens === "number";
}

function isUnsupportedCountEndpointResponse(
  status: number,
  bodyText: string,
): boolean {
  if (status === 404 || status === 405 || status === 501) {
    return true;
  }

  const normalized = bodyText.trim().toLowerCase();
  return (
    normalized.includes("count_tokens") && normalized.includes("not found")
  );
}
