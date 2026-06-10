import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createDoctorReport,
  renderDoctorReport,
  resolveCommandLookupExecutable,
} from "../src/commands/doctor-command.js";
import {
  resolveVoiceAudioDriverPlan,
  type VoiceAudioDriverPlanInput,
} from "../src/runtime/build-voice-runtime.js";
import { shouldAutoStartOpenTui } from "../src/runtime/open-tui-capability.js";

test("createDoctorReport flags placeholder API keys without network calls", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "step-doctor-"));
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      model: { apiKey: "<your_api_key>" },
      voice: { realtime: { apiKey: "<your_stepfun_api_key>" } },
    }),
  );

  const report = await createDoctorReport({
    workspaceRoot: dir,
    explicitConfigPath: configPath,
    commandExists: async () => false,
    env: {},
  });

  assert.equal(report.ok, false);
  assert.equal(report.checks.config.status, "ok");
  assert.equal(report.checks.modelApiKey.status, "warn");
  assert.equal(report.checks.voiceApiKey.status, "warn");
  assert.equal(report.checks.pnpm.status, "warn");
});

test("renderDoctorReport includes actionable check names", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "step-doctor-"));
  const report = await createDoctorReport({
    workspaceRoot: dir,
    commandExists: async (name) => name === "node",
    env: { STEP_API_KEY: "sk-test" },
  });

  const rendered = renderDoctorReport(report);

  assert.match(rendered, /Step CLI doctor/);
  assert.match(rendered, /Node.js/);
  assert.match(rendered, /Config/);
  assert.match(rendered, /Model API key/);
});

test("resolveCommandLookupExecutable uses Windows command discovery", () => {
  assert.equal(resolveCommandLookupExecutable("win32"), "where");
  assert.equal(resolveCommandLookupExecutable("darwin"), "which");
  assert.equal(resolveCommandLookupExecutable("linux"), "which");
});

test("createDoctorReport accepts Chrome discovered from Windows install paths", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "step-doctor-"));
  const report = await createDoctorReport({
    workspaceRoot: dir,
    platform: "win32",
    commandExists: async (name) => name === "pnpm",
    findChrome: async () =>
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    env: { STEP_API_KEY: "sk-test" },
  });

  assert.equal(report.checks.chrome.status, "ok");
  assert.match(report.checks.chrome.message, /Chrome\/Chromium found/);
});

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
