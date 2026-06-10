/**
 * Cross-layer data types for RealtimeSession, BackendAdapter, and subscribers.
 */

import type { Buffer } from "node:buffer";

export type Role = "user" | "assistant" | "system";

/** Terminal status of a long-running task (capability-agnostic). */
export type TaskStatus =
  | "done"
  | "interrupted"
  | "max_turns"
  | "max_budget"
  | "failed";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "input_audio"; transcript?: string }
  | { type: "audio"; transcript?: string }
  | { type: "function_call"; name: string; arguments: string; callId: string }
  | { type: "function_call_output"; callId: string; output: string };

export interface Message {
  id: string;
  role: Role;
  content: ContentPart[];
  metadata: {
    ts: number;
    responseId?: string;
    turnId?: string;
    synthetic?: boolean;
    interrupted?: boolean;
  };
}

export type RealtimeEvent =
  | { type: "transcript.delta"; text: string; turnId: string }
  | { type: "transcript.done"; text: string; turnId: string }
  | { type: "audio.delta"; pcm: Buffer; turnId: string }
  | { type: "audio.done"; turnId: string }
  | { type: "response.done"; turnId: string }
  | { type: "history.snapshot"; messages: Message[] }
  | { type: "history.appended"; message: Message }
  | { type: "tool_call.invoking"; callId: string; name: string }
  | {
      type: "tool_call.done";
      callId: string;
      name: string;
      ok: boolean;
      display?: string;
      sideEffect?: string;
    }
  | {
      type: "agent_config.changed";
      voice?: string;
      speedRatio?: number;
      instructions?: string;
    }
  | { type: "session.switched"; sessionId: string; title: string }
  | {
      type: "backend.trace";
      backendId: string;
      traceId?: string;
      requestId?: string;
    }
  // Generic long-running task events (capability-agnostic). The SDK does not
  // know what a task does; the owning capability fills `kind`/`data`/`detail`.
  | {
      type: "task.started";
      taskId: string;
      capabilityId: string;
      label: string;
    }
  | {
      type: "task.progress";
      taskId: string;
      capabilityId: string;
      kind: string;
      data: unknown;
    }
  | {
      type: "task.done";
      taskId: string;
      capabilityId: string;
      status: TaskStatus;
      summary?: string;
      detail?: unknown;
    }
  | {
      type: "task.error";
      taskId: string;
      capabilityId: string;
      message: string;
    }
  | {
      type: "audio.cancelled";
      turnId: string;
      reason: "barge_in" | "user_cancel" | "backend_error" | "playback_flush";
    }
  | {
      type: "mode.changed";
      mode: "ptt" | "duplex";
      reason: "user" | "fallback" | "init";
    }
  | { type: "error"; code: string; message: string };

export interface SerializedMessage {
  id: string;
  role: Role;
  content: Array<{
    type: ContentPart["type"];
    text?: string;
    transcript?: string;
    callId?: string;
    name?: string;
    arguments?: string;
    output?: string;
  }>;
  metadata: { ts: number; synthetic?: boolean; interrupted?: boolean };
}

export function serializeMessage(m: Message): SerializedMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content.map((c) => {
      switch (c.type) {
        case "text":
          return { type: c.type, text: c.text };
        case "input_audio":
        case "audio":
          return { type: c.type, transcript: c.transcript };
        case "function_call":
          return {
            type: c.type,
            name: c.name,
            arguments: c.arguments,
            callId: c.callId,
          };
        case "function_call_output":
          return { type: c.type, callId: c.callId, output: c.output };
      }
    }),
    metadata: {
      ts: m.metadata.ts,
      synthetic: m.metadata.synthetic,
      interrupted: m.metadata.interrupted,
    },
  };
}
