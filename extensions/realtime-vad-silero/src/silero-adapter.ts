/**
 * Silero VAD adapter — wraps avr-vad's RealTimeVAD to satisfy the SDK's
 * VadAdapter contract.
 *
 * avr-vad's actual API (corrected after smoke-test failure exposed wrong
 * assumptions in the prior version):
 *   - RealTimeVAD.new(options) — single async factory
 *   - processAudio(Float32Array) — accepts any sample rate (avr-vad
 *     internally resamples to 16kHz). No fixed frame size requirement.
 *   - Speech events arrive via callbacks: onSpeechStart, onSpeechEnd(audio),
 *     onVADMisfire — we register them in options and translate to our
 *     VadEvent shape inside a per-call queue.
 *   - sampleRate is required option (input rate, not Silero's internal).
 *   - destroy() is async.
 *
 * Resampling: NOT done by us — avr-vad handles the 24k→16k internally. We
 * only do PCM16 LE → Float32 normalization.
 *
 * onSpeechEnd's `audio: Float32Array` argument carries the captured speech
 * segment; we ignore it (the SDK already has the raw frames going to the
 * backend). onVADMisfire fires when speech ended before minSpeechFrames —
 * we map this to a "no event" outcome (no speech_start was reported, so
 * nothing to follow up).
 */

import { logger } from "@step-cli/realtime";
import type { VadAdapter, VadEvent } from "@step-cli/realtime";

const log = logger.child({ component: "silero-vad" });

export interface SileroOptions {
  model?: "v5" | "legacy";
  positiveSpeechThreshold?: number;
  negativeSpeechThreshold?: number;
  redemptionFrames?: number;
  minSpeechFrames?: number;
  preSpeechPadFrames?: number;
}

const SDK_INPUT_RATE = 24000;

interface AvrVadInstance {
  start(): void;
  pause(): void;
  processAudio(audioData: Float32Array): Promise<void>;
  flush(): Promise<void>;
  reset(): void;
  destroy(): Promise<void>;
}

interface AvrVadModule {
  RealTimeVAD: {
    new: (options?: Record<string, unknown>) => Promise<AvrVadInstance>;
  };
}

class SileroVadAdapter implements VadAdapter {
  /** Silero confirms speech via its own minSpeechFrames neural gate before
   *  emitting speech_start, so the SDK must skip its candidate-window
   *  debounce (which is for raw energy detectors). See VadAdapter.selfDebounced. */
  readonly selfDebounced = true;
  private disposed = false;
  /** Event queue accumulated during a single processFrame call. avr-vad
   *  fires callbacks synchronously while we await processAudio; we drain
   *  this and return the latest edge to the caller. */
  private pendingEvents: VadEvent[] = [];
  private _inDiag = 0;

  private constructor(private readonly vad: AvrVadInstance) {}

