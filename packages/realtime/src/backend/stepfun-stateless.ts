import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { logger } from "../util/logger.js";
import type {
  BackendAdapter,
  BackendCapabilities,
  NormalizedEvent,
  ResponseOptions,
} from "./types.js";
import type { ContentPart, Message } from "../types/events.js";

export interface StepfunStatelessOptions {
  apiKey: string;
  endpoint: string; // wss://api.stepfun.com/v1/realtime/stateless
  model: string; // step-overture-preview
  voice: string;
  modalities: ("text" | "audio")[];
  instructions: string;
}

interface PendingResponse {
  responseId: string;
}

const baseLog = logger.child({ component: "backend.stepfun_stateless" });

/**
 * Stepfun stateless realtime adapter.
 *
 * Protocol summary (from docs/stepfun_realtime_api.md):
 * - Each `response.create` is self-contained: must carry history + instructions
 *   + voice + modalities (no server-side session).
 * - `input_audio_buffer.commit` triggers transcription, but a `response.create`
 *   still needs to be sent to actually produce a response.
 * - Native function calling for custom tools via tools in response.create.
 */
export class StepfunStatelessAdapter implements BackendAdapter {
  readonly id = "stepfun_stateless";
  readonly capabilities: BackendCapabilities = {
    nativeFunctionCalling: true,
    modelMaintainsHistory: false,
    serverVad: false,
    audioOutput: true,
  };

  private ws?: WebSocket;
  private eventQueue: NormalizedEvent[] = [];
  private resolvers: Array<(ev: IteratorResult<NormalizedEvent>) => void> = [];
  private closed = false;
  private connected = false;
  private connectPromise?: Promise<void>;
  private keepaliveTimer?: NodeJS.Timeout;

  private current?: PendingResponse;

  /**
   * stateless backend lifecycle: after each response.done we must send
   * `session.restore` and wait for `session.restored` before the backend
   * will accept the next turn's audio/text/response.create. We track this
   * with a "ready/busy/awaiting_restore" flag.
   */
  private state: "idle" | "responding" | "awaiting_restore" = "idle";
  private restoreResolvers: Array<() => void> = [];
  /** Server-derived globally unique trace id captured from the ws upgrade
   *  response. Exposed for diagnostics / capture into test logs. */
  lastTraceId?: string;
  lastRequestId?: string;
  /** Soft-cancel marker. Day 0 smoke #2 verified stepfun_stateless silently
   *  ignores `response.cancel`; we set this responseId on cancel and drop
   *  subsequent audio.delta from the same response in onMessage so the
   *  caller sees an immediate audio cutoff. Transcript deltas are kept so
   *  the partial assistant message can still land in history. P5.2 §8.5. */
  private cancelledResponseId?: string;
  /** P5.2 barge-in fix: input_audio_buffer.append is rejected by upstream
   *  with "audio already committed" while state != "idle" (i.e. between
   *  commitInput → response.done → session.restore → session.restored).
   *  When the user barges in mid-response, the new turn's mic frames hit
   *  this window. We buffer them here and flush on session.restored.
   *  Capped to ~3s of 24kHz PCM16 (~144KB) to prevent runaway growth on
   *  stuck-restore edge cases. */
  private pendingAppend: Buffer[] = [];
  private pendingAppendBytes = 0;
  private static readonly PENDING_APPEND_CAP_BYTES = 24000 * 2 * 3;
  /** Per-instance logger; rebound with traceId/requestId once the upstream
   *  ws upgrade response arrives so every subsequent line is correlatable
   *  with the backend-side trace. */
  private log = baseLog;

  constructor(private readonly opts: StepfunStatelessOptions) {}

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    const url = `${this.opts.endpoint}?model=${encodeURIComponent(this.opts.model)}`;
    this.log.info({ url, model: this.opts.model }, "connecting");

