import { randomUUID } from "node:crypto";
import { logger } from "./util/logger.js";
import type { BackendAdapter } from "./backend/types.js";
import type {
  ContentPart,
  RealtimeEvent,
  Message,
  Role,
  TaskStatus,
} from "./types/events.js";
import type { Client } from "./client/types.js";
import type { CapabilityRegistry } from "./capability/registry.js";
import type { ToolCallRequest } from "./capability/types.js";
import type { SessionControl } from "./capability/session-control.js";
import type { Summarizer } from "./util/summarizer.js";
import type { VadAdapter } from "./vad/types.js";
import { renderToolsAsActionProtocol } from "./capability/schema.js";

// Generic long-running task lifecycle (capability-agnostic). The SDK owns the
// lifecycle (one active task, cancel, follow-up input, completion handling) but
// knows nothing about what the task does — coding-specific shape lives in the
// owning capability and travels through the opaque `progress`/`detail` payloads
// and the capability-provided announcement/status hooks.
export interface TaskSnapshot {
  taskId: string;
  /** Owning capability id (e.g. "coding_agent"). */
  capabilityId: string;
  /** Human-readable task label (was the coding task text). */
  label: string;
  startedAt: number;
  /** Capability-defined live progress payload (mutated in place by the runner). */
  progress?: Record<string, unknown>;
}

export interface TaskFinalSummary {
  status: TaskStatus;
  summary: string;
  /** Capability-defined result payload (filesChanged / cost / errors / …). */
  detail?: Record<string, unknown>;
}

export interface TaskInputQueue {
  push(text: string, priority?: "now" | "next" | "later"): void;
}

export interface TaskBroadcaster {
  isBusy(): boolean;
  getCurrent(): TaskSnapshot | undefined;
  cancelTask(taskId: string): void;
  appendTaskMessage(
    taskId: string,
    text: string,
    priority?: "now" | "next" | "later",
  ): boolean;
  registerTask(args: {
    taskId: string;
    capabilityId: string;
    label: string;
    abortController: AbortController;
    inputQueue?: TaskInputQueue;
    /** One-shot instruction injected into the NEXT response.create so the
     *  realtime model verbalizes a short "task started" opener. Supplied by
     *  the capability (SDK has no task-specific copy). */
    startAnnouncement?: string;
    /** Builds the completion announcement the realtime model speaks once the
     *  task finishes. Supplied by the capability. */
    completionAnnouncement?: (summary: TaskFinalSummary) => string | undefined;
    /** Builds a short status block appended to instructions while the task is
     *  in flight (so the model can answer progress questions). Supplied by the
     *  capability; reads its own `snapshot.progress`. */
    statusInstruction?: (snapshot: TaskSnapshot, elapsedSec: number) => string;
    run: (
      snapshot: TaskSnapshot,
      emit: (progress: { kind: string; data: unknown }) => void,
    ) => Promise<TaskFinalSummary>;
  }): void;
}

const log = logger.child({ component: "session.sm" });

const IDLE_WAIT_MS = 60_000;
const RECONNECT_DELAY_MS = 1_000;
const RECONNECT_MAX_ATTEMPTS = 10;
const MAX_TOOL_CALLS_PER_TURN = 5;

/** Auto-compaction kicks in when the SM history grows past this many
 *  non-system messages. Each user-assistant exchange is 2 messages, so the
 *  default ≈ 12 turns before compaction. */
const COMPACT_THRESHOLD = 24;
/** When compacting, keep this many most-recent messages verbatim; the rest
 *  are summarized into a single system message. */
const COMPACT_KEEP_RECENT = 6;

export interface SMOptions {
  instructions: string;
  voice: string;
  speedRatio: number;
  modalities: ("text" | "audio")[];
  /** Hard truncate threshold (non-system messages kept). P3+ swap for a
   *  HistoryPolicy that calls a compression capability. */
  historyMax: number;
  /** Initial input mode. P5.2. May be overridden post-construction by
   *  Harness reading the user's persisted preference. */
  inputMode?: "ptt" | "duplex";
  /** P5.5: minimum sustained-speech duration (ms) before committing to a
   *  user turn. Acts as a universal guard against false-positive VAD
   *  events (any adapter — energy / silero / future). Speech_start fires
   *  → start a candidate window of this duration, buffering PCM locally.
   *  If speech_end fires before window expires → silent abort. If window
   *  expires without speech_end → confirm: replay buffer to backend +
   *  begin a real turn. Default 300ms. Set 0 to disable (raw VAD events
   *  drive turn boundaries directly). */
  minSpeechMs?: number;
}

export interface SMContext {
  client?: Client;
  registry?: CapabilityRegistry;
  sessionId?: string; // if provided, history changes are persisted via client
  initialHistory?: Message[]; // load from disk
  /** Optional summarizer used by auto-compaction. When provided, SM will
   *  condense older messages into a single summary system message once
   *  history grows past a threshold. Without a summarizer, compaction is
   *  disabled and the existing hard-truncate path (historyMax) takes over. */
  summarizer?: Summarizer;
  /** P5.5: client-side VAD for duplex mode. When provided, duplex audio
   *  is routed through the adapter; speech_start triggers beginUserAudio
   *  (with barge-in check) and speech_end triggers commitUserAudio. PTT
   *  mode is unaffected (audio bypasses VAD entirely). When omitted in
   *  duplex mode the SM falls back to "continuous append, never commit"
   *  — broken without manual intervention, log warned at startup. */
  vad?: VadAdapter;
}

export type RealtimeEventListener = (ev: RealtimeEvent) => void;

/** Factory for (re)creating BackendAdapter instances. Used both for initial
 *  connect and for transparent reconnect after upstream ws drops. */
export type BackendFactory = () => BackendAdapter;

/**
 * RealtimeSession — the harness business-core actor.
 *
 * Owns conversation history; drives turn loop; subscribes BackendAdapter
 * events and broadcasts RealtimeEvent to subscribers (frontend Session, or
 * direct SDK callers).
 *
 * Single-session model: one SM instance per Harness; shared across all
 * subscribers (e.g. multiple browser tabs).
 *
 * P2 scope: text + audio turns, history truncation by hard threshold,
 * single in-flight turn (idle guard rejects concurrent input).
 */
export class RealtimeSession implements TaskBroadcaster {
  private history: Message[] = [];
  private subscribers = new Set<RealtimeEventListener>();
  private currentTurn?: {
    id: string;
    userMsg: Message;
    assistantBuf: AssistantBuffer;
    toolCallCount: number;
  };
  /**
   * `idle` reflects whether the BACKEND is ready to accept the next turn.
   * It's set to true only by NormalizedEvent.session.ready (initial connect
   * and after each turn boundary; backends emit this whenever they
   * complete their turn-completion protocol — e.g. stateless emits it
   * after session.restored).
   */
  private idle = false;
  private idleWaiters: Array<() => void> = [];
  private backendAlive = true;

  /** Audio frames buffered while waiting for beginUserAudio to start a turn. */
  private pendingAudio: Buffer[] = [];
  private pendingCommit = false;
  /** Set when a function_call event is observed; cleared after the
   *  follow-up response.create is fired. Tells response.done not to
   *  finishTurn (the tool flow owns the turn boundary). */
  private pendingFollowupResponse = false;
  /** Set after sendFunctionCallOutput has been issued — upstream now has
   *  the tool result, so it's safe to ask for the second-leg response.
   *  pendingFollowupResponse + toolOutputReady + idle = fire the follow-up. */
  private toolOutputReady = false;

  /** Current backend instance. Replaced on reconnect. */
  private _backend: BackendAdapter;
  /** Generation counter so a stale pumpBackend loop knows it's been replaced. */
  private backendGen = 0;
  private reconnecting = false;
  /** Set by forceReconnect() so pumpBackend's exit path knows the ws drop
   *  was intentional and doesn't broadcast a noisy backend_closed error. */
  private intentionalReconnect = false;
  private stopped = false;

  /** Capability / Client / session id wiring. */
  private _client?: Client;
  private registry?: CapabilityRegistry;
  private sessionId?: string;
  private summarizer?: Summarizer;
  /** Re-entry guard for compaction. Auto-compact is fire-and-forget — we
   *  must not start a second one while the first is still running. */
  private compactionInFlight = false;

