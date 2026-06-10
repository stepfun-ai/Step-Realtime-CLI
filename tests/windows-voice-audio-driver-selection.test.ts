import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveVoiceAudioDriverPlan,
  type VoiceAudioDriverPlan,
} from "../src/runtime/voice-audio-driver-selection.js";

describe("resolveVoiceAudioDriverPlan", () => {
  it("uses the browser audio driver on Windows even when AEC is not explicitly enabled", () => {
    const plan = resolveVoiceAudioDriverPlan({
      platform: "win32",
      aecConfigured: false,
      envAec: false,
      browserAvailable: true,
    });

    assert.deepEqual(plan, {
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

    assert.equal(plan.kind, "unavailable");
    assert.match(
      plan.message,
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

    assert.deepEqual(plan, {
      kind: "sox",
      reason: "browser_aec_unavailable_fallback",
    } satisfies VoiceAudioDriverPlan);
  });
});
