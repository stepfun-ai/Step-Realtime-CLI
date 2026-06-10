import type { ChatCompletionClient } from "@step-cli/core/model-client.js";
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  CompletionUsage,
  ModelStreamEvent,
  OpenAIReasoningEffort,
  OpenAIToolCall,
  UserAttachment,
} from "@step-cli/protocol";
import type { HttpStreamEvent, HttpTransport } from "./http-transport.js";
import { readImageAttachmentFile } from "@step-cli/utils/image-attachments.js";
import { AdaptivePromptTokenEstimator } from "@step-cli/utils/token-estimator.js";
import { repairIncompleteToolCalls } from "@step-cli/utils/tool-call-repair.js";
import { buildUserMessageTextWithAttachmentReferences } from "@step-cli/utils/user-message.js";

const DEFAULT_OPENAI_REASONING_EFFORT: OpenAIReasoningEffort = "high";
export type OpenAIEndpointKind = "chat-completions" | "responses";

export interface OpenAIClientConfig {
  baseUrl: string;
  apiKey: string;
  endpointKind?: OpenAIEndpointKind;
  reasoningEffort?: OpenAIReasoningEffort;
  timeoutMs: number;
}

export class OpenAICompatibleClient implements ChatCompletionClient {
  private readonly endpoint: string;
  private readonly endpointKind: OpenAIEndpointKind;
  private readonly apiKey: string;
  private readonly reasoningEffort: OpenAIReasoningEffort;
  private readonly timeoutMs: number;
  private readonly transport: HttpTransport;
  private readonly promptTokenEstimator = new AdaptivePromptTokenEstimator({
    provider: "openai",
  });

  constructor(config: OpenAIClientConfig, transport: HttpTransport) {
    this.endpointKind = config.endpointKind ?? "chat-completions";
    this.endpoint = resolveOpenAIEndpoint(config.baseUrl, this.endpointKind);
    this.apiKey = config.apiKey;
    this.reasoningEffort =
      config.reasoningEffort ?? DEFAULT_OPENAI_REASONING_EFFORT;
    this.timeoutMs = config.timeoutMs;
    this.transport = transport;
  }

