import { useEffect, useRef } from "react";
import type { RealtimeSession, RealtimeEvent } from "@step-cli/realtime";
import type { AudioDriver, AudioPlaybackHandle } from "../../audio/driver.js";

export function usePlayback(
  session: RealtimeSession | null,
  driver: AudioDriver | null,
): void {
  const playbackRef = useRef<AudioPlaybackHandle | null>(null);

  useEffect(() => {
    if (!session || !driver) return;

    const handle = driver.startPlayback();
    playbackRef.current = handle;

    // Late deltas from a cancelled response are already dropped at the source:
    // the backend marks cancelledResponseId on barge-in and stops emitting that
    // response's audio.delta. So here audio.cancelled just needs to flush the
    // local playback buffer. (Do NOT blacklist by turnId — playback_flush fires
    // with an empty turnId on every speech onset, which would wrongly drop the
    // next real response's frames → no sound.)
    const unsub = session.subscribe((ev: RealtimeEvent) => {
      if (ev.type === "audio.delta") {
        handle.write(ev.pcm);
      } else if (ev.type === "audio.cancelled") {
        handle.flush();
      }
    });

    return () => {
      unsub();
      handle.stop();
      playbackRef.current = null;
    };
  }, [session, driver]);
}
