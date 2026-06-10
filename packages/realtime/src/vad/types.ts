/**
 * VAD (Voice Activity Detection) interface and types — SDK-core layer.
 *
 * This file defines the contract every VAD adapter must follow. The SDK
 * ships with a built-in EnergyVadAdapter (see ./energy-adapter.ts) and
 * delegates to external plugins (e.g. @step-cli/realtime-vad-silero) for
 * anything that requires native deps or external models.
 *
 * Stability: this file is the migration boundary. When the SDK moves to
 * step-cli/packages/realtime/src/vad/ it must move byte-for-byte — no
 * dependency on harness-ts internals.
 */

/**
 * Adapter for client-side voice activity detection.
 *
 * Drives turn boundaries in duplex mode: when the user starts speaking the
 * adapter emits `speech_start`, when they stop it emits `speech_end`. The
 * RealtimeSession uses these events to decide when to call beginUserAudio
 * (and possibly barge-in) and commitUserAudio (which triggers a response).
 *
 * Adapter implementations are responsible for:
 *   - Buffering / re-framing inputs of arbitrary size into whatever the
 *     underlying algorithm expects (Silero needs fixed 1536-sample frames
 *     at 16kHz, the energy detector handles any chunk).
 *   - Resampling, if their algorithm requires a different rate than the
 *     SDK's canonical 24kHz PCM16 mono.
 *   - Maintaining their own state machine. The SDK never inspects internals.
 *
 * Input audio is always PCM16 little-endian mono at 24kHz (the SoxAudioDriver
 * canonical format). Adapters MUST NOT assume any chunk size — handle 10ms
 * up to multi-second buffers.
 */
export interface VadAdapter {
  /**
   * If true, the adapter has ALREADY confirmed speech internally before
   * emitting `speech_start` (e.g. Silero's `minSpeechFrames` neural gate), so
   * the SDK must NOT apply its own candidate-window debounce. The SDK's
   * candidate mechanism (minSpeechMs wall-clock window) exists for raw
   * threshold detectors like the energy VAD, whose `speech_start` fires the
   * instant RMS crosses up — those need a second confirmation. For a
   * self-debounced adapter that confirmation is redundant and HARMFUL: the
   * adapter may emit speech_start then a quick speech_end (short utterance,
   * or start/end on adjacent frames), and the candidate window would abort it
   * as "noise", so the turn never commits. When true, the SDK begins the turn
   * on speech_start and commits on speech_end directly.
   *
   * Omitted/false → energy-style raw detector → SDK applies candidate debounce.
   */
  readonly selfDebounced?: boolean;

  /**
   * Feed a chunk of PCM16 mono 24kHz audio.
   *
   * Returns a single VadEvent if this chunk caused a boundary transition,
   * or null if there is no state change. Adapters that detect multiple
   * transitions within a single buffer should buffer the second one and
   * report it on the next call — the SDK's audio pump runs at ≥10Hz so
   * the deferred event is at most one frame late.
   *
   * Implementations should be cheap enough to run synchronously per audio
   * frame; the Promise return type is to accommodate ML-based adapters
   * (Silero ONNX inference) without forcing the SDK to assume sync.
   */
  processFrame(pcm: Buffer): Promise<VadEvent | null>;

  /**
   * Reset internal state. Called when the session begins a new turn boundary
   * not driven by VAD (e.g. user pressed PTT mid-duplex, or backend switched
   * input mode). Must not throw; idempotent.
   */
  reset(): void;

  /**
   * Release resources. Called on session shutdown or VAD swap. ONNX adapters
   * should release their inference session here; energy adapters are no-op.
   * Must not throw; idempotent.
   */
  dispose(): Promise<void>;
}

/**
 * Boundary event emitted by a VAD adapter.
 *
 * `speech_start` — sustained energy/probability above threshold for the
 * configured pre-roll duration. The SDK uses this to begin a user audio
 * turn (and to detect barge-in if assistant audio is currently playing).
 *
 * `speech_end` — sustained silence below threshold for the configured
 * silence duration. The SDK uses this to commit the user audio buffer
 * and request a response from the backend.
 */
export type VadEvent = { type: "speech_start" } | { type: "speech_end" };

/**
 * Factory function every VAD plugin must export (either as a named
 * `createVadAdapter` or as the module's default export).
 *
 * The `options` parameter is opaque to the SDK — the plugin defines its
 * own option shape. The SDK simply forwards whatever the user put in their
 * config's `options` field. This keeps SDK ↔ plugin coupling at zero.
 *
 * Plugins may return either a sync VadAdapter (energy-style) or a Promise
 * (Silero-style, since ONNX session construction is async). The resolver
 * handles both.
 */
export type VadFactory = (
  options?: unknown,
) => VadAdapter | Promise<VadAdapter>;

/**
 * User-facing config value for selecting a VAD. Accepts either a short
 * string name (built-in or known plugin) or a structured object with
 * optional adapter-specific options.
 *
 * Examples:
 *   "energy"
 *   { type: "silero" }
 *   { type: "silero", options: { positiveSpeechThreshold: 0.6 } }
 *   { type: "@user/my-vad" }   // third-party plugin, full module name
 */
export type VadConfig =
  | string
  | {
      type: string;
      options?: unknown;
    };