  async createChatCompletion(
    request: CompletionRequest,
  ): Promise<CompletionResponse> {
    if (this.shouldUseResponsesStreaming()) {
      return this.createResponsesStreamCompletion(request);
    }

    const payload = await buildOpenAIRequestPayload(
      request,
      this.reasoningEffort,
      this.endpoint,
      this.endpointKind,
    );
    const response = await this.transport.request(
      this.buildHttpRequest(payload, request, false),
    );

    if (!response.ok) {
      throw new Error(
        `OpenAI-compatible API error (${response.status}): ${response.bodyText}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch {
      throw new Error(
        `Invalid JSON response from model endpoint: ${response.bodyText}`,
      );
    }

    if (this.endpointKind === "responses") {
      if (!isResponsesApiResponse(parsed)) {
        throw new Error(`Unexpected responses payload: ${response.bodyText}`);
      }

      return annotateCompletionResponseSpanId(
        toCompletionResponseFromResponsesApi(parsed, request.model),
        request.trace?.spanId,
      );
    }

    if (!isCompletionResponse(parsed)) {
      throw new Error(`Unexpected completion payload: ${response.bodyText}`);
    }

    return annotateCompletionResponseSpanId(parsed, request.trace?.spanId);
  }

  async countPromptTokens(request: CompletionRequest): Promise<number> {
    return this.promptTokenEstimator.estimatePromptTokens(request);
  }

  recordUsage(
    request: CompletionRequest,
    usage: CompletionUsage | undefined,
  ): void {
    this.promptTokenEstimator.observeUsage(request, usage);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (this.apiKey.trim().length > 0) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  async streamChatCompletion(
    request: CompletionRequest,
    onEvent: (event: ModelStreamEvent) => Promise<void> | void,
  ): Promise<CompletionResponse> {
    if (!this.shouldUseResponsesStreaming()) {
      return this.createChatCompletion(request);
    }

    return this.createResponsesStreamCompletion(request, onEvent);
  }

  private shouldUseResponsesStreaming(): boolean {
    return this.endpointKind === "responses" && !!this.transport.requestStream;
  }

  private async createResponsesStreamCompletion(
    request: CompletionRequest,
    onEvent?: (event: ModelStreamEvent) => Promise<void> | void,
  ): Promise<CompletionResponse> {
    if (!this.transport.requestStream) {
      throw new Error("Streaming transport is required for Responses API.");
    }

    const payload = await buildResponsesApiRequestPayload(
      request,
      this.reasoningEffort,
      this.endpoint,
    );
    payload.stream = true;
    const state = createResponsesStreamState();
    const response = await this.transport.requestStream(
      this.buildHttpRequest(payload, request, true),
      async (event) => {
        await handleResponsesStreamEvent(event, state, onEvent);
      },
    );

    if (!response.ok) {
      throw new Error(
        `OpenAI-compatible API error (${response.status}): ${response.bodyText}`,
      );
    }

    return annotateCompletionResponseSpanId(
      finalizeResponsesStream(state, request.model),
      request.trace?.spanId,
    );
  }

  private buildHttpRequest(
    payload: Record<string, unknown>,
    request: CompletionRequest,
    stream: boolean,
  ) {
    return {
      url: this.endpoint,
      method: "POST" as const,
      headers: this.buildHeaders(),
      body: JSON.stringify(payload),
      timeoutMs: this.timeoutMs,
      trace: {
        ...request.trace,
        provider:
          this.endpointKind === "responses"
            ? ("response" as const)
            : ("openai" as const),
        model: request.model,
        stream,
      },
      signal: request.signal,
    };
  }
}

interface ResponsesStreamState {
  readonly textBySlot: Map<string, string>;
  readonly toolCalls: OpenAIToolCall[];
  readonly seenToolCallIds: Set<string>;
  completedResponse?: Record<string, unknown> & { output: unknown[] };
  responseId?: string;
  responseObject?: string;
  createdAt?: number;
  model?: string;
}

function resolveOpenAIEndpoint(
  baseUrl: string,
  endpointKind: OpenAIEndpointKind,
): string {
  const normalized = baseUrl.replace(/\/+$/, "");

  if (endpointKind === "responses") {
    if (normalized.endsWith("/responses")) {
      return normalized;
    }
    if (normalized.endsWith("/chat/completions")) {
      return `${normalized.slice(0, -"/chat/completions".length)}/responses`;
    }
    if (normalized.endsWith("/v1")) {
      return `${normalized}/responses`;
    }
    return `${normalized}/responses`;
  }

  if (normalized.endsWith("/chat/completions")) {
    return normalized;
  }
  if (normalized.endsWith("/responses")) {
    return `${normalized.slice(0, -"/responses".length)}/chat/completions`;
  }
  return `${normalized}/chat/completions`;
}

async function buildOpenAIRequestPayload(
  request: CompletionRequest,
  reasoningEffort: OpenAIReasoningEffort,
  endpoint: string,
  endpointKind: OpenAIEndpointKind,
): Promise<Record<string, unknown>> {
  if (endpointKind === "responses") {
    return buildResponsesApiRequestPayload(request, reasoningEffort, endpoint);
  }

  return buildChatCompletionsRequestPayload(request, reasoningEffort, endpoint);
}

async function buildChatCompletionsRequestPayload(
  request: CompletionRequest,
  reasoningEffort: OpenAIReasoningEffort,
  endpoint: string,
): Promise<Record<string, unknown>> {
  const { signal: _signal, messages, ...payload } = request;
  const repairedMessages = repairIncompleteToolCalls(messages).messages;
  const body: Record<string, unknown> = {
    ...payload,
    messages: await Promise.all(
      repairedMessages.map(
        async (message) => await toOpenAIRequestMessage(message),
      ),
    ),
  };

  if (!isToolEnabledRequest(request)) {
    return body;
  }

  if (isOpenRouterEndpoint(endpoint)) {
    body.reasoning = mergeOpenRouterReasoning(body.reasoning, reasoningEffort);
    return body;
  }

  body.reasoning_effort = reasoningEffort;
  return body;
}

async function buildResponsesApiRequestPayload(
  request: CompletionRequest,
  reasoningEffort: OpenAIReasoningEffort,
  endpoint: string,
): Promise<Record<string, unknown>> {
  const repairedMessages = repairIncompleteToolCalls(request.messages).messages;
  const instructions = collectResponsesInstructions(repairedMessages);
  const body: Record<string, unknown> = {
    model: request.model,
    input: await toResponsesInputItems(repairedMessages),
  };

  if (instructions) {
    body.instructions = instructions;
  }

  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    }));
  }

  if (request.tool_choice) {
    body.tool_choice = request.tool_choice;
  }

  if (typeof request.parallel_tool_calls === "boolean") {
    body.parallel_tool_calls = request.parallel_tool_calls;
  }

  if (typeof request.temperature === "number") {
    body.temperature = request.temperature;
  }

  if (typeof request.max_tokens === "number") {
    body.max_output_tokens = request.max_tokens;
  }

  if (!isToolEnabledRequest(request)) {
    return body;
  }

  body.reasoning = isOpenRouterEndpoint(endpoint)
    ? mergeOpenRouterReasoning(body.reasoning, reasoningEffort)
    : {
        effort: reasoningEffort,
      };
  return body;
}

async function toOpenAIRequestMessage(
  message: ChatMessage,
): Promise<Record<string, unknown>> {
  if (
    message.role !== "user" ||
    !message.attachments ||
    message.attachments.length === 0
  ) {
    const { attachments: _attachments, ...rest } = message as ChatMessage & {
      attachments?: unknown;
    };
    return { ...rest };
  }

  const content: Array<Record<string, unknown>> = [];
  const text = buildUserMessageTextWithAttachmentReferences(message);
  if (text.trim().length > 0) {
    content.push({
      type: "text",
      text,
    });
  }

  for (const attachment of message.attachments) {
    content.push(await toOpenAIImagePart(attachment));
  }

  return {
    role: "user",
    content,
  };
}

function collectResponsesInstructions(
  messages: ChatMessage[],
): string | undefined {
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0);

  if (instructions.length === 0) {
    return undefined;
  }

  return instructions.join("\n\n");
}

async function toResponsesInputItems(
  messages: ChatMessage[],
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }

    if (message.role === "user") {
      items.push(await toResponsesUserMessage(message));
      continue;
    }

    if (message.role === "assistant") {
      items.push(...toResponsesAssistantItems(message));
      continue;
    }

    items.push({
      type: "function_call_output",
      call_id: message.tool_call_id,
      output: message.content,
    });
  }

  return items;
}

async function toResponsesUserMessage(
  message: Extract<ChatMessage, { role: "user" }>,
): Promise<Record<string, unknown>> {
  const content: Record<string, unknown>[] = [];
  const text = buildUserMessageTextWithAttachmentReferences(message);
  if (text.trim().length > 0 || !message.attachments?.length) {
    content.push({
      type: "input_text",
      text,
    });
  }

  for (const attachment of message.attachments ?? []) {
    content.push(await toResponsesImagePart(attachment));
  }

  return {
    role: "user",
    content,
  };
}

function toResponsesAssistantItems(
  message: Extract<ChatMessage, { role: "assistant" }>,
): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];

  if (message.content.trim().length > 0) {
    // Prior assistant messages are re-sent as INPUT items to the Responses
    // API, so the content type must be `input_text` (the OutputContent
    // `output_text` is only valid inside a fully-formed ResponseOutputMessage
    // with id/status/type:"message").
    items.push({
      role: "assistant",
      content: [
        {
          type: "input_text",
          text: message.content,
        },
      ],
    });
  }

  for (const toolCall of message.tool_calls ?? []) {
    items.push({
      type: "function_call",
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    });
  }

  return items;
}

async function toResponsesImagePart(
  attachment: UserAttachment,
): Promise<Record<string, unknown>> {
  if (attachment.kind !== "image") {
    throw new Error(
      `Unsupported OpenAI attachment kind: ${String((attachment as { kind?: unknown }).kind)}`,
    );
  }

  if (attachment.source.type === "url") {
    return {
      type: "input_image",
      image_url: attachment.source.url,
    };
  }

  const image = await readImageAttachmentFile(attachment.source.path);
  return {
    type: "input_image",
    image_url: image.dataUrl,
  };
}

async function toOpenAIImagePart(
  attachment: UserAttachment,
): Promise<Record<string, unknown>> {
  if (attachment.kind !== "image") {
    throw new Error(
      `Unsupported OpenAI attachment kind: ${String((attachment as { kind?: unknown }).kind)}`,
    );
  }

  if (attachment.source.type === "url") {
    return {
      type: "image_url",
      image_url: {
        url: attachment.source.url,
      },
    };
  }

  const image = await readImageAttachmentFile(attachment.source.path);
  return {
    type: "image_url",
    image_url: {
      url: image.dataUrl,
    },
  };
}

function isToolEnabledRequest(request: CompletionRequest): boolean {
  return Boolean(request.tools?.length && request.tool_choice !== "none");
}

function isOpenRouterEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).hostname.toLowerCase().includes("openrouter.ai");
  } catch {
    return endpoint.toLowerCase().includes("openrouter.ai");
  }
}

function mergeOpenRouterReasoning(
  currentValue: unknown,
  reasoningEffort: OpenAIReasoningEffort,
): Record<string, unknown> {
  if (
    currentValue &&
    typeof currentValue === "object" &&
    !Array.isArray(currentValue)
  ) {
    const reasoning = { ...(currentValue as Record<string, unknown>) };
    if (!("effort" in reasoning) && !("max_tokens" in reasoning)) {
      reasoning.effort = reasoningEffort;
    }
    return reasoning;
  }

  return {
    effort: reasoningEffort,
  };
}

function createResponsesStreamState(): ResponsesStreamState {
  return {
    textBySlot: new Map(),
    toolCalls: [],
    seenToolCallIds: new Set(),
  };
}

async function handleResponsesStreamEvent(
  event: HttpStreamEvent,
  state: ResponsesStreamState,
  onEvent?: (event: ModelStreamEvent) => Promise<void> | void,
): Promise<void> {
  if (event.data.trim() === "[DONE]") {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data);
  } catch {
    throw new Error(`Invalid Responses API stream event: ${event.data}`);
  }

  if (!parsed || typeof parsed !== "object") {
    return;
  }

  const candidate = parsed as Record<string, unknown>;
  const type =
    typeof candidate.type === "string" && candidate.type.length > 0
      ? candidate.type
      : event.event;

  if (type === "response.created") {
    const response = readRecord(candidate.response);
    if (response) {
      assignStreamResponseMetadata(state, response);
    }
    return;
  }

  if (
    type === "response.output_text.delta" ||
    type === "response.refusal.delta"
  ) {
    const delta = readString(candidate.delta);
    if (!delta) {
      return;
    }

    appendResponsesTextDelta(state, candidate, delta);
    await onEvent?.({
      type: "text-delta",
      text: delta,
    });
    return;
  }

  if (
    type === "response.output_text.done" ||
    type === "response.refusal.done"
  ) {
    const slot = buildResponsesTextSlotKey(candidate);
    const text = readString(candidate.text);
    if (slot && text && !state.textBySlot.has(slot)) {
      state.textBySlot.set(slot, text);
    }
    return;
  }

  if (type === "response.output_item.done") {
    const item = readRecord(candidate.item);
    if (!item) {
      return;
    }

    const toolCall = toOpenAIToolCall(item, state.toolCalls.length);
    if (toolCall && !state.seenToolCallIds.has(toolCall.id)) {
      state.seenToolCallIds.add(toolCall.id);
      state.toolCalls.push(toolCall);
      await onEvent?.({
        type: "tool-call",
        toolCall,
      });
    }
    return;
  }

  if (type === "response.completed") {
    const response = readRecord(candidate.response);
    if (response && Array.isArray(response.output)) {
      const completedResponse = response as Record<string, unknown> & {
        output: unknown[];
      };
      assignStreamResponseMetadata(state, completedResponse);
      state.completedResponse = completedResponse;
    }
    return;
  }

  if (type === "response.failed" || type === "error") {
    throw new Error(readResponsesStreamError(candidate));
  }
}

function finalizeResponsesStream(
  state: ResponsesStreamState,
  requestedModel: string,
): CompletionResponse {
  const streamedContent = Array.from(state.textBySlot.values()).join("");

  if (state.completedResponse) {
    const completion = toCompletionResponseFromResponsesApi(
      state.completedResponse,
      requestedModel,
    );
    const choice = completion.choices[0];
    if (!choice || choice.message.role !== "assistant") {
      return completion;
    }

    const mergedToolCalls = mergeResponsesToolCalls(
      choice.message.tool_calls,
      state.toolCalls,
    );
    const content =
      choice.message.content.trim().length > 0
        ? choice.message.content
        : streamedContent;

    choice.message = {
      ...choice.message,
      content,
      ...(mergedToolCalls.length > 0
        ? { tool_calls: mergedToolCalls }
        : undefined),
    };
    if (mergedToolCalls.length > 0) {
      choice.finish_reason = "tool_calls";
    }

    return completion;
  }

  return {
    id: state.responseId ?? `response-${Date.now()}`,
    object: state.responseObject ?? "response",
    created: state.createdAt ?? Math.floor(Date.now() / 1000),
    model: state.model ?? requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: streamedContent,
          ...(state.toolCalls.length > 0
            ? { tool_calls: [...state.toolCalls] }
            : undefined),
        },
        finish_reason: state.toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
  };
}

function mergeResponsesToolCalls(
  responseToolCalls: OpenAIToolCall[] | undefined,
  streamedToolCalls: OpenAIToolCall[],
): OpenAIToolCall[] {
  // When the API returns a completed response with tool_calls, it is the
  // canonical end state. Some gateways (e.g. stepfun) re-issue Chat
  // Completions-style ids ("chatcmpl-tool-XXX") on completion while the
  // streaming `output_item.done` events used Responses-native ids
  // ("call_XXX"); naively merging by id duplicates every call. Prefer
  // the completed response and fall back to the streaming accumulation
  // only when the completed response is missing tool_calls entirely.
  if (responseToolCalls?.length) {
    return [...responseToolCalls];
  }

  return [...streamedToolCalls];
}

function appendResponsesTextDelta(
  state: ResponsesStreamState,
  candidate: Record<string, unknown>,
  delta: string,
): void {
  const slot = buildResponsesTextSlotKey(candidate);
  if (!slot) {
    const fallbackSlot = "slot:default";
    state.textBySlot.set(
      fallbackSlot,
      `${state.textBySlot.get(fallbackSlot) ?? ""}${delta}`,
    );
    return;
  }

  state.textBySlot.set(slot, `${state.textBySlot.get(slot) ?? ""}${delta}`);
}

function buildResponsesTextSlotKey(
  candidate: Record<string, unknown>,
): string | null {
  const itemId = readString(candidate.item_id) ?? "_";
  const outputIndex =
    typeof candidate.output_index === "number" &&
    Number.isFinite(candidate.output_index)
      ? candidate.output_index
      : "_";
  const contentIndex =
    typeof candidate.content_index === "number" &&
    Number.isFinite(candidate.content_index)
      ? candidate.content_index
      : "_";
  if (itemId === "_" && outputIndex === "_" && contentIndex === "_") {
    return null;
  }

  return `${outputIndex}:${itemId}:${contentIndex}`;
}

function assignStreamResponseMetadata(
  state: ResponsesStreamState,
  response: Record<string, unknown>,
): void {
  const responseId = readString(response.id);
  if (responseId) {
    state.responseId = responseId;
  }

  const responseObject = readString(response.object);
  if (responseObject) {
    state.responseObject = responseObject;
  }

  const createdAt = readUsageNumber(response.created, response.created_at);
  if (createdAt !== undefined) {
    state.createdAt = createdAt;
  }

  const model = readString(response.model);
  if (model) {
    state.model = model;
  }
}

function readResponsesStreamError(candidate: Record<string, unknown>): string {
  const response = readRecord(candidate.response);
  const responseError = readRecord(response?.error);
  const errorMessage =
    readString(readRecord(candidate.error)?.message) ??
    readString(responseError?.message);
  return errorMessage ?? "Responses API stream failed";
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? value : undefined;
}

function isCompletionResponse(value: unknown): value is CompletionResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.choices)) {
    return false;
  }

  return candidate.choices.every((choice) => {
    if (!choice || typeof choice !== "object") {
      return false;
    }
    const item = choice as Record<string, unknown>;
    return typeof item.index === "number" && item.message !== undefined;
  });
}

function isResponsesApiResponse(
  value: unknown,
): value is Record<string, unknown> & { output: unknown[] } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.output);
}

function toCompletionResponseFromResponsesApi(
  response: Record<string, unknown> & { output: unknown[] },
  requestedModel: string,
): CompletionResponse {
  const textParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];

  for (let index = 0; index < response.output.length; index += 1) {
    collectResponsesOutput(response.output[index], index, textParts, toolCalls);
  }

  // Some gateways (e.g. stepfun) duplicate every function_call in
  // response.output — once with a Responses-native `call_XXX` id and once
  // with a Chat-Completions-style `chatcmpl-tool-XXX` id — even though the
  // model only emitted one call. Dedupe by {name, arguments} so a single
  // model intent does not double-fire.
  const deduped = dedupeFunctionCalls(toolCalls);
  const finalToolCalls =
    deduped.length === toolCalls.length ? toolCalls : deduped;

  const message: CompletionResponse["choices"][number]["message"] = {
    role: "assistant",
    content: textParts.join(""),
    ...(finalToolCalls.length > 0 ? { tool_calls: finalToolCalls } : undefined),
  };
  const usage = toResponsesCompletionUsage(response.usage);

  return {
    id:
      typeof response.id === "string" && response.id.length > 0
        ? response.id
        : `response-${Date.now()}`,
    object:
      typeof response.object === "string" && response.object.length > 0
        ? response.object
        : "response",
    created: readResponseCreatedTimestamp(response),
    model:
      typeof response.model === "string" && response.model.length > 0
        ? response.model
        : requestedModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    ...(usage ? { usage } : undefined),
  };
}

function dedupeFunctionCalls(toolCalls: OpenAIToolCall[]): OpenAIToolCall[] {
  if (toolCalls.length < 2) return toolCalls;
  const seen = new Set<string>();
  const out: OpenAIToolCall[] = [];
  for (const call of toolCalls) {
    const key = `${call.function.name} ${call.function.arguments}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(call);
  }
  return out;
}

function collectResponsesOutput(
  item: unknown,
  index: number,
  textParts: string[],
  toolCalls: OpenAIToolCall[],
): void {
  if (!item || typeof item !== "object") {
    return;
  }

  const candidate = item as Record<string, unknown>;
  if (candidate.type === "function_call") {
    const toolCall = toOpenAIToolCall(candidate, index);
    if (toolCall) {
      toolCalls.push(toolCall);
    }
    return;
  }

  if (candidate.type === "message") {
    collectResponsesMessageContent(candidate.content, textParts);
    return;
  }

  if (candidate.type === "output_text" && typeof candidate.text === "string") {
    textParts.push(candidate.text);
  }
}

function collectResponsesMessageContent(
  content: unknown,
  textParts: string[],
): void {
  if (typeof content === "string") {
    textParts.push(content);
    return;
  }

  if (!Array.isArray(content)) {
    return;
  }

  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }

    const candidate = part as Record<string, unknown>;
    if (
      (candidate.type === "output_text" ||
        candidate.type === "text" ||
        candidate.type === "refusal") &&
      typeof candidate.text === "string"
    ) {
      textParts.push(candidate.text);
    }
  }
}