  /** At most one long-running task can be in flight at a time. SM owns the
   *  task state — snapshot is mutated in place by the capability runner via
   *  the closure passed to registerTask; SM exposes it via getCurrent(). */
  private currentTask?: {
    taskId: string;
    capabilityId: string;
    ac: AbortController;
    snapshot: TaskSnapshot;
    /** Pull-stream of user messages into the runner. Capability passes
     *  it in via registerTask so SM can push follow-ups (P5.3). */
    inputQueue?: TaskInputQueue;
    /** Capability-provided completion announcement builder. */
    completionAnnouncement?: (summary: TaskFinalSummary) => string | undefined;
    /** Capability-provided in-flight status block builder. */
    statusInstruction?: (snapshot: TaskSnapshot, elapsedSec: number) => string;
    /** Resolves when the runner finishes (success / error / abort). Held
     *  for awaiting from switchSession / stop. */
    finished: Promise<void>;
  };
  /** Pending announcement to inject as a synthetic user turn the next time
   *  the realtime backend is idle. Coding task completion writes to this;
   *  pumpBackend's idle handler drains it. */
  private pendingAnnouncement?: string;
  /** One-shot instruction line appended to instructions on the NEXT
   *  response.create only, then cleared. Used to force realtime to verbalize
   *  a short "task started" opener immediately after the coding_agent
   *  function_call_output is delivered — prompt-only nudges are unreliable;
   *  this is the explicit harness path. */
  private pendingOneshotInstruction?: string;
  /** Latest server-derived trace ids from the current backend's ws upgrade.
   *  Cached so newly-subscribing frontends get the trace id immediately
   *  (the backend's transport.trace event only fires once on connect). */
  private latestTrace?: {
    backendId: string;
    traceId?: string;
    requestId?: string;
  };

  /** P5.2: input mode (PTT vs Duplex). Default PTT for back-compat; the
   *  Harness reads any persisted preference at startup and calls setMode. */
  private inputMode: "ptt" | "duplex" = "ptt";
  private _augCount = 0;
  /** P5.2: assistant audio currently playing (last `audio.delta` not yet
   *  closed by `response.done` / `audio.cancelled`). Used to gate barge-in
   *  detection. */
  private assistantAudioActive = false;
  /** P5.2: queue of pending notify(text) messages — like pendingAnnouncement
   *  but general-purpose. Drained one-per-idle into the realtime model as
   *  synthetic user turns. tag dedupes (same tag in queue → skip new). */
  private notifyQueue: Array<{ text: string; tag?: string }> = [];

  /** P5.5: VAD adapter for duplex mode (optional). PTT bypasses it. */
  private readonly vad?: VadAdapter;
  /** P5.5: VAD candidate-state — raw speech_start fired but not yet
   *  confirmed by minSpeechMs window. Buffers PCM here so we can replay
   *  if confirmed, or silently drop if aborted (speech_end before window
   *  expired). */
  private vadCandidatePending = false;
  private vadCandidateStartMs = 0;
  private vadCandidateBuffer: Buffer[] = [];
  /** P5.5: minimum sustained-speech duration before turn commits. */
  private readonly minSpeechMs: number;
  /** P5.5: turn start timestamp (set by beginUserAudio); used by
   *  commitUserAudio to enforce a final duration check (abortShortTurn). */
  private currentTurnStartMs = 0;
  /** Re-entry guard for beginUserAudio: a turn has been requested and is
   *  awaiting backend idle but `currentTurn` isn't set yet. Without this, a
   *  burst of speech_start events (silero can emit several before the first
   *  turn finishes awaiting idle) each queue a separate runUserTurn →
   *  multiple response.create → upstream rejects with "active response
   *  already exists". Cleared once the queued turn resolves (started or
   *  timed out). */
  private pendingUserTurn = false;
  /** Per-turn commit guard. `currentTurn` stays set until response.done, so
   *  a second speech_end (silero emits onSpeechEnd AND onVADMisfire can each
   *  produce one) would otherwise fire a second commitInput + response.create
   *  on the same turn → upstream "active response already exists". Reset at
   *  every startTurn. */
  private turnCommitted = false;

  constructor(
    private readonly backendFactory: BackendFactory,
    private readonly opts: SMOptions,
    ctx?: SMContext,
  ) {
    this._backend = this.backendFactory();
    this._client = ctx?.client;
    this.registry = ctx?.registry;
    this.sessionId = ctx?.sessionId;
    this.summarizer = ctx?.summarizer;
    this.vad = ctx?.vad;
    this.minSpeechMs = opts.minSpeechMs ?? 300;
    if (opts.inputMode) this.inputMode = opts.inputMode;
    if (ctx?.initialHistory && ctx.initialHistory.length > 0) {
      this.history = [...ctx.initialHistory];
      this.truncate();
    }
    void this.pumpBackend(this.backendGen);
  }

  /** Read-only access to the current backend (for SDK callers / Harness). */
  get backend(): BackendAdapter {
    return this._backend;
  }