    this.connectPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          "X-Trace-Id": randomUUID(),
        },
      });
      this.ws = ws;

      // Capture the server-issued trace id from the ws upgrade response.
      // The server always rewrites X-Trace-Id with its derived globally
      // unique value (per docs/refs/stepfun_stateless_api.md). We log it so
      // failures can be cross-referenced with stepfun-side traces.
      ws.once("upgrade", (resp) => {
        const traceId = resp.headers["x-trace-id"];
        const requestId = resp.headers["x-request-id"];
        this.lastTraceId =
          typeof traceId === "string"
            ? traceId
            : Array.isArray(traceId)
              ? traceId[0]
              : undefined;
        this.lastRequestId =
          typeof requestId === "string"
            ? requestId
            : Array.isArray(requestId)
              ? requestId[0]
              : undefined;
        // Rebind the instance logger so all subsequent lines from this
        // adapter carry the server-derived trace ids as structured fields.
        this.log = baseLog.child({
          traceId: this.lastTraceId,
          requestId: this.lastRequestId,
        });
        this.log.info("ws upgrade trace ids");
        if (this.lastTraceId || this.lastRequestId) {
          this.emit({
            type: "transport.trace",
            traceId: this.lastTraceId,
            requestId: this.lastRequestId,
            backendId: this.id,
          });
        }
      });

      ws.once("open", () => {
        this.connected = true;
        this.log.info("ws open");
        // Keep the upstream WS alive: stepfun.com will close idle connections
        // after a few minutes otherwise.
        this.keepaliveTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.ping();
            } catch {
              /* ignore */
            }
          }
        }, 20_000);
        // stepfun stateless has no explicit session.created event for the
        // bare connection; we emit a synthetic session.ready so the upper
        // layer has a consistent signal to wait for.
        this.emit({ type: "session.ready", raw: { source: "synthetic" } });
        resolve();
      });

      ws.once("error", (err) => {
        this.log.error({ err }, "ws error");
        if (!this.connected) reject(err);
        this.emit({
          type: "error",
          code: "transport",
          message: String(err),
        });
      });

      ws.on("message", (data) => this.onMessage(data.toString("utf-8")));

      ws.once("close", (code, reason) => {
        this.log.info({ code, reason: reason.toString() }, "ws close");
        this.closed = true;
        if (this.keepaliveTimer) {
          clearInterval(this.keepaliveTimer);
          this.keepaliveTimer = undefined;
        }
        this.flushClose();
      });
    });
    return this.connectPromise;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
    try {
      this.ws?.close(1000, "client close");
    } catch (e) {
      this.log.warn({ err: e }, "close failed");
    }
    this.flushClose();
  }

  appendAudio(pcm: Buffer): void {
    if (this.state !== "idle") {
      // Buffer until upstream finishes the previous turn's restore cycle.
      // Drop oldest frames if the cap is reached (prefer recent audio so
      // the caller's just-spoken content survives over stale frames).
      while (
        this.pendingAppendBytes + pcm.length >
          StepfunStatelessAdapter.PENDING_APPEND_CAP_BYTES &&
        this.pendingAppend.length > 0
      ) {
        const dropped = this.pendingAppend.shift()!;
        this.pendingAppendBytes -= dropped.length;
      }
      this.pendingAppend.push(pcm);
      this.pendingAppendBytes += pcm.length;
      return;
    }
    this.send({
      event_id: `evt_${shortId()}`,
      type: "input_audio_buffer.append",
      audio: pcm.toString("base64"),
    });
  }

  private flushPendingAppend(): void {
    if (this.pendingAppend.length === 0) return;
    this.log.debug(
      { frames: this.pendingAppend.length, bytes: this.pendingAppendBytes },
      "flushing buffered appends",
    );
    for (const pcm of this.pendingAppend) {
      this.send({
        event_id: `evt_${shortId()}`,
        type: "input_audio_buffer.append",
        audio: pcm.toString("base64"),
      });
    }
    this.pendingAppend = [];
    this.pendingAppendBytes = 0;
  }

  commitInput(): void {
    if (this.state !== "idle") {
      this.log.warn(
        { state: this.state },
        "commitInput while not idle; ignored",
      );
      return;
    }
    this.send({
      event_id: `evt_${shortId()}`,
      type: "input_audio_buffer.commit",
    });
  }

  sendUserText(text: string): void {
    if (this.state !== "idle") {
      this.log.warn(
        { state: this.state },
        "sendUserText while not idle; ignored",
      );
      return;
    }
    this.send({
      event_id: `evt_${shortId()}`,
      type: "conversation.item.create",
      item: {
        id: `msg_${shortId()}`,
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
  }

  /**
  /**
   * Send a function_call_output back to the model via the standard
   * conversation.item.create event. The upstream adds the item to the
   * in-session conversation; the next response.create then sees it as the
   * latest tool result and the model composes a natural-language reply.
   */
  sendFunctionCallOutput(callId: string, output: string): void {
    this.send({
      event_id: `evt_${shortId()}`,
      type: "conversation.item.create",
      item: {
        id: `item_tool_output_${callId}`,
        type: "function_call_output",
        status: "completed",
        call_id: callId,
        output,
      },
    });
  }

  /**
   * Stepfun stateless requires every response.create to carry the full session
   * config (instructions, voice, modalities, history).
   * Tools are published via session.update BEFORE response.create — including
   * them in response.create crashes the server (code 1006).
   */
  requestResponse(opts?: ResponseOptions): void {
    if (this.state === "awaiting_restore") {
      this.log.warn("requestResponse while awaiting session.restored; ignored");
      return;
    }
    const responseId = `resp_${shortId()}`;
    this.current = { responseId };
    this.state = "responding";

    const history = toStepfunHistory(opts?.history ?? []);

    const response: Record<string, unknown> = {
      modalities: opts?.modalities ?? this.opts.modalities,
      voice: opts?.voice ?? this.opts.voice,
      instructions: opts?.instructions ?? this.opts.instructions,
      history,
    };

    // Custom function tools go INSIDE response.create (per
    // docs/ref/stepfun_stateless.md + verified working on this endpoint).
    // The session.update path was tried but this endpoint then drops the
    // connection (code 1000) after such turns.
    const tools = (opts?.tools ?? []).map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    if (tools.length > 0) response.tools = tools;

    // TTS speed (stepfun wire field speed_ratio, range 0.5–2.0).
    if (typeof opts?.speedRatio === "number") {
      response.speed_ratio = Math.max(0.5, Math.min(2.0, opts.speedRatio));
    }

    this.send({
      event_id: `evt_${shortId()}`,
      type: "response.create",
      response,
    });
  }

  async cancelResponse(): Promise<void> {
    // Day 0 smoke #2: stateless upstream silently IGNORES response.cancel
    // (no error, no response.done, deltas keep flowing). We still send the
    // event (cheap, best-effort if upstream ever starts honoring it), but
    // primary mechanism is soft-cancel: mark current response id, drop
    // subsequent audio.delta in onMessage. Transcript deltas pass through
    // so the partial assistant message can be committed to history.
    if (this.state !== "responding") return;
    const rid = this.current?.responseId;
    if (!rid) return;
    this.cancelledResponseId = rid;
    this.log.info(
      { responseId: rid },
      "soft-cancel: dropping subsequent audio deltas",
    );
    try {
      this.send({ event_id: `evt_${shortId()}`, type: "response.cancel" });
    } catch {
      /* upstream ignores; not fatal */
    }

    // Real interrupt. `response.cancel` above is ignored by this endpoint, so
    // the in-flight response keeps generating to completion (a long reply
    // stalls the next turn for many seconds). The docs expose
    // `interrupt_current_response` on response.create as the actual interrupt;
    // sending a minimal text-only response.create with it was verified to make
    // the server abort the in-flight response in ~20ms. We carry no new audio
    // here — this only STOPS the old response so the backend becomes idle
    // fast; the user's interrupting utterance then drives a normal turn (its
    // audio reaches the server only once we're idle again). Occasionally the
    // endpoint closes the ws in reaction (auto-reconnect recovers, ~1s) — both
    // outcomes beat the multi-second stall.
    try {
      this.log.info(
        { interruptedResponseId: rid },
        "interrupt: response.create interrupt_current_response=true",
      );
      this.send({
        event_id: `evt_${shortId()}`,
        type: "response.create",
        response: {
          modalities: ["text"],
          instructions: this.opts.instructions,
          interrupt_current_response: true,
        },
      });
    } catch {
      /* best effort */
    }
  }

  async applyInputMode(
    _mode: "ptt" | "duplex",
  ): Promise<"ok" | "reconnect_required" | "unsupported"> {
    // Day 0 smoke #1: stateless upstream accepts session.update.turn_detection
    // schema but never emits server-VAD speech events. Duplex experience is
    // driven entirely by the frontend client-side VAD generating
    // audio.start/.append/.commit messages — the backend is mode-agnostic.
    // Therefore mode toggle is a no-op at this layer; always ok.
    return "ok";
  }

  /** AsyncIterable: consumers drain events via for-await. */
  async *events(): AsyncIterable<NormalizedEvent> {
    while (true) {
      if (this.eventQueue.length > 0) {
        yield this.eventQueue.shift()!;
        continue;
      }
      if (this.closed) return;
      const ev = await new Promise<IteratorResult<NormalizedEvent>>(
        (resolve) => {
          this.resolvers.push(resolve);
        },
      );
      if (ev.done) return;
      yield ev.value;
    }
  }

  // ---------------------- internals -----------------------

  private emit(ev: NormalizedEvent): void {
    if (this.resolvers.length > 0) {
      const r = this.resolvers.shift()!;
      r({ value: ev, done: false });
    } else {
      this.eventQueue.push(ev);
    }
  }

  private flushClose(): void {
    while (this.resolvers.length > 0) {
      const r = this.resolvers.shift()!;
      r({ value: undefined as never, done: true });
    }
  }

  private send(payload: object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log.warn({ payload }, "send dropped (not connected)");
      return;
    }
    const data = JSON.stringify(payload);
    this.log.trace({ raw: previewSend(payload) }, "send");
    this.ws.send(data);
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      this.log.warn({ raw: raw.slice(0, 200) }, "non-json message");
      return;
    }
    const type = msg.type as string | undefined;
    if (!type) {
      this.log.warn({ msg }, "message without type");
      return;
    }
    this.log.trace({ raw: previewRecv(msg) }, "recv");

    switch (type) {
      case "response.created": {
        const rid = msg.response?.id ?? this.current?.responseId ?? "unknown";
        this.current = { responseId: rid };
        // New response begins — clear any stale soft-cancel marker.
        this.cancelledResponseId = undefined;
        this.emit({ type: "response.started", responseId: rid });
        break;
      }
      case "response.audio_transcript.delta": {
        const rid = msg.response_id ?? this.current?.responseId ?? "unknown";
        this.emit({
          type: "transcript.delta",
          text: String(msg.delta ?? ""),
          responseId: rid,
        });
        break;
      }
      case "response.audio_transcript.done": {
        const rid = msg.response_id ?? this.current?.responseId ?? "unknown";
        this.emit({
          type: "transcript.done",
          text: String(msg.transcript ?? ""),
          responseId: rid,
        });
        break;
      }
      case "response.raw_text.delta": {
        const rid = msg.response_id ?? this.current?.responseId ?? "unknown";
        // P1 treats raw_text and audio_transcript symmetrically.
        this.emit({
          type: "transcript.delta",
          text: String(msg.delta ?? ""),
          responseId: rid,
        });
        break;
      }
      case "response.audio.delta": {
        const rid = msg.response_id ?? this.current?.responseId ?? "unknown";
        // Soft-cancel: drop audio for the cancelled response.
        if (rid === this.cancelledResponseId) break;
        const pcm = Buffer.from(String(msg.delta ?? ""), "base64");
        this.emit({ type: "audio.delta", pcm, responseId: rid });
        break;
      }
      case "response.audio.done": {
        const rid = msg.response_id ?? this.current?.responseId ?? "unknown";
        if (rid === this.cancelledResponseId) break;
        this.emit({ type: "audio.done", responseId: rid });
        break;
      }
      case "response.done": {
        const rid = msg.response?.id ?? this.current?.responseId ?? "unknown";
        this.emit({
          type: "response.done",
          responseId: rid,
          usage: msg.response?.usage,
        });
        // Only the FIRST response.done while we're actively responding drives
        // the restore handshake. A barge-in interrupt (response.create with
        // interrupt_current_response) makes the server emit TWO response.done
        // — one for the aborted response, one for the interrupting one. If we
        // sent session.restore on both, the server gets a duplicate restore
        // and closes the ws. Guarding on state==="responding" collapses them
        // into a single restore.
        if (this.state !== "responding") {
          this.log.debug(
            { state: this.state, rid },
            "response.done while not responding; skipping duplicate restore",
          );
          break;
        }
        // Stateless lifecycle (per docs/ref/stepfun_stateless.md): after a
        // turn completes, send session.restore and wait for session.restored
        // before accepting the next turn. The synthetic-ready shortcut was
        // tried but this endpoint then closes the ws (code 1000) — the server
        // expects the restore handshake to continue the stateless session.
        this.state = "awaiting_restore";
        this.log.debug("turn done; sending session.restore");
        this.send({
          event_id: `evt_${shortId()}`,
          type: "session.restore",
        });
        break;
      }
      case "session.restored": {
        this.log.debug("session.restored; ready for next turn");
        this.state = "idle";
        // Flush any audio.append frames that piled up during the
        // responding/awaiting_restore window (typical for duplex barge-in).
        this.flushPendingAppend();
        const waiters = this.restoreResolvers.splice(0);
        for (const r of waiters) r();
        // Tell SM the backend is ready to accept the next turn.
        this.emit({ type: "session.ready", raw: msg });
        break;
      }
      case "error": {
        const err = msg.error ?? {};
        this.emit({
          type: "error",
          code: String(err.code ?? "unknown"),
          message: String(err.message ?? "unknown"),
          raw: msg,
        });
        break;
      }
      // Events we don't act on yet but want to log:
      case "conversation.item.created":
      case "response.output_item.added":
      case "response.builtin_tool_call.done":
        this.log.debug({ type }, "passive event");
        break;
      case "response.function_call_arguments.delta": {
        const rid = msg.response_id ?? this.current?.responseId ?? "unknown";
        this.emit({
          type: "function_call.delta",
          callId: String(msg.call_id ?? ""),
          name: String(msg.name ?? ""),
          argsDelta: String(msg.delta ?? ""),
          responseId: rid,
        });
        break;
      }
      case "response.function_call_arguments.done": {
        const rid = msg.response_id ?? this.current?.responseId ?? "unknown";
        this.emit({
          type: "function_call.done",
          callId: String(msg.call_id ?? ""),
          name: String(msg.name ?? ""),
          arguments: String(msg.arguments ?? ""),
          responseId: rid,
        });
        break;
      }
      default:
        this.log.debug({ type, msg }, "unhandled event");
    }
  }
}

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * Convert SM Message[] to stepfun stateless `history` field format.
 *
 * Mapping (per docs/stepfun_realtime_api.md §3):
 *   - role: user/assistant kept as-is; system dropped (use `instructions`)
 *   - content type: user → "input_text"; assistant → "text"
 *   - audio parts: serialized as their transcript text (audio content not
 *     supported in history)
 *   - **messages with empty text are dropped entirely**: stepfun rejects
 *     history items whose content is empty (e.g. a user audio turn whose
 *     transcript we don't have). The conversational context is already in
 *     the assistant's reply, so omitting the empty user turn is acceptable.
 *   - function_call / function_call_output: dropped in P2 (tool calls not
 *     produced yet)
 */
function toStepfunHistory(msgs: Message[]): unknown[] {
  // function_call_output items are tool results. They're useful ONLY for
  // the model's current second-leg response (composing a spoken answer from
  // the result). Once an assistant text/audio reply comes AFTER an fco, the
  // result has been "consumed" — leaving it in history makes the model copy
  // the cached value for subsequent identical queries instead of re-calling
  // the tool. So we include fco only when it's NOT yet followed by any
  // assistant reply.
  let lastAssistantReplyIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (
      m.role === "assistant" &&
      m.content.some((c) => c.type === "text" || c.type === "audio")
    ) {
      lastAssistantReplyIdx = i;
      break;
    }
  }
  const out: unknown[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "system") continue;
    const includeFco = i > lastAssistantReplyIdx;

    // function_call and function_call_output are emitted as standalone items
    // (matching stepfun's MessageItem schema for native function calling).
    // Plain text/audio content collapses into a regular message item.
    for (const p of m.content) {
      if (p.type === "function_call") {
        out.push({
          id: m.id,
          type: "function_call",
          status: "completed",
          call_id: p.callId,
          name: p.name,
          arguments: p.arguments,
        });
      } else if (p.type === "function_call_output") {
        if (!includeFco) continue;
        out.push({
          id: m.id,
          type: "function_call_output",
          status: "completed",
          call_id: p.callId,
          output: p.output,
        });
      }
    }

    const text = extractMessageText(m.content);
    if (!text) continue;
    out.push({
      id: m.id,
      type: "message",
      role: m.role,
      content: [
        {
          type: m.role === "user" ? "input_text" : "text",
          text,
        },
      ],
    });
  }
  return out;
}

function extractMessageText(parts: ContentPart[]): string {
  // Text & audio-transcript content only — function_call(_output) items are
  // emitted separately as their own MessageItem entries (see toStepfunHistory).
  const segments: string[] = [];
  for (const p of parts) {
    switch (p.type) {
      case "text":
        segments.push(p.text);
        break;
      case "input_audio":
      case "audio":
        segments.push(p.transcript ?? "");
        break;
      case "function_call":
      case "function_call_output":
        // Handled outside as standalone items.
        break;
    }
  }
  return segments.join(" ").trim();
}

function previewSend(p: any): unknown {
  if (p?.type === "input_audio_buffer.append") {
    const a = String(p.audio ?? "");
    return { ...p, audio: `<base64 ${a.length}B>` };
  }
  return p;
}

function previewRecv(p: any): unknown {
  if (p?.type === "response.audio.delta") {
    const d = String(p.delta ?? "");
    return { ...p, delta: `<base64 ${d.length}B>` };
  }
  return p;
}