  static async create(options: SileroOptions = {}): Promise<SileroVadAdapter> {
    // avr-vad is an optional peer dependency — it may not be installed in dev
    // or CI (it pulls onnxruntime-node's ~50MB native binary). Use a widened
    // (string-typed) specifier so tsc does not statically resolve it; a literal
    // would fail with TS2307 when uninstalled. Resolution happens at runtime,
    // where the SDK's resolveVadAdapter catches a missing module and surfaces
    // an install hint.
    const moduleName: string = "avr-vad";
    const mod = (await import(moduleName)) as unknown as AvrVadModule;

    // Forward refs so callbacks can push into the same queue used by
    // processFrame's caller. We assign them in the closure below after
    // the instance variable is constructed.
    let adapter: SileroVadAdapter | null = null;

    // Default 0.6 (not Silero's 0.5): the looser 0.5 lets low-energy noise /
    // residual speaker echo (even with AEC on) cross into "speech", which
    // commits empty turns the realtime model then confabulates coding tasks
    // from. 0.6 demands a more confident speech frame.
    const posThreshold = options.positiveSpeechThreshold ?? 0.6;
    const negThreshold = options.negativeSpeechThreshold ?? 0.4;
    // Default 16 (~1.5s of silence) rather than avr-vad's 8 (~768ms): in a
    // voice conversation, normal pauses between words/clauses are well under
    // 1.5s, so a smaller value cuts the user off mid-sentence (early
    // speech_end → premature commit → the assistant talks over them).
    const redemptionFrames = options.redemptionFrames ?? 16;
    // Default 8 (~256ms sustained speech) rather than 3 (~96ms): 3 frames is
    // easily reached by a brief noise/echo spike, producing false speech_start
    // → misfire churn and (when it does commit) phantom turns. 8 frames
    // requires a real, sustained utterance before we report speech_start.
    const minSpeechFrames = options.minSpeechFrames ?? 8;

    let segMaxProb = 0;
    let diagCount = 0;
    log.info(
      {
        posThreshold,
        negThreshold,
        redemptionFrames,
        minSpeechFrames,
        model: options.model ?? "v5",
      },
      "silero VAD started",
    );

    const vadOpts: Record<string, unknown> = {
      model: options.model ?? "v5",
      sampleRate: SDK_INPUT_RATE,
      positiveSpeechThreshold: posThreshold,
      negativeSpeechThreshold: negThreshold,
      redemptionFrames,
      minSpeechFrames,
      preSpeechPadFrames: options.preSpeechPadFrames ?? 1,
      onFrameProcessed: (probabilities: { isSpeech: number }) => {
        const p = probabilities.isSpeech;
        if (p > segMaxProb) segMaxProb = p;
        if (++diagCount % 25 === 0) {
          log.info(
            { isSpeech: Number(p.toFixed(3)), posThreshold },
            "[VAD-DIAG] silero frame",
          );
        }
      },
      onSpeechRealStart: () => {},
      onVADMisfire: () => {
        // avr-vad fired onSpeechStart but the segment was too short to be real
        // speech, so it now retracts it. We already reported speech_start to
        // the SDK (which may have begun a turn), so we MUST emit a paired
        // speech_end here — otherwise the turn stays open forever, the backend
        // never gets a commit, and duplex stalls (the user speaks, gets no
        // response, until they switch to PTT). The SDK's minSpeechMs short-turn
        // guard discards the (tiny) turn, so this won't push empty audio.
        log.info(
          { segMaxProb: Number(segMaxProb.toFixed(3)) },
          "[VAD-DIAG] misfire → speech_end (close stray turn)",
        );
        segMaxProb = 0;
        if (adapter && !adapter.disposed) {
          adapter.pendingEvents.push({ type: "speech_end" });
        }
      },
      onSpeechStart: () => {
        log.info("[VAD-DIAG] speech_start");
        segMaxProb = 0;
        if (adapter && !adapter.disposed) {
          adapter.pendingEvents.push({ type: "speech_start" });
        }
      },
      onSpeechEnd: (_audio: Float32Array) => {
        log.info(
          { segMaxProb: Number(segMaxProb.toFixed(3)) },
          "[VAD-DIAG] speech_end",
        );
        if (adapter && !adapter.disposed) {
          adapter.pendingEvents.push({ type: "speech_end" });
        }
      },
    };

    const instance = await mod.RealTimeVAD.new(vadOpts);
    instance.start();

    adapter = new SileroVadAdapter(instance);
    return adapter;
  }

  async processFrame(pcm: Buffer): Promise<VadEvent | null> {
    if (this.disposed || pcm.length === 0) return null;

    // PCM16 LE → Float32 in [-1, 1]. avr-vad does its own resampling
    // from sampleRate (which we set to 24000) down to Silero's 16000.
    const samples = new Int16Array(
      pcm.buffer,
      pcm.byteOffset,
      pcm.length >>> 1,
    );
    const float = new Float32Array(samples.length);
    let maxAbs = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i]! / 32768;
      float[i] = v;
      const a = v < 0 ? -v : v;
      if (a > maxAbs) maxAbs = a;
    }
    // [VAD-DIAG] input amplitude reaching silero. If this stays ~0 while you
    // speak, the mic level/device is the problem, not the VAD.
    if (++this._inDiag % 25 === 0) {
      log.info(
        { maxAbs: Number(maxAbs.toFixed(4)), samples: samples.length },
        "[VAD-DIAG] silero input level",
      );
    }

    try {
      await this.vad.processAudio(float);
    } catch (err) {
      log.warn({ err: String(err) }, "processAudio threw");
      return null;
    }

    // Drain queue. If multiple events arrived in this call (rare; one
    // start + one end within a single buffer), return the LATEST since
    // it represents the most recent state transition. The SDK's own
    // candidate-state logic handles the start→end-too-fast case.
    if (this.pendingEvents.length === 0) return null;
    const last = this.pendingEvents[this.pendingEvents.length - 1]!;
    this.pendingEvents = [];
    return last;
  }

  reset(): void {
    this.pendingEvents = [];
    try {
      this.vad.reset();
    } catch (err) {
      log.warn({ err: String(err) }, "reset threw");
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingEvents = [];
    try {
      await this.vad.destroy();
    } catch (err) {
      log.warn({ err: String(err) }, "destroy threw");
    }
  }
}

export { SileroVadAdapter };