  /** Return a SessionControl view backed by this SM. Inject this into
   *  capabilities that legitimately need to mutate runtime state. */
  sessionControl(): SessionControl {
    return {
      getVoice: () => this.opts.voice,
      setVoice: (v) => {
        this.opts.voice = v;
        this.broadcast({ type: "agent_config.changed", voice: v });
        log.info({ voice: v }, "voice updated");
      },
      getSpeedRatio: () => this.opts.speedRatio,
      setSpeedRatio: (r) => {
        this.opts.speedRatio = r;
        this.broadcast({ type: "agent_config.changed", speedRatio: r });
        log.info({ speedRatio: r }, "speed updated");
      },
      getInstructions: () => this.opts.instructions,
      setInstructions: (t) => {
        this.opts.instructions = t;
        this.broadcast({ type: "agent_config.changed", instructions: t });
        log.info("instructions updated");
      },
      getBackendId: () => this._backend.id,
      canChangeVoice: () => this._backend.canChangeVoice?.() ?? true,
      forceReconnect: (reason) => this.forceReconnect(reason),
      client: () => this._client,
    };
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  // ─────────────────── public API (called by Session / SDK user) ───

  /** Subscribe to harness events. Immediately receives history.snapshot.
   *  Returns unsubscribe fn. */
  subscribe(fn: RealtimeEventListener): () => void {
    this.subscribers.add(fn);
    safeEmit(fn, { type: "history.snapshot", messages: [...this.history] });
    if (this.latestTrace) {
      safeEmit(fn, { type: "backend.trace", ...this.latestTrace });
    }
    // P5.2: dispatch current input mode so the new subscriber's UI can
    // initialize the toggle button without polling.
    safeEmit(fn, {
      type: "mode.changed",
      mode: this.inputMode,
      reason: "init",
    });
    return () => this.subscribers.delete(fn);
  }

  beginUserText(text: string): void {
    // NB: an in-flight coding task is NOT auto-cancelled here. The realtime
    // model decides intent (refine / status / chat / cancel) via the
    // coding_task_* capabilities. See P4_DESIGN §2.6.
    // P5.2: text input from the user is also a barge-in trigger.
    this.maybeBargeIn();
    void this.runUserTurn(async () => {
      const userMsg = mkMessage("user", [{ type: "text", text }]);
      await this.startTurn(userMsg);
      this.backend.sendUserText(text);
      this.backend.requestResponse(this.buildResponseOpts());
    });
  }

  beginUserAudio(): void {
    // Re-entry guard: never start a second user-audio turn while one is
    // already active OR already queued and awaiting backend idle. A
    // high-frequency VAD (silero selfDebounced, or server speech.started)
    // can call this several times before currentTurn is established; without
    // the guard each call queues its own runUserTurn → overlapping turns and
    // duplicate response.create (upstream rejects with active-response-exists).
    if (this.currentTurn || this.pendingUserTurn) return;
    this.pendingUserTurn = true;
    // Same as beginUserText: do not auto-cancel coding tasks; realtime decides.
    // P5.2: if assistant audio is currently playing, this is a barge-in →
    // cut assistant first, mark message as interrupted, then proceed.
    this.maybeBargeIn();
    // P5.5: stamp turn start time so commitUserAudio can enforce a
    // universal minimum-duration guard. Skip the stamp if the VAD path
    // already pre-set it to the candidate start (otherwise we'd lose the
    // candidate-window time and short genuine utterances would be aborted).
    if (this.currentTurnStartMs === 0) {
      this.currentTurnStartMs = Date.now();
    }
    void this.runUserTurn(async () => {
      const userMsg = mkMessage("user", [{ type: "input_audio" }]);
      await this.startTurn(userMsg);
      // Flush any audio frames that arrived while we were waiting for idle.
      for (const pcm of this.pendingAudio) this.backend.appendAudio(pcm);
      this.pendingAudio = [];
      if (this.pendingCommit) {
        this.pendingCommit = false;
        this.fireCommit();
      }
    }).finally(() => {
      // Hand re-entry control to currentTurn (set by startTurn on success).
      // On a waitIdle timeout the turn never started — clearing here lets the
      // next speech_start retry instead of being blocked forever.
      this.pendingUserTurn = false;
    });
  }

  /** P5.2: barge-in. Called when a new user audio turn starts while the
   *  assistant is (or was just) emitting audio. ALWAYS flushes local
   *  playback; cancels upstream + flags the message only while the backend
   *  is still generating. */
  private maybeBargeIn(): void {
    const turnId = this.currentTurn?.id ?? "";
    // ALWAYS flush local playback, even if the backend already finished the
    // response. The speaker buffer (e.g. sox) can hold seconds of audio past
    // the backend's audio.done/response.done, so gating the flush on
    // assistantAudioActive (which tracks BACKEND streaming, not what's still
    // coming out of the speaker) let a barge-in silently fail to stop the
    // tail — the user spoke, got a fresh response, yet the old playback kept
    // running. Any barge-in trigger must silence the speaker immediately.
    this.broadcast({
      type: "audio.cancelled",
      turnId,
      reason: "barge_in",
    });
    // Upstream cancel + interrupted marking only matter while the backend is
    // still generating. Once it's done there's nothing left to cancel and no
    // in-flight assistant message to flag.
    if (!this.assistantAudioActive) return;
    log.info({ turnId }, "barge-in: cancelling assistant audio");
    this.assistantAudioActive = false;
    // Mark in-flight assistant message as interrupted so when we eventually
    // commit a partial transcript to history, the metadata reflects it.
    if (this.currentTurn) {
      // No assistant message has been pushed to history yet (it's pushed
      // by finishTurn). Flag via a sentinel on the assistantBuf so finishTurn
      // can read it.
      this.currentTurn.assistantBuf.interrupted = true;
    }
    // Best-effort upstream cancel. Async; stateless backend's soft-cancel
    // takes effect inside its onMessage filter.
    void this._backend.cancelResponse().catch((err) => {
      log.warn({ err }, "cancelResponse during barge-in failed");
    });
  }

  /** Barge-in helper: end the interrupted (committed, in-flight) turn LOCALLY
   *  and synchronously, so the interrupting utterance can immediately open a
   *  fresh turn. Without this, beginUserAudio's re-entry guard stays blocked
   *  until the old turn's response.done (hundreds of ms after the upstream
   *  cancel); meanwhile the new utterance gets appended to the dying turn and
   *  its commit is swallowed ("already committed"), so the user's interrupting
   *  request is lost until the NEXT speech_start — the "long pause after
   *  interrupting" symptom. The partial (interrupted) assistant transcript is
   *  committed to history best-effort/async; we do not block on it. */
  private endInterruptedTurnLocally(): void {
    const turn = this.currentTurn;
    if (!turn) return;
    const assistantMsg = turn.assistantBuf.toMessage();
    this.currentTurn = undefined;
    this.currentTurnStartMs = 0;
    this.turnCommitted = false;
    this.pendingCommit = false;
    this.pendingAudio = [];
    this.pendingFollowupResponse = false;
    this.toolOutputReady = false;
    if (assistantMsg) {
      void this.appendHistory(assistantMsg).catch((err) =>
        log.warn({ err }, "appendHistory for interrupted turn failed"),
      );
    }
    log.debug({ turnId: turn.id }, "barge-in: ended interrupted turn locally");
  }

  /** P5.2: public API. Queue a synthetic user-turn for the realtime model
   *  to verbalize. Used by coding completion announcements, tool-fail
   *  notify, future cron alerts, etc. `tag` dedupes (same tag pending →
   *  drop new). Drained one-per-idle.
   *  P5.2 `priority="now"` is best-effort: if assistant is mid-stream we
   *  barge-in first; otherwise behaves like "next". */
  notify(
    text: string,
    opts?: { priority?: "now" | "next"; tag?: string },
  ): void {
    if (!text.trim()) return;
    if (opts?.tag) {
      if (this.notifyQueue.some((n) => n.tag === opts.tag)) {
        log.debug({ tag: opts.tag }, "notify dedupe by tag");
        return;
      }
    }
    this.notifyQueue.push({ text, tag: opts?.tag });
    log.info(
      {
        chars: text.length,
        tag: opts?.tag,
        priority: opts?.priority ?? "next",
      },
      "notify queued",
    );
    if (opts?.priority === "now" && this.assistantAudioActive) {
      this.maybeBargeIn();
    }
    this.tryFlushAnnouncement();
  }

  /** P5.2: switch input mode at runtime. Returns the resolved mode (may
   *  equal the input or differ if backend reported a fallback). Persists
   *  via Client.preferences_set so the choice survives restart. */
  async setMode(
    mode: "ptt" | "duplex",
    reason: "user" | "init" = "user",
  ): Promise<"ptt" | "duplex"> {
    if (mode === this.inputMode) {
      // No-op but still broadcast so any UI waiting on confirmation refreshes.
      this.broadcast({ type: "mode.changed", mode, reason });
      return mode;
    }
    log.info({ from: this.inputMode, to: mode, reason }, "setMode");
    // If switching duplex→ptt and a user audio turn is currently listening,
    // commit it as one final PTT-style utterance to avoid leaving an
    // uncommitted buffer upstream.
    if (this.inputMode === "duplex" && mode === "ptt" && this.currentTurn) {
      try {
        this.backend.commitInput();
        this.backend.requestResponse(this.buildResponseOpts());
      } catch (err) {
        log.warn({ err }, "commit during duplex→ptt switch failed");
      }
    }
    // If assistant is mid-stream, barge-in first so the mode change takes
    // immediate effect for the user's NEXT turn.
    if (this.assistantAudioActive) {
      this.maybeBargeIn();
    }

    const verdict = await this._backend.applyInputMode(mode).catch((err) => {
      log.warn({ err }, "applyInputMode threw");
      return "unsupported" as const;
    });

    if (verdict === "unsupported") {
      log.warn({ mode }, "backend reports mode unsupported; reverting");
      this.broadcast({
        type: "mode.changed",
        mode: this.inputMode,
        reason: "fallback",
      });
      return this.inputMode;
    }
    if (verdict === "reconnect_required") {
      log.info({ mode }, "backend requires reconnect to apply mode");
      this.inputMode = mode;
      this.broadcast({ type: "mode.changed", mode, reason: "fallback" });
      // Trigger reconnect; new backend instance will call applyInputMode on
      // its own connect path via the harness's backend factory closure.
      await this.forceReconnect("input mode change").catch((err) =>
        log.warn({ err }, "forceReconnect after mode change failed"),
      );
      this.persistPreference("input_mode", mode);
      return mode;
    }

    this.inputMode = mode;
    this.broadcast({ type: "mode.changed", mode, reason });
    this.persistPreference("input_mode", mode);
    return mode;
  }

  /** Current input mode (read-only). */
  getInputMode(): "ptt" | "duplex" {
    return this.inputMode;
  }

  private persistPreference(key: string, value: string): void {
    if (!this._client) return;
    void this._client.preferences_set(key, value).catch((err) => {
      log.warn({ err, key }, "preferences_set failed");
    });
  }

  appendUserAudio(pcm: Buffer): void {
    this._augCount = (this._augCount ?? 0) + 1;
    if (this._augCount % 40 === 0) {
      log.info(
        {
          bytes: pcm.length,
          hasVad: !!this.vad,
          mode: this.inputMode,
          serverVad: this._backend.capabilities.serverVad,
          route:
            this.vad &&
            this.inputMode === "duplex" &&
            !this._backend.capabilities.serverVad
              ? "vad"
              : "default",
        },
        "[AUG-DIAG] appendUserAudio",
      );
    }
    // P5.5: in duplex mode with a client-side VAD, route through VAD to
    // detect turn boundaries automatically. Pre-speech_start frames are
    // dropped (typical VAD behavior; minor onset clipping is acceptable
    // for the energy detector's 120ms pre-roll).
    //
    // Backends with native server VAD bypass client VAD — turn boundaries
    // arrive via `speech.started/.stopped` events.
    if (
      this.vad &&
      this.inputMode === "duplex" &&
      !this._backend.capabilities.serverVad
    ) {
      void this.vadRouteAudio(pcm);
      return;
    }

    // Default path: PTT mode, or duplex with server VAD, or duplex without
    // any VAD (broken — warned at construct time).
    if (!this.currentTurn) {
      this.pendingAudio.push(pcm);
      return;
    }
    this.backend.appendAudio(pcm);
  }

  /** P5.5: VAD-driven duplex audio routing with candidate-state guard.
   *
   *  Two-phase confirmation protects against false speech_start emissions
   *  by ANY VAD implementation:
   *
   *    Phase 1 (candidate window):
   *      - VAD says speech_start → enter candidate state
   *      - Buffer incoming PCM locally; broadcast a playback_flush so
   *        frontend cuts off leftover assistant audio (snappy UX)
   *      - Do NOT call upstream cancel or beginUserAudio yet
   *
   *    Phase 2a (abort):
   *      - VAD says speech_end during candidate window (before minSpeechMs)
   *      - Discard buffered PCM, return to silent. No upstream cancel
   *        happened, no commit happened. This is the key guard against
   *        "are you done?" prompts from the model.
   *
   *    Phase 2b (confirm):
   *      - minSpeechMs elapsed in candidate without speech_end
   *      - Now do the full barge-in (maybeBargeIn → upstream cancel +
   *        interrupted marker if assistant was active)
   *      - Replay buffered PCM to backend via pendingAudio queue
   *      - beginUserAudio (turn awaits idle as usual)
   */
  private async vadRouteAudio(pcm: Buffer): Promise<void> {
    if (!this.vad) return;
    let event;
    try {
      event = await this.vad.processFrame(pcm);
    } catch (err) {
      log.error({ err }, "vad processFrame threw; dropping frame");
      return;
    }

    // Self-debounced adapters (e.g. Silero, which confirms speech via its own
    // minSpeechFrames before emitting speech_start) must NOT go through the
    // candidate window — that window is for raw threshold detectors (energy).
    // Applying it to a self-debounced adapter can abort already-confirmed
    // speech (start then quick end inside the window) → turn never commits.
    if (this.vad.selfDebounced) {
      if (event?.type === "speech_start") {
        if (this.currentTurn && this.turnCommitted) {
          // Barge-in: a committed turn is in flight (assistant is responding /
          // about to). Cut its playback + cancel upstream, then end it locally
          // so this interrupting utterance opens a FRESH turn — otherwise it
          // gets appended to the dying turn, its commit is ignored, and it's
          // lost until the next speech_start (the "long pause after
          // interrupting" symptom).
          this.maybeBargeIn();
          this.endInterruptedTurnLocally();
        }
        this.beginUserAudio();
      }
      if (this.currentTurn) {
        this.backend.appendAudio(pcm);
      } else if (this.pendingUserTurn) {
        // New turn queued, awaiting backend idle after the barge-in cancel.
        // Buffer the interrupting utterance so beginUserAudio replays it into
        // the new turn instead of dropping it.
        this.pendingAudio.push(pcm);
      }
      if (event?.type === "speech_end") {
        this.commitUserAudio();
      }
      return;
    }

    if (event?.type === "speech_start") {
      this.startVadCandidate(pcm);
      return;
    }

    if (this.vadCandidatePending) {
      this.vadCandidateBuffer.push(pcm);

      if (event?.type === "speech_end") {
        log.info(
          {
            elapsedMs: Date.now() - this.vadCandidateStartMs,
            minSpeechMs: this.minSpeechMs,
          },
          "[AUG-DIAG] candidate aborted by speech_end (no commit)",
        );
        this.abortVadCandidate();
        return;
      }

      if (Date.now() - this.vadCandidateStartMs >= this.minSpeechMs) {
        log.info({}, "[AUG-DIAG] candidate confirmed → beginUserAudio");
        this.confirmVadCandidate();
      }
      return;
    }

    if (this.currentTurn) {
      this.backend.appendAudio(pcm);
    }

    if (event?.type === "speech_end") {
      log.info({}, "[AUG-DIAG] speech_end → commitUserAudio");
      this.commitUserAudio();
    }
  }

  private startVadCandidate(pcm: Buffer): void {
    // Pre-emptive playback flush — gives the user snappy "I heard you"
    // feedback even if this turns out to be noise. NO upstream cancel
    // here — we don't want to abort a legitimate response on a noise blip.
    this.broadcast({
      type: "audio.cancelled",
      turnId: this.currentTurn?.id ?? "",
      reason: "playback_flush",
    });
    this.vadCandidatePending = true;
    this.vadCandidateStartMs = Date.now();
    this.vadCandidateBuffer = [pcm];
  }

  private abortVadCandidate(): void {
    log.debug(
      {
        elapsedMs: Date.now() - this.vadCandidateStartMs,
        bufferedFrames: this.vadCandidateBuffer.length,
      },
      "VAD candidate aborted: speech_end before minSpeechMs",
    );
    this.vadCandidatePending = false;
    this.vadCandidateBuffer = [];
  }

  private confirmVadCandidate(): void {
    const frames = this.vadCandidateBuffer;
    const candidateStartMs = this.vadCandidateStartMs;
    log.debug(
      {
        elapsedMs: Date.now() - candidateStartMs,
        bufferedFrames: frames.length,
      },
      "VAD candidate confirmed",
    );
    this.vadCandidatePending = false;
    this.vadCandidateBuffer = [];

    this.maybeBargeIn();

    // Pre-stamp turn start to the candidate START — full duration includes
    // candidate window so commitUserAudio's minSpeechMs guard sees real time.
    this.currentTurnStartMs = candidateStartMs;

    if (!this.currentTurn) {
      for (const buf of frames) this.pendingAudio.push(buf);
      this.beginUserAudio();
    } else {
      for (const buf of frames) this.backend.appendAudio(buf);
    }
  }

  commitUserAudio(): void {
    if (!this.currentTurn) {
      // Turn not yet started; defer commit until beginUserAudio flushes.
      this.pendingCommit = true;
      return;
    }
    // Per-turn idempotency: a second speech_end on the same turn (silero
    // emits onSpeechEnd, and onVADMisfire can synthesize another) must not
    // fire a second commitInput + response.create — the turn already has a
    // response in flight upstream.
    if (this.turnCommitted) {
      log.debug(
        { turnId: this.currentTurn.id },
        "commitUserAudio: already committed this turn, ignoring",
      );
      return;
    }
    // P5.5: minimum-duration guard. If the turn lasted less than
    // minSpeechMs, treat as a noise blip and abort silently — don't
    // ask the model to respond to (effectively) silence.
    const turnDurationMs = Date.now() - this.currentTurnStartMs;
    if (this.currentTurnStartMs > 0 && turnDurationMs < this.minSpeechMs) {
      log.info(
        {
          turnId: this.currentTurn.id,
          durationMs: turnDurationMs,
          minSpeechMs: this.minSpeechMs,
        },
        "commitUserAudio: turn too short, aborting silently (likely noise / accidental)",
      );
      void this.abortShortTurn();
      return;
    }
    this.fireCommit();
  }

  /** Single entry for committing the current turn's input and requesting the
   *  response. Sets the per-turn commit guard so a duplicate speech_end can't
   *  double-fire response.create. */
  private fireCommit(): void {
    this.turnCommitted = true;
    this.backend.commitInput();
    this.backend.requestResponse(this.buildResponseOpts());
  }

  /** P5.5: silently tear down a too-short turn. No requestResponse fires,
   *  so the model never sees a "respond to silence" prompt. */
  private async abortShortTurn(): Promise<void> {
    if (!this.currentTurn) return;
    const turnId = this.currentTurn.id;
    this.currentTurn = undefined;
    this.currentTurnStartMs = 0;
    this.pendingAudio = [];
    this.pendingCommit = false;
    this.idle = true;
    while (this.idleWaiters.length > 0) {
      const w = this.idleWaiters.shift()!;
      try {
        w();
      } catch {
        /* ignore */
      }
    }
    this.broadcast({ type: "response.done", turnId });
  }

  async cancel(): Promise<void> {
    await this.backend.cancelResponse();
    // P2: drop partial assistant content; do not commit to history.
    if (this.currentTurn) {
      this.broadcast({ type: "response.done", turnId: this.currentTurn.id });
      this.currentTurn = undefined;
      this.idle = true;
    }
  }

  // ─── TaskBroadcaster ──────────────────────────────────────────

  isBusy(): boolean {
    return !!this.currentTask;
  }

  getCurrent(): TaskSnapshot | undefined {
    return this.currentTask?.snapshot;
  }

  cancelTask(taskId: string): void {
    if (!this.currentTask) return;
    if (this.currentTask.taskId !== taskId) return;
    try {
      this.currentTask.ac.abort();
    } catch (err) {
      log.warn({ err, taskId }, "abort threw");
    }
  }

  /** P5.3: push a follow-up user message into the in-flight task's input
   *  queue. SDK forwards it to the coding model per `priority` semantics.
   *  Returns false if no task is in flight, taskId mismatches, or queue not set. */
  appendTaskMessage(
    taskId: string,
    text: string,
    priority: "now" | "next" | "later" = "next",
  ): boolean {
    if (!this.currentTask) return false;
    if (this.currentTask.taskId !== taskId) return false;
    if (!this.currentTask.inputQueue) return false;
    if (!text.trim()) return false;
    this.currentTask.inputQueue.push(text, priority);
    log.info({ taskId, priority, chars: text.length }, "appendTaskMessage");
    void this.appendTaskLog(taskId, {
      event: "appended_user_msg",
      text,
      priority,
      ts: Date.now(),
    });
    return true;
  }

  /** Capability-side entry: register a fire-and-forget coding task. SM
   *  schedules the runner on a background promise; the runner is responsible
   *  for driving the SDK iterator and mutating `snapshot` in place. When
   *  it resolves with the final summary SM:
   *    1. broadcasts `task.done`
   *    2. clears currentTask
   *    3. queues a synthetic announcement that the next idle backend turn
   *       will inject so realtime verbalizes the result. */
  registerTask(args: {
    taskId: string;
    capabilityId: string;
    label: string;
    abortController: AbortController;
    inputQueue?: TaskInputQueue;
    startAnnouncement?: string;
    completionAnnouncement?: (summary: TaskFinalSummary) => string | undefined;
    statusInstruction?: (snapshot: TaskSnapshot, elapsedSec: number) => string;
    run: (
      snapshot: TaskSnapshot,
      emit: (progress: { kind: string; data: unknown }) => void,
    ) => Promise<TaskFinalSummary>;
  }): void {
    if (this.currentTask) {
      throw new Error(
        `registerTask called while task ${this.currentTask.taskId} still in flight`,
      );
    }

    const snapshot: TaskSnapshot = {
      taskId: args.taskId,
      capabilityId: args.capabilityId,
      label: args.label,
      startedAt: Date.now(),
      progress: {},
    };

    this.broadcast({
      type: "task.started",
      taskId: args.taskId,
      capabilityId: args.capabilityId,
      label: args.label,
    });
    void this.appendTaskLog(args.taskId, {
      event: "started",
      capabilityId: args.capabilityId,
      label: args.label,
      ts: Date.now(),
    });

    const emit = (progress: { kind: string; data: unknown }) => {
      this.broadcast({
        type: "task.progress",
        taskId: args.taskId,
        capabilityId: args.capabilityId,
        kind: progress.kind,
        data: progress.data,
      });
      void this.appendTaskLog(args.taskId, {
        event: "progress",
        kind: progress.kind,
        data: progress.data,
        ts: Date.now(),
      });
    };

    const finished = args
      .run(snapshot, emit)
      .then((summary) => this.finishTask(args.taskId, summary))
      .catch((err) => {
        log.error(
          { err, taskId: args.taskId },
          "task runner threw outside catch",
        );
        void this.finishTask(args.taskId, {
          status: "failed",
          summary: String(err).slice(0, 500),
          detail: { errors: [String(err).slice(0, 500)] },
        });
      });

    this.currentTask = {
      taskId: args.taskId,
      capabilityId: args.capabilityId,
      ac: args.abortController,
      snapshot,
      inputQueue: args.inputQueue,
      completionAnnouncement: args.completionAnnouncement,
      statusInstruction: args.statusInstruction,
      finished,
    };
    // Harness-driven opener. The NEXT response.create (= the follow-up
    // triggered by the capability's function_call_output) will include this
    // one-shot directive. Cleared after use. Injecting it only in the exact
    // response we want it for is far more reliable than static persona rules.
    // The copy is capability-provided (SDK stays task-agnostic).
    this.pendingOneshotInstruction = args.startAnnouncement;
    log.info(
      {
        taskId: args.taskId,
        capabilityId: args.capabilityId,
        label: args.label.slice(0, 80),
      },
      "task registered",
    );
  }

  /** Internal: drain the runner result, broadcast task.done, queue
   *  announcement for realtime. */
  private async finishTask(
    taskId: string,
    summary: TaskFinalSummary,
  ): Promise<void> {
    if (this.currentTask?.taskId !== taskId) {
      log.warn({ taskId }, "finishTask called but no current task or mismatch");
      return;
    }
    const capabilityId = this.currentTask.capabilityId;
    const completionAnnouncement = this.currentTask.completionAnnouncement;
    this.broadcast({
      type: "task.done",
      taskId,
      capabilityId,
      status: summary.status,
      summary: summary.summary,
      detail: summary.detail,
    });
    void this.appendTaskLog(taskId, {
      event: "done",
      summary,
      ts: Date.now(),
    });
    this.currentTask = undefined;

    // Only auto-announce on natural completion. status="interrupted" means the
    // task was killed by an external signal (cancel tool call / switchSession /
    // ws cancel button), each of which already has its own user-facing feedback
    // channel. Auto-announcing on top produces duplicate / mis-attributed
    // playback.
    if (summary.status === "interrupted") {
      log.info({ taskId }, "skipping announcement for interrupted task");
      return;
    }

    // Queue announcement — realtime verbalizes this on the next idle backend
    // cycle. The copy is capability-provided (SDK stays task-agnostic).
    const announcement = completionAnnouncement?.(summary);
    if (!announcement) {
      log.info(
        { taskId, status: summary.status },
        "task finished; no announcement",
      );
      return;
    }
    this.pendingAnnouncement = announcement;
    log.info(
      { taskId, status: summary.status },
      "task finished; announcement queued",
    );
    this.tryFlushAnnouncement();
  }

  /** Idle-time hook: if there's a pending announcement and no user turn in
   *  flight, inject it as a synthetic user message and trigger response. */
  private tryFlushAnnouncement(): void {
    // Coding completion announcement has priority (it's the legacy path).
    let text: string | undefined;
    if (this.pendingAnnouncement) {
      text = this.pendingAnnouncement;
      this.pendingAnnouncement = undefined;
    } else if (this.notifyQueue.length > 0) {
      text = this.notifyQueue.shift()!.text;
    } else {
      return;
    }
    if (!this.idle) {
      // Push back; next idle will retry.
      if (text) this.notifyQueue.unshift({ text });
      return;
    }
    if (this.currentTurn) {
      if (text) this.notifyQueue.unshift({ text });
      return;
    }
    if (this.pendingFollowupResponse) {
      if (text) this.notifyQueue.unshift({ text });
      return;
    }
    if (!this.backendAlive) {
      if (text) this.notifyQueue.unshift({ text });
      return;
    }

    log.info({ chars: text.length }, "injecting synthetic notify");
    const notifyText = text;

    void this.runUserTurn(async () => {
      const userMsg = mkMessage("user", [{ type: "text", text: notifyText }]);
      userMsg.metadata.synthetic = true;
      await this.startTurn(userMsg);
      this.backend.sendUserText(notifyText);
      this.backend.requestResponse(this.buildResponseOpts());
    });
  }

  private async appendTaskLog(
    taskId: string,
    envelope: unknown,
  ): Promise<void> {
    if (!this._client) return;
    try {
      await this._client.coding_log_append(taskId, envelope);
    } catch (err) {
      log.warn({ err, taskId }, "coding_log_append failed");
    }
  }

  /** Runtime switch to another session. Replaces in-memory history with
   *  the loaded one; does NOT reconnect the backend. */
  async switchSession(newId: string): Promise<void> {
    if (!this._client) throw new Error("no Client; cannot switch session");
    // Don't bleed a coding task across sessions.
    if (this.currentTask) {
      this.currentTask.ac.abort();
    }
    this.pendingAnnouncement = undefined;
    this.pendingOneshotInstruction = undefined;
    const loaded = await this._client.session_load(newId);
    if (!loaded) throw new Error(`session not found: ${newId}`);
    this.sessionId = newId;
    this.history = [...loaded.messages];
    this.truncate();
    this.broadcast({ type: "history.snapshot", messages: [...this.history] });
    this.broadcast({
      type: "session.switched",
      sessionId: newId,
      title: loaded.meta.title,
    });
    log.info(
      { sessionId: newId, count: this.history.length },
      "session switched",
    );
  }

  /** Force the current backend to disconnect and reconnect with a fresh
   *  session. Used by agent_config_update when a runtime config change
   *  (e.g. voice id) can only take effect via a new upstream session.
   *
   *  Behavior:
   *   - Closes the current backend ws (idempotent).
   *   - The existing pumpBackend loop sees the events() iterator end and
   *     triggers `reconnect()`, which creates a fresh adapter via
   *     `backendFactory()` — the factory in harness.ts reads SM's current
   *     opts.voice, so the new session starts with the new voice.
   *   - Upstream conversation context is lost server-side for backends
   *     where the model maintains history. SM's in-memory history is kept;
   *     the model just won't have the prior conversation as context
   *     until/unless we replay it (not implemented yet). */
  async forceReconnect(reason: string): Promise<void> {
    log.info({ reason, voice: this.opts.voice }, "forcing backend reconnect");
    // Mark this as an intentional disconnect so the pumpBackend exit path
    // doesn't surface a backend_closed error event (which the UI renders
    // as a failure bubble).
    this.intentionalReconnect = true;
    this.idle = false;
    this.backendAlive = false;
    // Discard any in-flight turn / pending follow-up. Upstream conversation
    // context is gone after this; trying to fire a follow-up response.create
    // on the new (empty) session would generate noise unrelated to anything.
    this.currentTurn = undefined;
    this.currentTurnStartMs = 0;
    this.pendingFollowupResponse = false;
    this.toolOutputReady = false;
    try {
      await this._backend.close();
    } catch (err) {
      log.warn({ err }, "backend.close threw during forceReconnect; ignoring");
    }
  }

  /** Remove a single message from history by id. Used by the UI rewind
   *  path (user right-clicks a bubble → "撤回此条"). Triggers persistence
   *  rewrite + a history.snapshot broadcast so subscribers re-render. For
   *  backends that maintain conversation server-side, also issues the
   *  upstream item.delete event so the next response.create reasons from
   *  the same trimmed conversation we have locally. */
  async forgetMessage(messageId: string): Promise<boolean> {
    const idx = this.history.findIndex((m) => m.id === messageId);
    if (idx < 0) return false;
    const [removed] = this.history.splice(idx, 1);
    await this.maybeDeleteCodingTaskLog(removed);
    await this.afterHistoryMutation(`forget ${messageId}`);
    // For native-history backends, sync deletion upstream so the model
    // doesn't continue reasoning from the deleted item.
    try {
      this._backend.deleteConversationItem?.(removed.id);
    } catch (err) {
      log.warn(
        { err, messageId },
        "backend.deleteConversationItem threw; ignoring",
      );
    }
    return true;
  }

  /** Remove the target message AND everything after it. Used by the UI
   *  "撤回此条之后" path — user wants to roll the conversation back to
   *  before a point and continue from there. */
  async forgetMessagesFrom(messageId: string): Promise<number> {
    const idx = this.history.findIndex((m) => m.id === messageId);
    if (idx < 0) return 0;
    const removed = this.history.splice(idx);
    for (const m of removed) await this.maybeDeleteCodingTaskLog(m);
    await this.afterHistoryMutation(
      `forget from ${messageId} (${removed.length} msgs)`,
    );
    for (const m of removed) {
      try {
        this._backend.deleteConversationItem?.(m.id);
      } catch (err) {
        log.warn(
          { err, id: m.id },
          "backend.deleteConversationItem threw; ignoring",
        );
      }
    }
    return removed.length;
  }

  /** If the removed message is a coding_agent function_call_output, also
   *  delete the per-task jsonl file. P4_DESIGN §2.9: rewind is conversation
   *  level; filesystem changes from the task are NOT reverted. */
  private async maybeDeleteCodingTaskLog(msg: Message): Promise<void> {
    if (!this._client) return;
    for (const part of msg.content) {
      if (part.type !== "function_call_output") continue;
      try {
        const parsed = JSON.parse(part.output) as { taskId?: string };
        if (parsed?.taskId && typeof parsed.taskId === "string") {
          await this._client.coding_delete(parsed.taskId);
        }
      } catch {
        /* not a JSON output — not a coding task; ignore */
      }
    }
  }

  /** Common epilogue after any history mutation (forget / compact / etc).
   *  Persists the new state and notifies subscribers. */
  private async afterHistoryMutation(reason: string): Promise<void> {
    log.info({ reason, len: this.history.length }, "history mutated");
    if (this._client && this.sessionId) {
      try {
        await this._client.session_replace(this.sessionId, [...this.history]);
        await this._client.session_meta_set(this.sessionId, {
          messageCount: this.history.length,
          lastActivityAt: Date.now(),
        });
      } catch (err) {
        log.warn({ err }, "session_replace failed");
      }
    }
    this.broadcast({ type: "history.snapshot", messages: [...this.history] });
  }

  /** Build the ResponseOptions for a backend.requestResponse() call.
   *
   *  SM passes `tools` (schema array) through to the adapter; the stateless
   *  backend renders them into instructions rather than wire tools.
   *
   *  P4: if a coding task is in flight, append a short status block so the
   *  realtime model knows it's running. The block carries live progress so
   *  the model can answer progress questions verbally (no status tool); the
   *  base persona only exposes coding_task_cancel for explicit stop requests. */
  private buildResponseOpts() {
    let instructions = this.opts.instructions;
    if (this.currentTask?.statusInstruction) {
      const s = this.currentTask.snapshot;
      const elapsedSec = Math.floor((Date.now() - s.startedAt) / 1000);
      const block = this.currentTask.statusInstruction(s, elapsedSec);
      if (block) instructions += `\n\n${block}`;
    }
    if (this.pendingOneshotInstruction) {
      // One-shot directive — consume and clear so it lands on EXACTLY one
      // response.create (the immediately-following one).
      instructions += `\n\n# 本轮一次性指令 (仅本轮有效)\n${this.pendingOneshotInstruction}`;
      this.pendingOneshotInstruction = undefined;
    }

    const useNativeTools = this._backend.capabilities.nativeFunctionCalling;
    const schemas = this.registry?.schemas() ?? [];

    if (!useNativeTools && schemas.length > 0) {
      instructions += "\n\n" + renderToolsAsActionProtocol(schemas);
    }

    log.debug(
      {
        useNativeTools,
        schemaCount: schemas.length,
        schemaNames: schemas.map((s) => s.name),
        instructionsLen: instructions.length,
        instructionsHead: instructions.slice(0, 400),
        hasActionBlock: instructions.includes("[[ACTION]]"),
      },
      "buildResponseOpts: instructions ready",
    );

    return {
      instructions,
      voice: this.opts.voice,
      modalities: this.opts.modalities,
      history: this.history,
      tools: useNativeTools ? schemas : undefined,
      speedRatio: this.opts.speedRatio,
    };
  }

  /** P3 hook: capability dispatch entry point. Not implemented in P2. */
  dispatchToolCall(_call: unknown): Promise<unknown> {
    throw new Error("dispatchToolCall is a P3 hook; not implemented in P2");
  }

  /** Extract a tool call from [[ACTION]]...[[/ACTION]] markers in transcript text. */
  private parseActionProtocol(text: string): ToolCallRequest | null {
    const re = /\[\[ACTION\]\]\s*([\s\S]*?)\s*\[\[\/ACTION\]\]/;
    const m = re.exec(text);
    if (!m) return null;
    try {
      const payload = JSON.parse(m[1]) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      if (!payload.name) return null;
      return {
        callId: `action_${randomUUID().slice(0, 8)}`,
        name: payload.name,
        arguments: payload.arguments ?? {},
      };
    } catch {
      log.warn({ raw: m[1] }, "[[ACTION]] JSON parse failed");
      return null;
    }
  }

  /** Read-only history snapshot (for SDK callers). */
  getHistory(): readonly Message[] {
    return this.history;
  }

  // ─────────────────────── internals ───────────────────────────────

  /** Run an operation that needs the backend to be idle. Waits up to
   *  IDLE_WAIT_MS for backend session.ready; drops the input with error
   *  if exceeded. */
  private async runUserTurn(fn: () => Promise<void>): Promise<void> {
    if (!this.backendAlive) {
      this.broadcast({
        type: "error",
        code: "backend_dead",
        message: "backend connection lost",
      });
      return;
    }
    if (!this.idle) {
      log.debug("not idle; queueing until session.ready");
      try {
        await this.waitIdle(IDLE_WAIT_MS);
      } catch (err) {
        log.warn({ err }, "waitIdle timed out; dropping input");
        this.broadcast({
          type: "error",
          code: "backend_busy",
          message: "backend did not become ready in time",
        });
        return;
      }
    }
    try {
      await fn();
    } catch (err) {
      log.error({ err }, "user turn failed");
    }
  }

  private waitIdle(timeoutMs: number): Promise<void> {
    if (this.idle) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.idleWaiters.indexOf(onReady);
        if (idx >= 0) this.idleWaiters.splice(idx, 1);
        reject(new Error(`waitIdle timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      this.idleWaiters.push(onReady);
    });
  }

  private guardIdle(label: string): boolean {
    if (!this.backendAlive) {
      log.warn({ label }, "backend dead; input dropped");
      this.broadcast({
        type: "error",
        code: "backend_dead",
        message: "backend connection lost",
      });
      return false;
    }
    if (!this.idle) {
      log.warn({ label }, "not idle; input dropped");
      return false;
    }
    return true;
  }

  private async startTurn(userMsg: Message): Promise<void> {
    const turnId = userMsg.id;
    userMsg.metadata.turnId = turnId;
    // Set idle=false BEFORE any await so a concurrent runUserTurn waking
    // from the same session.ready batch can't slip through (was racing on
    // the appendHistory await below).
    this.idle = false;
    this.currentTurn = {
      id: turnId,
      userMsg,
      assistantBuf: new AssistantBuffer(turnId),
      toolCallCount: 0,
    };
    // Fresh turn — clear the per-turn commit guard so this turn can commit.
    this.turnCommitted = false;
    await this.appendHistory(userMsg);
    log.debug({ turnId }, "turn start");
  }

  private async finishTurn(responseId?: string): Promise<void> {
    if (!this.currentTurn) return;
    const turnId = this.currentTurn.id;
    const assistantMsg = this.currentTurn.assistantBuf.toMessage(responseId);
    if (assistantMsg) await this.appendHistory(assistantMsg);
    this.currentTurn = undefined;
    this.currentTurnStartMs = 0;
    // Clear any leftover buffered audio from a turn that ended.
    this.pendingAudio = [];
    this.pendingCommit = false;
    this.pendingFollowupResponse = false;
    this.toolOutputReady = false;
    // NOTE: do NOT set idle=true here. Idle is gated on session.ready from
    // the backend, which signals that the backend's turn-boundary protocol
    // (e.g. stateless's session.restore handshake) has completed.
    log.debug({ turnId }, "turn done (awaiting backend session.ready)");
  }

  private async appendHistory(msg: Message): Promise<void> {
    this.history.push(msg);
    this.truncate();
    // Persist to disk if a Client + sessionId is configured. Errors
    // logged but not propagated — best effort.
    if (this._client && this.sessionId) {
      try {
        await this._client.session_append(this.sessionId, msg);
        // Update meta every ~5 messages to avoid index thrash.
        if (this.history.length % 5 === 0) {
          await this._client.session_meta_set(this.sessionId, {
            messageCount: this.history.length,
            lastActivityAt: Date.now(),
          });
        }
      } catch (err) {
        log.warn({ err }, "session_append failed");
      }
    }
    this.broadcast({ type: "history.appended", message: msg });
    // Auto-compact past threshold. Fire-and-forget so this hot path stays
    // fast; failures are logged but don't block the turn.
    if (
      this.summarizer &&
      !this.compactionInFlight &&
      this.history.length >= COMPACT_THRESHOLD &&
      !this._backend.capabilities.modelMaintainsHistory // upstream sync TBD for server-side history
    ) {
      void this.compactHistory();
    }
  }

  /** Auto-compaction: condense the oldest `len - keepRecent` messages
   *  into a single system-role summary message, then replace them.
   *
   *  Limitations:
   *   - Only runs when SM has a Summarizer (see SMContext.summarizer).
   *   - Currently disabled for backends with `modelMaintainsHistory=true`.
   *     Those need explicit upstream sync via conversation.item.delete +
   *     conversation.item.create, which is more involved; stateless gets
   *     this for free since it re-sends history each response.create.
   *   - Skips if a current turn is in flight (let the turn finish first). */
  private async compactHistory(): Promise<void> {
    if (this.compactionInFlight) return;
    if (!this.summarizer) return;
    if (this.currentTurn) return; // turn boundary safety
    if (this.history.length <= COMPACT_KEEP_RECENT) return;

    this.compactionInFlight = true;
    const cutIdx = this.history.length - COMPACT_KEEP_RECENT;
    const toCompact = this.history.slice(0, cutIdx);
    const keep = this.history.slice(cutIdx);
    log.info(
      { compacting: toCompact.length, keeping: keep.length },
      "auto-compaction start",
    );
    try {
      const summaryText = await this.summarizer.summarize(toCompact);
      const summaryMsg = mkMessage("system", [
        {
          type: "text",
          text: `[compacted summary of ${toCompact.length} earlier messages]\n${summaryText}`,
        },
      ]);
      this.history = [summaryMsg, ...keep];
      await this.afterHistoryMutation(`auto-compact ${toCompact.length} msgs`);
      // For native-history backends, also delete the original items upstream
      // so its server-side conversation matches our trimmed view. (Currently
      // a no-op because we skip compaction for those backends above; left
      // here so the path works once a server-side-history backend is added.)
      for (const m of toCompact) {
        try {
          this._backend.deleteConversationItem?.(m.id);
        } catch {
          /* logged elsewhere */
        }
      }
    } catch (err) {
      log.warn(
        { err: String(err).slice(0, 200) },
        "auto-compaction failed; keeping full history",
      );
    } finally {
      this.compactionInFlight = false;
    }
  }

  private truncate(): void {
    const max = this.opts.historyMax;
    const nonSystemCount = this.history.reduce(
      (n, m) => (m.role === "system" ? n : n + 1),
      0,
    );
    if (nonSystemCount <= max) return;
    let toDrop = nonSystemCount - max;
    const next: Message[] = [];
    for (const m of this.history) {
      if (m.role !== "system" && toDrop > 0) {
        toDrop--;
        continue;
      }
      next.push(m);
    }
    this.history = next;
  }

  private broadcast(ev: RealtimeEvent): void {
    for (const fn of this.subscribers) safeEmit(fn, ev);
  }

  /** Dispatch a tool call to the registry and feed the result back to the
   *  model via the backend, then trigger the second-leg response.create. */
  private async onFunctionCall(call: ToolCallRequest): Promise<void> {
    log.info(
      {
        callId: call.callId,
        name: call.name,
        argsKeys: Object.keys(call.arguments ?? {}),
        hasRegistry: !!this.registry,
      },
      "onFunctionCall: dispatching tool call",
    );
    if (!this.registry) {
      log.warn({ name: call.name }, "function_call but no CapabilityRegistry");
      return;
    }
    if (this.currentTurn) this.currentTurn.toolCallCount++;
    if ((this.currentTurn?.toolCallCount ?? 0) > MAX_TOOL_CALLS_PER_TURN) {
      log.warn("max tool calls per turn exceeded; rejecting");
      return;
    }
    // Mark "tool in flight" *before* any await — response.done can arrive
    // while dispatch is still pending I/O, and without this flag set the
    // response.done handler would call finishTurn and wipe currentTurn.
    this.pendingFollowupResponse = true;
    this.broadcast({
      type: "tool_call.invoking",
      callId: call.callId,
      name: call.name,
    });

    // Record the call into history (function_call message).
    const callMsg = mkMessage("assistant", [
      {
        type: "function_call",
        name: call.name,
        arguments: JSON.stringify(call.arguments),
        callId: call.callId,
      },
    ]);
    await this.appendHistory(callMsg);

    const result = await this.registry.dispatch(call);

    this.broadcast({
      type: "tool_call.done",
      callId: call.callId,
      name: call.name,
      ok: result.ok,
      display: result.display,
      sideEffect: result.sideEffect,
    });

    // Record the output into history.
    const outMsg = mkMessage("user", [
      {
        type: "function_call_output",
        callId: call.callId,
        output: result.output,
      },
    ]);
    await this.appendHistory(outMsg);

    // Send the tool output back to the model.
    this.backend.sendFunctionCallOutput(call.callId, result.output);

    // P5.5: deferred results (long-running tools that returned status=started)
    // suppress the follow-up response.create. The capability handles its own
    // post-completion announcement via the notify() / completionAnnouncement
    // path; firing a second response.create here would make the realtime
    // model verbalize "OK starting" twice (once preamble + once post-tool).
    if (result.deferred) {
      log.debug(
        { callId: call.callId, tool: call.name },
        "tool result is deferred; skipping follow-up response.create",
      );
      this.pendingFollowupResponse = false;
      this.toolOutputReady = false;
      return;
    }

    this.toolOutputReady = true;
    // If the backend has already signalled session.ready, fire now;
    // otherwise the next session.ready will pick it up via tryFireFollowup.
    this.tryFireFollowup();
  }

  /** Fire the second-leg response.create iff (a) a tool call is in flight,
   *  (b) the tool output has been delivered to the upstream, and (c) the
   *  backend is idle. All three must hold — some backends send
   *  session.ready before our onFunctionCall finishes (race), and we
   *  used to fire with no tool output attached. Idempotent. */
  private tryFireFollowup(): void {
    if (!this.pendingFollowupResponse) return;
    if (!this.toolOutputReady) return;
    if (!this.idle) return;
    if (!this.backendAlive) return;
    this.pendingFollowupResponse = false;
    this.toolOutputReady = false;
    this.idle = false;
    log.debug("firing tool follow-up response.create");
    this.backend.requestResponse(this.buildResponseOpts());
  }

  private async pumpBackend(gen: number): Promise<void> {
    log.debug({ gen }, "pumpBackend start");
    try {
      for await (const ev of this.backend.events()) {
        if (gen !== this.backendGen) {
          log.debug({ gen, current: this.backendGen }, "stale pump exiting");
          return;
        }
        switch (ev.type) {
          case "session.ready": {
            // Backend is ready to accept the next turn. This signals both
            // initial connect readiness and post-turn re-readiness (e.g.
            // stateless emits this after session.restored).
            this.idle = true;
            this.backendAlive = true;
            log.debug("backend session.ready -> idle");
            if (this.pendingFollowupResponse) {
              // Try to fire — succeeds iff the tool output has already been
              // delivered. If dispatch is still pending, this is a no-op;
              // the end of onFunctionCall will retry once toolOutputReady.
              this.tryFireFollowup();
            } else if (
              this.pendingAnnouncement ||
              this.notifyQueue.length > 0
            ) {
              // P4: a coding task just finished; inject the completion
              // announcement before any queued user waiters so realtime
              // verbalizes the result.
              // P5.2: also drain general notifyQueue (tool failures etc.)
              this.tryFlushAnnouncement();
            } else if (this.idleWaiters.length > 0) {
              // Wake only ONE waiter. Each user turn is expected to fire
              // a response.create which keeps idle=false until the next
              // session.ready. Waking the entire queue would let multiple
              // turns race their response.create calls (→ upstream rejects
              // with ONGOING_RESPONSE_ALREADY_EXISTS / conversation_already_has_active_response).
              const waiter = this.idleWaiters.shift()!;
              waiter();
            }
            break;
          }
          case "response.started":
            // Internal; nothing to do for now.
            break;
          case "transport.trace": {
            this.latestTrace = {
              backendId: ev.backendId,
              traceId: ev.traceId,
              requestId: ev.requestId,
            };
            log.info(
              {
                backendId: ev.backendId,
                traceId: ev.traceId,
                requestId: ev.requestId,
              },
              "upstream trace ids",
            );
            this.broadcast({ type: "backend.trace", ...this.latestTrace });
            break;
          }
          case "transcript.delta": {
            this.currentTurn?.assistantBuf.appendTranscript(ev.text);
            this.broadcast({
              type: "transcript.delta",
              text: ev.text,
              turnId: this.currentTurn?.id ?? "",
            });
            break;
          }
          case "transcript.done": {
            this.currentTurn?.assistantBuf.finalizeTranscript(ev.text);
            this.broadcast({
              type: "transcript.done",
              text: ev.text,
              turnId: this.currentTurn?.id ?? "",
            });
            // [[ACTION]] protocol: parse tool calls from transcript when
            // backend doesn't support native function calling.
            if (!this._backend.capabilities.nativeFunctionCalling) {
              const parsed = this.parseActionProtocol(ev.text);
              log.info(
                {
                  turnId: this.currentTurn?.id,
                  transcriptLen: ev.text.length,
                  transcriptHead: ev.text.slice(0, 300),
                  hasActionMarker: ev.text.includes("[[ACTION]]"),
                  parsedTool: parsed?.name,
                  parsedArgs: parsed?.arguments,
                },
                "transcript.done — checking [[ACTION]] protocol",
              );
              if (parsed) {
                void this.onFunctionCall(parsed);
              }
            }
            break;
          }
          case "function_call.delta":
            // We only act on .done. Native backends may emit deltas
            // for streaming arguments; SM doesn't need them.
            break;
          case "function_call.done": {
            let args: Record<string, unknown> = {};
            try {
              args = ev.arguments ? JSON.parse(ev.arguments) : {};
            } catch (err) {
              log.warn(
                { err, raw: ev.arguments },
                "function_call args JSON parse failed",
              );
            }
            log.info(
              {
                callId: ev.callId,
                name: ev.name,
                args,
                turnId: this.currentTurn?.id,
              },
              "function_call.done arrived from realtime backend",
            );
            void this.onFunctionCall({
              callId: ev.callId,
              name: ev.name,
              arguments: args,
            });
            break;
          }
          case "audio.delta":
            this.assistantAudioActive = true;
            this.broadcast({
              type: "audio.delta",
              pcm: ev.pcm,
              turnId: this.currentTurn?.id ?? "",
            });
            break;
          case "audio.done":
            this.assistantAudioActive = false;
            this.broadcast({
              type: "audio.done",
              turnId: this.currentTurn?.id ?? "",
            });
            break;
          case "response.done":
            this.assistantAudioActive = false;
            this.broadcast({
              type: "response.done",
              turnId: this.currentTurn?.id ?? "",
            });
            if (this.pendingFollowupResponse) {
              // A tool result was queued during this response. We DEFER the
              // actual response.create until the backend's next session.ready
              // arrives — firing it here can hit the upstream while it's
              // still finalizing the prior response (some backends reject
              // with conversation_already_has_active_response).
              log.debug(
                "response.done with pending follow-up; awaiting session.ready",
              );
            } else {
              void this.finishTurn(ev.responseId);
            }
            break;
          case "speech.started": {
            // Upstream server-VAD detected user speech onset. This drives
            // duplex-mode turn-begin equivalence to PTT's audio.start.
            // P5.2 barge-in: if assistant was speaking, cancel it.
            this.maybeBargeIn();
            // Idempotent: only begin a turn if one isn't already active.
            if (!this.currentTurn) {
              this.beginUserAudio();
            }
            break;
          }
          case "speech.stopped":
            // Server VAD will auto-commit (`input_audio_buffer.committed`)
            // and follow up with response.create on its own. SM just notes
            // the boundary for future use; nothing to do upstream.
            log.debug("speech.stopped");
            break;
          case "error":
            this.broadcast({
              type: "error",
              code: ev.code,
              message: ev.message,
            });
            if (this.currentTurn) void this.finishTurn();
            // After an error we still want to accept the next user input —
            // optimistically reset idle. Backend may still be in a weird
            // state, but subsequent attempts will surface that.
            this.idle = true;
            break;
        }
      }
    } catch (err) {
      log.error({ err, gen }, "pumpBackend failed");
    }
    log.info({ gen }, "pumpBackend exited; backend ws closed");
    this.backendAlive = false;
    this.idle = false;
    if (this.currentTurn && !this.intentionalReconnect) {
      this.broadcast({
        type: "error",
        code: "backend_closed",
        message: "backend connection lost; reconnecting...",
      });
      void this.finishTurn();
    }
    // Reset the intentional flag — it only suppresses this single exit.
    this.intentionalReconnect = false;
    if (!this.stopped) {
      void this.reconnect(gen);
    }
  }

  /** Replace the dead backend with a fresh one and resume pumping. */
  private async reconnect(deadGen: number): Promise<void> {
    if (this.reconnecting) return;
    if (deadGen !== this.backendGen) return; // already replaced by another path
    this.reconnecting = true;

    for (let attempt = 1; attempt <= RECONNECT_MAX_ATTEMPTS; attempt++) {
      if (this.stopped) {
        this.reconnecting = false;
        return;
      }
      const wait = RECONNECT_DELAY_MS * Math.min(attempt, 5);
      log.info({ attempt, wait }, "reconnecting backend");
      await sleep(wait);
      try {
        const fresh = this.backendFactory();
        await fresh.connect();
        this._backend = fresh;
        this.backendGen++;
        this.reconnecting = false;
        // Wake up any queued user inputs so they can retry.
        log.info({ gen: this.backendGen }, "backend reconnected");
        void this.pumpBackend(this.backendGen);
        return;
      } catch (err) {
        log.warn({ err, attempt }, "reconnect attempt failed");
      }
    }
    log.error("reconnect gave up after max attempts");
    this.reconnecting = false;
    this.broadcast({
      type: "error",
      code: "backend_reconnect_failed",
      message: "backend reconnect failed; restart server",
    });
  }

  /** Stop pumping & disable reconnect (called by Harness.stop()). */
  async stop(): Promise<void> {
    this.stopped = true;
    await this._backend.close();
  }
}

// ───────────────────── helpers ────────────────────────────────────

class AssistantBuffer {
  constructor(public readonly turnId: string) {}
  private accum = "";
  private finalTranscript?: string;
  /** P5.2 barge-in: set by SM.maybeBargeIn(); read by toMessage() so the
   *  Message.metadata.interrupted flag propagates to history + UI. */
  interrupted = false;

  appendTranscript(t: string): void {
    this.accum += t;
  }

  /** Current accumulated transcript (delta-running). */
  snapshotText(): string {
    return this.accum;
  }

  finalizeTranscript(t: string): void {
    // Prefer the longer of (delta accum) vs (final). See P2_DESIGN §8.5.
    this.finalTranscript = t.length >= this.accum.length ? t : this.accum;
  }

  toMessage(responseId?: string): Message | null {
    const transcript = this.finalTranscript ?? this.accum;
    if (!transcript.trim()) return null;
    const msg = mkMessage("assistant", [{ type: "audio", transcript }]);
    if (responseId) msg.metadata.responseId = responseId;
    msg.metadata.turnId = this.turnId;
    if (this.interrupted) msg.metadata.interrupted = true;
    return msg;
  }
}

function mkMessage(role: Role, content: ContentPart[]): Message {
  return {
    id: `msg_${randomUUID()}`,
    role,
    content,
    metadata: { ts: Date.now() },
  };
}

function safeEmit(fn: RealtimeEventListener, ev: RealtimeEvent): void {
  try {
    fn(ev);
  } catch (err) {
    log.warn({ err, evType: ev.type }, "subscriber threw");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
