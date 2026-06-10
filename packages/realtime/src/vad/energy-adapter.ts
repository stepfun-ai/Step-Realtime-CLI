/**
 * Built-in energy VAD.
 *
 * Ported from harness-ts/web/vad-controller.js (the JS implementation that
 * has driven the browser frontend's duplex mode since P5.2). Algorithm,
 * default thresholds, and timing parameters are preserved verbatim — the
 * web version has shipped and proven viable in the "quiet room, single
 * speaker" envelope; we don't have stronger evidence to retune.
 *
 * Algorithm: 4-state FSM with hysteresis on RMS energy.
 *   silent  → above thresholdUp for startMs    → speaking (emit speech_start)
 *   speaking → below thresholdDown for silenceMs → silent (emit speech_end)
 * Hysteresis (separate up/down thresholds) prevents edge flutter.
 *
 * Quality envelope (matches web/vad-controller.js):
 *   - "is there sustained sound" detector, NOT a phoneme/speech detector
 *   - Works well in quiet rooms with a single speaker
 *   - Degrades sharply with background noise, keyboard typing, fans
 *   - For noisy environments, switch to PTT or install Silero VAD plugin
 */

import type { VadAdapter, VadEvent, VadFactory } from "./types.js";

export interface EnergyVadOptions {
  /** RMS threshold to start considering speech onset (0..1). Default 0.025. */
  thresholdUp?: number;
  /** RMS threshold for "silence" once speaking (0..1). Default 0.012. */
  thresholdDown?: number;
  /** Sustained-above-up time before emitting speech_start (ms). Default 120. */
  startMs?: number;
  /** Sustained-below-down time before emitting speech_end (ms). Default 600. */
  silenceMs?: number;
  /** Input sample rate (Hz). Default 24000 to match SoxAudioDriver canonical. */
  sampleRate?: number;
}

type State = "silent" | "rising" | "speaking" | "falling";

class EnergyVadAdapter implements VadAdapter {
  private readonly thresholdUp: number;
  private readonly thresholdDown: number;
  private readonly startMs: number;
  private readonly silenceMs: number;
  private readonly sampleRate: number;

  private state: State = "silent";
  /** Wall-clock equivalent computed from sample count — robust against
   *  GC pauses / event loop jitter that would skew performance.now(). */
  private sampleClockMs = 0;
  /** Sample-clock time at which the current state was entered. */
  private stateSinceMs = 0;

  constructor(opts: EnergyVadOptions = {}) {
    this.thresholdUp = opts.thresholdUp ?? 0.025;
    this.thresholdDown = opts.thresholdDown ?? 0.012;
    this.startMs = opts.startMs ?? 120;
    this.silenceMs = opts.silenceMs ?? 600;
    this.sampleRate = opts.sampleRate ?? 24000;
  }

  async processFrame(pcm: Buffer): Promise<VadEvent | null> {
    if (pcm.length === 0) return null;

    // PCM16LE → Int16 view without copy. Buffer.byteOffset must align to 2;
    // Node always allocates Buffer slabs on word boundaries so this holds.
    const int16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >>> 1);

    const rms = computeRms(int16);
    const chunkMs = (int16.length / this.sampleRate) * 1000;
    this.sampleClockMs += chunkMs;

    switch (this.state) {
      case "silent":
        if (rms >= this.thresholdUp) {
          this.state = "rising";
          this.stateSinceMs = this.sampleClockMs;
        }
        return null;

      case "rising":
        if (rms < this.thresholdDown) {
          // Crossed back below before sustaining — flutter, drop back.
          this.state = "silent";
          return null;
        }
        if (this.sampleClockMs - this.stateSinceMs >= this.startMs) {
          this.state = "speaking";
          this.stateSinceMs = this.sampleClockMs;
          return { type: "speech_start" };
        }
        return null;

      case "speaking":
        if (rms <= this.thresholdDown) {
          this.state = "falling";
          this.stateSinceMs = this.sampleClockMs;
        }
        return null;

      case "falling":
        if (rms > this.thresholdUp) {
          // Recovered — still speaking.
          this.state = "speaking";
          return null;
        }
        if (this.sampleClockMs - this.stateSinceMs >= this.silenceMs) {
          this.state = "silent";
          return { type: "speech_end" };
        }
        return null;
    }
  }

  reset(): void {
    // If we were mid-speech when reset, the caller (RealtimeSession) is
    // taking over turn management explicitly — drop back to silent without
    // emitting a synthetic speech_end (that would double-fire commitUserAudio).
    this.state = "silent";
    this.sampleClockMs = 0;
    this.stateSinceMs = 0;
  }

  async dispose(): Promise<void> {
    // No resources held.
  }
}

/**
 * RMS over Int16 samples, normalized to [0, 1].
 * Hot path — keep tight; called once per audio chunk (~10-50Hz).
 */
function computeRms(samples: Int16Array): number {
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] / 32768;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples.length);
}

/**
 * Factory matching the VadFactory contract. `resolver.ts` calls this for
 * the built-in "energy" name.
 */
export const createVadAdapter: VadFactory = (options) => {
  return new EnergyVadAdapter((options as EnergyVadOptions) ?? {});
};
