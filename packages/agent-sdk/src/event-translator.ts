import type {
  AgentLoopHooks,
  AgentLoopOptions,
} from "@step-cli/core/agent/agent-loop.js";
import type { AgentState } from "@step-cli/core/agent/state-machine.js";
import type {
  AssistantMessage,
  OpenAIToolCall,
  ToolExecutionResult,
} from "@step-cli/protocol";
import { safeParseJson } from "@step-cli/utils/json.js";
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKStreamEventMessage,
  SDKSystemMessage,
  SDKUserMessageFromSdk,
} from "./types.js";

export type { AgentLoopHooks };

type AgentLoopHookOpts = NonNullable<AgentLoopOptions["hooks"]>;

export interface EventTranslatorOptions {
  sessionId: string;
  emit: (message: SDKMessage) => void;
  includePartialMessages: boolean;
  /**
   * Decisions populated by canUseTool-bridge on deny. The translator emits a
   * `system{permission_denied}` event right before the matching tool_result.
   */
  pendingDenials?: Map<string, { message: string }>;
}

export function createEventTranslatorHooks(
  options: EventTranslatorOptions,
): AgentLoopHookOpts {
  const { sessionId, emit, includePartialMessages } = options;
  const pendingDenials = options.pendingDenials;
  let lastStatus: string | null | undefined = undefined;

  return {
    onModelTextDelta: ({ text }) => {
      if (!includePartialMessages || !text) return;
      const event: SDKStreamEventMessage = {
        type: "stream_event",
        session_id: sessionId,
        event: { type: "text_delta", text },
      };
      emit(event);
    },
    onAssistantMessage: ({ message }) => {
      if (includePartialMessages) {
        emitToolCallDeltas(message.tool_calls, sessionId, emit);
      }
      const assistant = translateAssistantMessage(message, sessionId);
      if (assistant) emit(assistant);
    },
    onToolResult: ({ toolName, result, toolCallId }) => {
      if (!toolCallId) {
        throw new Error(
          "event-translator: onToolResult invoked without toolCallId; AgentLoop contract violation",
        );
      }
      const denial = pendingDenials?.get(toolCallId);
      if (denial) {
        const denialEvent: SDKSystemMessage = {
          type: "system",
          session_id: sessionId,
          subtype: "permission_denied",
          tool_name: toolName,
          tool_use_id: toolCallId,
          decision_reason: denial.message,
        };
        emit(denialEvent);
        pendingDenials?.delete(toolCallId);
      }
      const toolResult = translateToolResult(result, toolCallId, sessionId);
      emit(toolResult);
    },
    onAction: (action) => {
      if (action.kind === "context_compaction") {
        const event: SDKSystemMessage = {
          type: "system",
          session_id: sessionId,
          subtype: "compact_boundary",
        };
        emit(event);
      }
    },
    onStateChange: (snapshot) => {
      const mapped = mapStateToStatus(snapshot.state);
      if (!mapped.emit) return;
      if (mapped.status === lastStatus) return;
      lastStatus = mapped.status;
      const event: SDKSystemMessage = {
        type: "system",
        session_id: sessionId,
        subtype: "status",
        status: mapped.status,
      };
      emit(event);
    },
  };
}

function emitToolCallDeltas(
  toolCalls: OpenAIToolCall[] | undefined,
  sessionId: string,
  emit: (message: SDKMessage) => void,
): void {
  if (!toolCalls || toolCalls.length === 0) return;
  for (const call of toolCalls) {
    const partial = call.function.arguments ?? "";
    if (!partial) continue;
    const event: SDKStreamEventMessage = {
      type: "stream_event",
      session_id: sessionId,
      event: {
        type: "input_json_delta",
        partial_json: partial,
        tool_use_id: call.id,
      },
    };
    emit(event);
  }
}

function translateAssistantMessage(
  message: AssistantMessage,
  sessionId: string,
): SDKAssistantMessage | null {
  const content: SDKAssistantMessage["message"]["content"] = [];
  const text = message.content?.trim();
  if (text) content.push({ type: "text", text });
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: safeParseJson<Record<string, unknown>>(call.function.arguments, {
          raw: call.function.arguments,
        }),
      });
    }
  }
  if (content.length === 0) return null;
  return {
    type: "assistant",
    session_id: sessionId,
    message: { role: "assistant", content },
  };
}

function translateToolResult(
  result: ToolExecutionResult,
  toolCallId: string,
  sessionId: string,
): SDKUserMessageFromSdk {
  const text = result.summary ?? "";
  return {
    type: "user",
    session_id: sessionId,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolCallId,
          is_error: !result.ok,
          content: text,
        },
      ],
    },
  };
}

interface MappedStatus {
  emit: boolean;
  status: string | null;
}

function mapStateToStatus(state: AgentState): MappedStatus {
  switch (state) {
    case "model_request":
      return { emit: true, status: "requesting" };
    case "context_compaction":
      return { emit: true, status: "compacting" };
    case "goal_complete":
      return { emit: true, status: null };
    case "goal_start":
    case "prepare_context":
    case "before_model_request_hooks":
    case "tool_execution":
    case "apply_tool_results":
    case "final_response":
    case "failed":
      return { emit: false, status: null };
  }
}
