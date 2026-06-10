import type { ChatMessage } from "@step-cli/protocol";
import { estimateMessageTokens } from "@step-cli/utils/token-estimator.js";

interface ContextSelection {
  messages: ChatMessage[];
  estimatedTokens: number;
  firstIncludedIndex: number;
  omittedTokens: number;
}

interface MessageSegment {
  start: number;
  end: number;
  estimatedTokens: number;
}

export function selectMessagesWithinWindow(
  messages: ChatMessage[],
  budgetTokens: number,
  minTailMessages: number,
): ContextSelection {
  if (messages.length === 0) {
    return {
      messages: [],
      estimatedTokens: 0,
      firstIncludedIndex: 0,
      omittedTokens: 0,
    };
  }

  const safeBudget = Math.max(256, budgetTokens);
  const tailCount = Math.max(1, Math.min(messages.length, minTailMessages));
  const tailStart = messages.length - tailCount;
  const segments = buildMessageSegments(messages);
  const tailSegmentIndex = findSegmentIndexForMessage(segments, tailStart);

  let selectedSegmentIndex = tailSegmentIndex;
  let selectedTokens = 0;

  for (let index = tailSegmentIndex; index < segments.length; index += 1) {
    selectedTokens += segments[index]?.estimatedTokens ?? 0;
  }

  for (let index = tailSegmentIndex - 1; index >= 0; index -= 1) {
    const nextCost = segments[index]?.estimatedTokens ?? 0;
    if (selectedTokens + nextCost > safeBudget) {
      break;
    }
    selectedSegmentIndex = index;
    selectedTokens += nextCost;
  }

  while (
    selectedSegmentIndex < segments.length - 1 &&
    selectedTokens > safeBudget
  ) {
    selectedTokens -= segments[selectedSegmentIndex]?.estimatedTokens ?? 0;
    selectedSegmentIndex += 1;
  }

  const firstIncludedIndex = segments[selectedSegmentIndex]?.start ?? 0;
  const selected = messages.slice(firstIncludedIndex);
  const omittedTokens = messages
    .slice(0, firstIncludedIndex)
    .reduce((total, message) => total + estimateMessageTokens(message), 0);

  return {
    messages: selected,
    estimatedTokens: Math.max(0, selectedTokens),
    firstIncludedIndex,
    omittedTokens,
  };
}

export function alignBoundaryToToolCallGroup(
  messages: ChatMessage[],
  boundary: number,
): number {
  let aligned = Math.max(0, Math.min(messages.length, boundary));

  while (
    aligned > 0 &&
    aligned < messages.length &&
    messages[aligned]?.role === "tool"
  ) {
    aligned -= 1;
  }

  return aligned;
}

function buildMessageSegments(messages: ChatMessage[]): MessageSegment[] {
  const segments: MessageSegment[] = [];

  for (let index = 0; index < messages.length; ) {
    const message = messages[index];
    if (!message) {
      index += 1;
      continue;
    }

    const start = index;
    let end = index + 1;

    if (
      message.role === "assistant" &&
      message.tool_calls &&
      message.tool_calls.length > 0
    ) {
      while (end < messages.length && messages[end]?.role === "tool") {
        end += 1;
      }
    } else if (message.role === "tool") {
      while (end < messages.length && messages[end]?.role === "tool") {
        end += 1;
      }
    }

    let estimatedTokens = 0;
    for (let cursor = start; cursor < end; cursor += 1) {
      const part = messages[cursor];
      if (part) {
        estimatedTokens += estimateMessageTokens(part);
      }
    }

    segments.push({
      start,
      end,
      estimatedTokens,
    });

    index = end;
  }

  return segments;
}

function findSegmentIndexForMessage(
  segments: MessageSegment[],
  messageIndex: number,
): number {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment && messageIndex < segment.end) {
      return index;
    }
  }

  return Math.max(0, segments.length - 1);
}
