import { describe, it, expect } from "vitest";
import {
  resolveVoiceAudioDriverPlan,
  type VoiceAudioDriverPlan,
} from "./voice-audio-driver-selection.js";

describe("resolveVoiceAudioDriverPlan", () => {
  it("uses the browser audio driver on Windows even when AEC is not explicitly enabled", () => {
    const plan = resolveVoiceAudioDriverPlan({
      platform: "win32",
      aecConfigured: false,
      envAec: false,
      browserAvailable: true,
    });

    expect(plan).toEqual({
      kind: "browser",
      reason: "windows_requires_browser_audio",
    } satisfies VoiceAudioDriverPlan);
  });

  it("fails fast on Windows when Chrome/Chromium is unavailable", () => {
    const plan = resolveVoiceAudioDriverPlan({
      platform: "win32",
      aecConfigured: false,
      envAec: false,
      browserAvailable: false,
    });

    if (plan.kind !== "unavailable") {
      throw new Error(`Expected unavailable plan, got ${plan.kind}`);
    }
    expect(plan.message).toMatch(
      /Chrome\/Chromium is required for voice mode on Windows/,
    );
  });

  it("preserves the existing non-Windows fallback to Sox when browser AEC is unavailable", () => {
    const plan = resolveVoiceAudioDriverPlan({
      platform: "darwin",
      aecConfigured: true,
      envAec: false,
      browserAvailable: false,
    });

    expect(plan).toEqual({
      kind: "sox",
      reason: "browser_aec_unavailable_fallback",
    } satisfies VoiceAudioDriverPlan);
  });
});
