import type {
  AudioDriver,
  AudioCaptureHandle,
  AudioPlaybackHandle,
  AudioProbeResult,
} from "./driver.js";

export class NullAudioDriver implements AudioDriver {
  startCapture(): AudioCaptureHandle {
    return {
      stream: (async function* () {
        // yields nothing — silence
      })(),
      stop() {},
    };
  }

  startPlayback(): AudioPlaybackHandle {
    return {
      write() {},
      flush() {},
      stop() {},
    };
  }

  async probe(): Promise<AudioProbeResult> {
    return {
      captureAvailable: false,
      playbackAvailable: false,
    };
  }

  async dispose(): Promise<void> {}
}
