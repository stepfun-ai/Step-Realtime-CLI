import type { Message } from "../types/events.js";
import type { ToolSchema } from "../capability/types.js";

/**
 * Normalized events emitted by BackendAdapter, decoupled from any specific
 * upstream protocol. The harness core operates only on these events.
 */
export type NormalizedEvent =
  | { type: "session.ready"; raw: unknown }
  | { type: "response.started"; responseId: string }
  | { type: "transcript.delta"; text: string; responseId: string }
  | { type: "transcript.done"; text: string; responseId: string }
  | { type: "audio.delta"; pcm: Buffer; responseId: string }
  | { type: "audio.done"; responseId: string }
  | {
      type: "function_call.delta";
      callId: string;
      name?: string;
      argsDelta: string;
      responseId: string;
    }
  | {
      type: "function_call.done";
      callId: string;
      name: string;
      arguments: string;
      responseId: string;
    }
  | { type: "response.done"; responseId: string; usage?: unknown }
  | {
      /** Upstream server-VAD detected user speech start. Emitted by backends
       *  with native server VAD. SM uses this to drive duplex-mode turn
       *  begin. P5.2. */
      type: "speech.started";
      raw?: unknown;
    }
  | {
      /** Upstream server-VAD detected user speech end. P5.2. */
      type: "speech.stopped";
      raw?: unknown;
    }
  | {
      /** Connection-level trace correlation. Emitted once per upstream ws
       *  upgrade so the SM / UI can display the server-derived trace id
       *  (and request id when available) for diagnostics. */
      type: "transport.trace";
      traceId?: string;
      requestId?: string;
      backendId: string;
    }
  | { type: "error"; code: string; message: string; raw?: unknown };

export interface ResponseOptions {
  instructions?: string;
  voice?: string;
  modalities?: ("text" | "audio")[];
  /**
   * Conversation history provided by RealtimeSession. Each adapter
   * decides whether to inject it into the upstream request based on
   * `capabilities.modelMaintainsHistory`:
   *   - false → adapter must translate and inject (stateless backends)
   *   - true  → adapter ignores (model maintains history server-side)
   */
  history?: Message[];
  /**
   * Tool schemas to expose. Stateless backends ignore this at wire level
   * (SM renders tools into instructions instead).
   */
  tools?: ToolSchema[];
  /**
   * TTS speech speed (wire field `speed_ratio`, range 0.5–2.0; adapter
   * clamps).
   */
  speedRatio?: number;
}

export interface BackendCapabilities {
  nativeFunctionCalling: boolean;
  modelMaintainsHistory: boolean;
  serverVad: boolean;
  audioOutput: boolean;
}

export interface BackendAdapter {
  readonly id: string;
  readonly capabilities: BackendCapabilities;

  connect(): Promise<void>;
  close(): Promise<void>;

  /** Push raw PCM16 mono 24kHz frames into the input audio buffer. */
  appendAudio(pcm: Buffer): void;

  /** Signal end of the current audio input ("PTT release"). */
  commitInput(): void;

  /** Inject a single-turn user text message into the upstream conversation. */
  sendUserText(text: string): void;

  /** Send a tool result back to the model. After this, the caller must
   *  invoke requestResponse() to actually drive the next assistant turn. */
  sendFunctionCallOutput(callId: string, output: string): void;

  /** Trigger a model response. SM always passes `opts.history`; adapter
   *  decides whether to use it (see ResponseOptions.history). */
  requestResponse(opts?: ResponseOptions): void;

  /** Cancel the in-flight response (best effort). */
  cancelResponse(): Promise<void>;

  /** Apply input mode (PTT vs Duplex) to the upstream session. SM calls this
   *  on user-driven mode toggle.
   *   - "ok": applied via in-session config (e.g. session.update.turn_detection)
   *   - "reconnect_required": cannot apply on this backend without a fresh
   *     connection (SM will close+reconnect via backendFactory; see §2.10.5)
   *   - "unsupported": backend cannot support this mode at all (degenerate;
   *     SM logs and refuses the toggle, UI keeps previous mode)
   *
   *  Backends that have no concept of upstream turn detection (stateless,
   *  where the duplex experience is fully driven by the frontend client-side
   *  VAD generating audio.start/.commit messages) MUST return "ok" — the
   *  mode change is effectively a no-op at this layer. */
  applyInputMode(
    mode: "ptt" | "duplex",
  ): Promise<"ok" | "reconnect_required" | "unsupported">;

  /** Whether changing the voice id at this moment would actually take effect.
   *  Some backends hard-reject voice changes after any assistant audio has
   *  been emitted in the session. Default true. */
  canChangeVoice?(): boolean;

  /** Delete a conversation item from upstream's server-side conversation
   *  state. Called when SM history is mutated (user rewind, auto compact)
   *  so the upstream model doesn't continue reasoning from items we've
   *  already removed locally. No-op on backends without server-side
   *  conversation (stateless re-sends history each turn). */
  deleteConversationItem?(itemId: string): void;

  events(): AsyncIterable<NormalizedEvent>;
}
