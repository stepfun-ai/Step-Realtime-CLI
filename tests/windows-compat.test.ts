import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveVoiceAudioDriverPlan,
  type VoiceAudioDriverPlanInput,
} from "../src/runtime/build-voice-runtime.js";
import { shouldAutoStartOpenTui } from "../src/runtime/open-tui-capability.js";

test("Windows does not auto-start OpenTUI unless explicitly enabled", () => {
  const base = {
    buildEnabled: true,
    json: false,
    hasPrompt: false,
    hasAttachments: false,
    stdinIsTty: true,
    stdoutIsTty: true,
    platform: "win32" as NodeJS.Platform,
  };

  assert.equal(shouldAutoStartOpenTui(base), false);
  assert.equal(
    shouldAutoStartOpenTui({
      ...base,
      openTuiEnvValue: "1",
    }),
    true,
  );
});

test("Windows voice audio does not fall back to system arecord/aplay drivers", () => {
  const base: VoiceAudioDriverPlanInput = {
    platform: "win32",
    aecEnabled: false,
    browserAudioAvailable: false,
  };

  assert.equal(resolveVoiceAudioDriverPlan(base), "unsupported");
  assert.equal(
    resolveVoiceAudioDriverPlan({
      ...base,
      aecEnabled: true,
    }),
    "unsupported",
  );
  assert.equal(
    resolveVoiceAudioDriverPlan({
      ...base,
      aecEnabled: true,
      browserAudioAvailable: true,
    }),
    "browser",
  );
});
