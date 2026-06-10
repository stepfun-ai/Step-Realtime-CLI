import type { ChatMessage, StepCliContextAssembly } from "@step-cli/protocol";
import { cloneAssistantMessage } from "@step-cli/utils/assistant-message.js";
import { cloneUserMessage } from "@step-cli/utils/user-message.js";
import { cloneCheckpoint } from "./conversation-memory-checkpoint.js";

export function cloneContextAssembly(
  value: StepCliContextAssembly,
): StepCliContextAssembly;
export function cloneContextAssembly(
  value: StepCliContextAssembly | undefined,
): StepCliContextAssembly | undefined;
export function cloneContextAssembly(
  value: StepCliContextAssembly | undefined,
): StepCliContextAssembly | undefined {
  if (!value) {
    return undefined;
  }

  return {
    systemPrompt: { ...value.systemPrompt },
    summary: value.summary,
    compactedUserMessages: [...value.compactedUserMessages],
    decisionChain: [...value.decisionChain],
    transcriptRefs: value.transcriptRefs.map((entry) => ({ ...entry })),
    window: {
      summarizedUntil: value.window.summarizedUntil,
      firstIncludedIndex: value.window.firstIncludedIndex,
      availableMessages: value.window.availableMessages,
      omittedMessages: value.window.omittedMessages,
      omittedTokens: value.window.omittedTokens,
      budgetTokens: value.window.budgetTokens,
      baseTokens: value.window.baseTokens,
      selectedTokens: value.window.selectedTokens,
      baseMessages: value.window.baseMessages.map(cloneContextMessage),
      selectedMessages: value.window.selectedMessages.map((entry) => ({
        index: entry.index,
        message: cloneContextMessage(entry.message),
      })),
    },
    usage: { ...value.usage },
    ...(value.checkpoint
      ? { checkpoint: cloneCheckpoint(value.checkpoint) }
      : undefined),
    ...(value.currentUserTurn
      ? {
          currentUserTurn: {
            index: value.currentUserTurn.index,
            message: cloneContextMessage(value.currentUserTurn.message),
          },
        }
      : undefined),
    ...(value.observability
      ? {
          observability: {
            baseMemory: {
              totalMessages: value.observability.baseMemory.totalMessages,
              totalTokens: value.observability.baseMemory.totalTokens,
              entries: value.observability.baseMemory.entries.map((entry) => ({
                ...entry,
              })),
            },
            transcriptRefs: {
              availableCount: value.observability.transcriptRefs.availableCount,
              selectedCount: value.observability.transcriptRefs.selectedCount,
              selectedPaths: [
                ...value.observability.transcriptRefs.selectedPaths,
              ],
            },
            liveMessages: {
              availableCount: value.observability.liveMessages.availableCount,
              selectedCount: value.observability.liveMessages.selectedCount,
              omittedCount: value.observability.liveMessages.omittedCount,
              availableTokens: value.observability.liveMessages.availableTokens,
              selectedTokens: value.observability.liveMessages.selectedTokens,
              omittedTokens: value.observability.liveMessages.omittedTokens,
              entries: value.observability.liveMessages.entries.map(
                (entry) => ({
                  ...entry,
                }),
              ),
            },
            budget: { ...value.observability.budget },
            compaction: value.observability.compaction.latest
              ? {
                  latest: { ...value.observability.compaction.latest },
                }
              : {},
          },
        }
      : undefined),
  };
}

function cloneContextMessage(message: ChatMessage): ChatMessage {
  if (message.role === "assistant") {
    return cloneAssistantMessage(message);
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      name: message.name,
      tool_call_id: message.tool_call_id,
      ...(message.spanId ? { spanId: message.spanId } : undefined),
    };
  }

  if (message.role === "system") {
    return {
      role: "system",
      content: message.content,
    };
  }

  return cloneUserMessage(message);
}
