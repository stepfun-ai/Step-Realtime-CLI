import type {
  AssistantMessage,
  ChatMessage,
  OpenAIToolCall,
  ToolMessage,
} from "@step-cli/protocol";
import { cloneAssistantMessage } from "./assistant-message.js";
import { cloneUserMessage } from "./user-message.js";

const SYNTHETIC_TOOL_RESULT_CODE = "TOOL_EXECUTION_ABORTED";
const SYNTHETIC_TOOL_RESULT_MESSAGE =
  "Tool call was interrupted or the turn ended before a result was recorded.";

export interface ToolCallRepairResult {
  messages: ChatMessage[];
  inserted: number;
  insertions: ToolCallRepairInsertion[];
}

export interface ToolCallRepairInsertion {
  index: number;
  position: "before" | "after";
}

export function repairIncompleteToolCalls(
  messages: ChatMessage[],
): ToolCallRepairResult {
  const repaired: ChatMessage[] = [];
  const insertions: ToolCallRepairInsertion[] = [];

  for (let index = 0; index < messages.length; ) {
    const message = messages[index];
    if (!message) {
      index += 1;
      continue;
    }

    if (message.role === "tool") {
      const orphanedToolMessages: ToolMessage[] = [];
      let nextIndex = index;

      while (nextIndex < messages.length) {
        const nextMessage = messages[nextIndex];
        if (!nextMessage || nextMessage.role !== "tool") {
          break;
        }

        orphanedToolMessages.push(cloneToolMessage(nextMessage));
        nextIndex += 1;
      }

      repaired.push(createSyntheticAssistantMessage(orphanedToolMessages));
      insertions.push({
        index,
        position: "before",
      });
      repaired.push(...orphanedToolMessages);
      index = nextIndex;
      continue;
    }

    if (
      message.role !== "assistant" ||
      !message.tool_calls ||
      message.tool_calls.length === 0
    ) {
      repaired.push(cloneChatMessage(message));
      index += 1;
      continue;
    }

    repaired.push(cloneAssistantMessage(message));

    let nextIndex = index + 1;
    const resolvedToolCallIds = new Set<string>();
    while (nextIndex < messages.length) {
      const nextMessage = messages[nextIndex];
      if (!nextMessage || nextMessage.role !== "tool") {
        break;
      }

      resolvedToolCallIds.add(nextMessage.tool_call_id);
      repaired.push(cloneChatMessage(nextMessage));
      nextIndex += 1;
    }

    for (const toolCall of message.tool_calls) {
      if (resolvedToolCallIds.has(toolCall.id)) {
        continue;
      }

      repaired.push(createSyntheticToolMessage(toolCall));
      insertions.push({
        index: nextIndex,
        position: "after",
      });
    }

    index = nextIndex;
  }

  return {
    messages: repaired,
    inserted: insertions.length,
    insertions,
  };
}

function createSyntheticAssistantMessage(
  toolMessages: ToolMessage[],
): AssistantMessage {
  return {
    role: "assistant",
    content: "",
    tool_calls: toolMessages.map((toolMessage) => ({
      id: toolMessage.tool_call_id,
      type: "function",
      function: {
        name: toolMessage.name,
        arguments: "{}",
      },
    })),
  };
}

function createSyntheticToolMessage(toolCall: OpenAIToolCall): ToolMessage {
  return {
    role: "tool",
    name: toolCall.function.name,
    tool_call_id: toolCall.id,
    content: JSON.stringify(
      {
        ok: false,
        summary: `Tool ${toolCall.function.name} was interrupted before a result was recorded.`,
        synthetic_tool_result: true,
        error: {
          code: SYNTHETIC_TOOL_RESULT_CODE,
          message: SYNTHETIC_TOOL_RESULT_MESSAGE,
        },
      },
      null,
      2,
    ),
  };
}

function cloneChatMessage(message: ChatMessage): ChatMessage {
  if (message.role === "assistant") {
    return cloneAssistantMessage(message);
  }

  if (message.role === "user") {
    return cloneUserMessage(message);
  }

  if (message.role === "tool") {
    return cloneToolMessage(message);
  }

  return {
    role: "system",
    content: message.content,
  };
}

function cloneToolMessage(message: ToolMessage): ToolMessage {
  return {
    role: "tool",
    content: message.content,
    name: message.name,
    tool_call_id: message.tool_call_id,
  };
}
