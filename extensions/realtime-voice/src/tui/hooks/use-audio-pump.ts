import { useEffect } from "react";
import type { RealtimeSession } from "@step-cli/realtime";
import type { AudioDriver } from "../../audio/driver.js";

export function useAudioPump(
  session: RealtimeSession | null,
  driver: AudioDriver | null,
  isRecording: boolean,
): void {
  useEffect(() => {
    if (!session || !driver || !isRecording) {
      return;
    }

    const capture = driver.startCapture();
    let stopped = false;
    let chunks = 0;

    (async () => {
      for await (const chunk of capture.stream) {
        if (stopped) break;
        chunks++;
        session.appendUserAudio(chunk);
      }
    })().catch(() => {});

    // Commit when recording stops (PTT release / mute toggle / unmount).
    // NOTE: the commit MUST live in this cleanup. The previous version tried to
    // commit in a follow-up effect pass (`if (!isRecording) { ... commit }`),
    // but React runs this cleanup first and it nulled the capture ref, so that
    // branch's `if (captureRef.current)` was always false → commitUserAudio was
    // never called → the stateless backend never received input_audio_buffer
    // .commit → no transcription, no response.
    return () => {
      stopped = true;
      capture.stop();
      if (chunks > 0) {
        session.commitUserAudio();
      }
    };
  }, [session, driver, isRecording]);
}