function toOpenAIToolCall(
  item: Record<string, unknown>,
  index: number,
): OpenAIToolCall | null {
  if (typeof item.name !== "string" || item.name.length === 0) {
    return null;
  }

  return {
    id:
      typeof item.call_id === "string" && item.call_id.length > 0
        ? item.call_id
        : typeof item.id === "string" && item.id.length > 0
          ? item.id
          : `call_${index}`,
    type: "function",
    function: {
      name: item.name,
      arguments: normalizeToolArguments(item.arguments),
    },
  };
}

function normalizeToolArguments(argumentsValue: unknown): string {
  if (typeof argumentsValue === "string") {
    return argumentsValue;
  }

  if (argumentsValue === undefined) {
    return "{}";
  }

  try {
    return JSON.stringify(argumentsValue);
  } catch {
    return String(argumentsValue);
  }
}

function readResponseCreatedTimestamp(
  response: Record<string, unknown>,
): number {
  if (
    typeof response.created === "number" &&
    Number.isFinite(response.created)
  ) {
    return response.created;
  }

  if (
    typeof response.created_at === "number" &&
    Number.isFinite(response.created_at)
  ) {
    return response.created_at;
  }

  return Math.floor(Date.now() / 1000);
}

function toResponsesCompletionUsage(
  usage: unknown,
): CompletionUsage | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const candidate = usage as Record<string, unknown>;
  const promptTokens = readUsageNumber(
    candidate.input_tokens,
    candidate.prompt_tokens,
  );
  const completionTokens = readUsageNumber(
    candidate.output_tokens,
    candidate.completion_tokens,
  );
  const totalTokens =
    readUsageNumber(candidate.total_tokens) ??
    (promptTokens !== undefined || completionTokens !== undefined
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : undefined);

  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }

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

function readUsageNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function annotateCompletionResponseSpanId(
  response: CompletionResponse,
  spanId: string | undefined,
): CompletionResponse {
  if (!spanId) {
    return response;
  }

  return {
    ...response,
    choices: response.choices.map((choice) => ({
      ...choice,
      message:
        choice.message.role === "assistant"
          ? {
              ...choice.message,
              spanId,
            }
          : choice.message,
    })),
  };
}
