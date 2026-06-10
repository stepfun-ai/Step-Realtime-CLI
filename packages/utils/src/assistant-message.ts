import type {
  AssistantMessage,
  AssistantReasoningBlock,
  AssistantReasoningSectionKind,
  OpenAIToolCall,
} from "@step-cli/protocol";

const ASSISTANT_REASONING_TEXT_FIELDS = [
  "reasoning_content",
  "thinking",
  "analysis",
  "reasoning",
  "redacted_thinking",
] as const;

const ASSISTANT_REASONING_LABELS: Record<
  AssistantReasoningSectionKind,
  string
> = {
  reasoning_content: "Reasoning",
  thinking: "Thinking",
  analysis: "Analysis",
  reasoning: "Reasoning",
  redacted_thinking: "Redacted thinking",
};

const ASSISTANT_REASONING_COMPACT_LABELS: Record<
  AssistantReasoningSectionKind,
  string
> = {
  reasoning_content: "reasoning",
  thinking: "thinking",
  analysis: "analysis",
  reasoning: "reasoning",
  redacted_thinking: "redacted",
};

export interface AssistantReasoningSection {
  kind: AssistantReasoningSectionKind;
  label: string;
  text: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const text = value.trim();
  return text.length > 0 ? value : undefined;
}

function cloneToolCalls(
  toolCalls: OpenAIToolCall[] | undefined,
): OpenAIToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) {
    return undefined;
  }

  return toolCalls.map((call) => ({
    ...call,
    function: {
      ...call.function,
    },
  }));
}

function cloneThinkingBlocks(
  blocks: AssistantReasoningBlock[] | undefined,
): AssistantReasoningBlock[] | undefined {
  if (!blocks || blocks.length === 0) {
    return undefined;
  }

  return blocks.map((block) => structuredClone(block));
}

function normalizeThinkingBlocks(
  value: unknown,
): AssistantReasoningBlock[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const blocks = value
    .filter(
      (item): item is AssistantReasoningBlock =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item),
    )
    .map((item) => structuredClone(item));

  return blocks.length > 0 ? blocks : undefined;
}

function previewTextFromThinkingBlock(block: AssistantReasoningBlock): string {
  for (const key of [
    "text",
    "thinking",
    "reasoning",
    "analysis",
    "redacted_thinking",
    "data",
  ] as const) {
    const value = readNonEmptyString(block[key]);
    if (value) {
      return value;
    }
  }

  return "";
}

function normalizeComparableText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function buildReasoningSection(
  kind: AssistantReasoningSectionKind,
  text: string,
): AssistantReasoningSection {
  return {
    kind,
    label: ASSISTANT_REASONING_LABELS[kind],
    text,
  };
}

function pushReasoningSection(
  sections: AssistantReasoningSection[],
  seenTexts: Set<string>,
  kind: AssistantReasoningSectionKind,
  text: string | undefined,
): void {
  if (!text) {
    return;
  }

  const comparable = normalizeComparableText(text);
  if (comparable.length === 0 || seenTexts.has(comparable)) {
    return;
  }

  sections.push(buildReasoningSection(kind, text));
  seenTexts.add(comparable);
}

