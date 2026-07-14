export type VoiceAudioDriverPlan =
  | {
      kind: "browser";
      reason:
        | "aec_enabled"
        | "env_aec_enabled"
        | "windows_requires_browser_audio";
    }
  | {
      kind: "sox";
      reason: "aec_disabled" | "browser_aec_unavailable_fallback";
    }
  | {
      kind: "unavailable";
      reason: "windows_browser_audio_unavailable";
      message: string;
    };

export interface VoiceAudioDriverPlanInput {
  platform: NodeJS.Platform | string;
  aecConfigured: boolean;
  envAec: boolean;
  browserAvailable: boolean;
}

export function resolveVoiceAudioDriverPlan(
  input: VoiceAudioDriverPlanInput,
): VoiceAudioDriverPlan {
  if (input.platform === "win32") {
    if (input.browserAvailable) {
      return {
        kind: "browser",
        reason: "windows_requires_browser_audio",
      };
    }

    return {
      kind: "unavailable",
      reason: "windows_browser_audio_unavailable",
      message:
        "Chrome/Chromium is required for voice mode on Windows. Install Chrome, Edge, or Chromium, or set STEP_CHROME_PATH to an existing browser executable.",
    };
  }

  if (!input.aecConfigured && !input.envAec) {
    return {
      kind: "sox",
      reason: "aec_disabled",
    };
  }

  if (input.browserAvailable) {
    return {
      kind: "browser",
      reason: input.envAec ? "env_aec_enabled" : "aec_enabled",
    };
  }

  return {
    kind: "sox",
    reason: "browser_aec_unavailable_fallback",
  };
}
