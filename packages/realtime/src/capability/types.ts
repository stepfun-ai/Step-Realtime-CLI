/**
 * Capability — a self-contained tool the realtime model can call.
 *
 * P3 scope: synchronous one-shot. invoke(req) -> Promise<Result>.
 * P4 will extend with handle-based streaming for long tasks (coding_agent).
 */

import type { Client } from "../client/types.js";
import type { SessionControl } from "./session-control.js";

export interface ParamSchema {
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  items?: ParamSchema;
  properties?: Record<string, ParamSchema>;
  required?: string[];
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ParamSchema>;
    required?: string[];
  };
}

export interface CapabilityTraits {
  latencyClass: "instant" | "seconds" | "minutes";
  streaming: boolean;
  cancellable: boolean;
  stateful: boolean;
  sideEffects: "read-only" | "local-write" | "external-write" | "harness-self";
}

export interface ToolCallRequest {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface CapabilityResult {
  callId: string;
  ok: boolean;
  /** What gets fed back to the model as the function_call_output. JSON
   *  or plain text both acceptable. */
  output: string;
  /** Optional short display text for the UI (e.g. "查询了时间"). */
  display?: string;
  /** Optional side-effect note for the UI (e.g. "已切换音色 → alloy"). */
  sideEffect?: string;
  /** P5.5: tool returned synchronously but the actual work is deferred to
   *  a background task (e.g. coding_agent returning `{status: "started"}`).
   *  When true, the SM sends function_call_output to the backend but does
   *  NOT fire a follow-up response.create — there's nothing real to talk
   *  about yet. The realtime model's pre-call utterance (in the response
   *  that produced the function_call) IS the acknowledgement; a separate
   *  follow-up would be a redundant second speech. The actual task result
   *  reaches the model later via a notify()-injected synthetic user turn. */
  deferred?: boolean;
}

/** Construction context. Capabilities may need a Client (for memory) and/or
 *  SessionControl (for runtime config). They opt in by reading these
 *  optional fields. */
export interface CapabilityCtx {
  client?: Client;
  session?: SessionControl;
}

export interface Capability {
  readonly id: string;
  readonly schema: ToolSchema;
  readonly traits: CapabilityTraits;
  invoke(req: ToolCallRequest): Promise<CapabilityResult>;
}