function toReasoningSectionFromBlock(
  block: AssistantReasoningBlock,
): AssistantReasoningSection | null {
  const blockType = typeof block.type === "string" ? block.type : "";

  if (blockType === "redacted_thinking") {
    const text =
      readNonEmptyString(block.redacted_thinking) ??
      readNonEmptyString(block.data) ??
      readNonEmptyString(block.text);
    return text ? buildReasoningSection("redacted_thinking", text) : null;
  }

  if (blockType === "analysis") {
    const text =
      readNonEmptyString(block.analysis) ?? readNonEmptyString(block.text);
    return text ? buildReasoningSection("analysis", text) : null;
  }

  if (blockType === "reasoning") {
    const text =
      readNonEmptyString(block.reasoning) ?? readNonEmptyString(block.text);
    return text ? buildReasoningSection("reasoning", text) : null;
  }

  if (blockType === "thinking") {
    const text =
      readNonEmptyString(block.thinking) ??
      readNonEmptyString(block.text) ??
      readNonEmptyString(block.reasoning) ??
      readNonEmptyString(block.analysis);
    return text ? buildReasoningSection("thinking", text) : null;
  }

  if (
    readNonEmptyString(block.redacted_thinking) ||
    readNonEmptyString(block.data)
  ) {
    return buildReasoningSection(
      "redacted_thinking",
      readNonEmptyString(block.redacted_thinking) ??
        readNonEmptyString(block.data) ??
        "",
    );
  }

  if (readNonEmptyString(block.analysis)) {
    return buildReasoningSection(
      "analysis",
      readNonEmptyString(block.analysis) ?? "",
    );
  }

  if (readNonEmptyString(block.reasoning)) {
    return buildReasoningSection(
      "reasoning",
      readNonEmptyString(block.reasoning) ?? "",
    );
  }

  const text =
    readNonEmptyString(block.thinking) ?? readNonEmptyString(block.text);
  return text ? buildReasoningSection("thinking", text) : null;
}

export function pickAssistantReasoningFields(
  message: unknown,
): Partial<AssistantMessage> {
  const source = asRecord(message);
  const extras: Partial<AssistantMessage> = {};

  for (const field of ASSISTANT_REASONING_TEXT_FIELDS) {
    const value = readNonEmptyString(source[field]);
    if (value) {
      extras[field] = value;
    }
  }

  const reasoningSignature = readNonEmptyString(source.reasoning_signature);
  if (reasoningSignature) {
    extras.reasoning_signature = reasoningSignature;
  }

  const thinkingBlocks = normalizeThinkingBlocks(source.thinking_blocks);
  if (thinkingBlocks) {
    extras.thinking_blocks = thinkingBlocks;
  }

  return extras;
}

export function getAssistantReasoningLabel(
  kind: AssistantReasoningSectionKind,
  options: {
    compact?: boolean;
  } = {},
): string {
  return options.compact
    ? ASSISTANT_REASONING_COMPACT_LABELS[kind]
    : ASSISTANT_REASONING_LABELS[kind];
}

export function extractAssistantReasoningSections(
  message: unknown,
): AssistantReasoningSection[] {
  const source = asRecord(message);
  const sections: AssistantReasoningSection[] = [];
  const seenTexts = new Set<string>();

  const thinkingBlocks = normalizeThinkingBlocks(source.thinking_blocks);
  for (const block of thinkingBlocks ?? []) {
    const section = toReasoningSectionFromBlock(block);
    if (section) {
      pushReasoningSection(sections, seenTexts, section.kind, section.text);
    }
  }

  for (const field of ASSISTANT_REASONING_TEXT_FIELDS) {
    pushReasoningSection(
      sections,
      seenTexts,
      field,
      readNonEmptyString(source[field]),
    );
  }

  return sections;
}

export function cloneAssistantMessage(
  message: AssistantMessage,
): AssistantMessage {
  const toolCalls = cloneToolCalls(message.tool_calls);
  const thinkingBlocks = cloneThinkingBlocks(message.thinking_blocks);

  return {
    role: "assistant",
    content: message.content,
    ...(message.spanId ? { spanId: message.spanId } : undefined),
    ...(toolCalls ? { tool_calls: toolCalls } : undefined),
    ...pickAssistantReasoningFields(message),
    ...(thinkingBlocks ? { thinking_blocks: thinkingBlocks } : undefined),
  };
}

export function assistantMessagePreviewText(message: AssistantMessage): string {
  const content = message.content.trim();
  if (content.length > 0) {
    return message.content;
  }

  const sections = extractAssistantReasoningSections(message);
  if (sections.length > 0) {
    return sections[0]!.text;
  }

  for (const block of message.thinking_blocks ?? []) {
    const preview = previewTextFromThinkingBlock(block);
    if (preview.length > 0) {
      return preview;
    }
  }

  return "";
}
