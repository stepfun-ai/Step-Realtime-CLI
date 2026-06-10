import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createDoctorReport,
  renderDoctorReport,
} from "../src/commands/doctor-command.js";

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
