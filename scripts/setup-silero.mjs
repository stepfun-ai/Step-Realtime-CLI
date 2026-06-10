#!/usr/bin/env node
/**
 * One-shot installer for the optional Silero VAD plugin.
 *
 * Silero (@step-cli/realtime-vad-silero) is NOT installed by default: it pulls
 * avr-vad + onnxruntime-node, whose ~50MB native binary would otherwise be
 * forced on everyone — including users who only want the built-in energy VAD.
 * This script makes enabling it a deliberate, single command.
 *
 * What it does:
 *   1. `pnpm install --filter @step-cli/realtime-vad-silero...` — installs the
 *      JS of avr-vad / onnxruntime-node (the silero plugin's deps) WITHOUT
 *      resolving the rest of the monorepo. A bare `pnpm install` would also
 *      pull unrelated workspace deps and their per-platform optional packages,
 *      which is confusing and off-topic here. The Silero model weights ship
 *      inside the avr-vad tarball, so there is no separate model download step.
 *   2. `pnpm rebuild onnxruntime-node` — runs onnxruntime-node's install script
 *      to fetch its native binary. pnpm 10 blocks this script by default
 *      (it's not in onlyBuiltDependencies); `rebuild <pkg>` runs it explicitly
 *      without globally allow-listing builds for everyone.
 *   3. Verifies the binary loads.
 *
 * It does NOT touch config — selecting the VAD (writing `vad: "silero"` to
 * ~/.step-cli/voice-preferences.json) is a deliberate user choice, printed as
 * a next step rather than done silently.
 *
 * Usage:  pnpm setup:silero
 *         pnpm setup:silero --registry https://registry.npmjs.org   (mirror fallback)
 */

import { spawn } from "node:child_process";
import process from "node:process";

const repoRoot = process.cwd();
const passthrough = process.argv.slice(2); // e.g. --registry ... / --https-proxy ...

function run(cmd, args) {
  return new Promise((resolve) => {
    process.stdout.write(`\n$ ${cmd} ${args.join(" ")}\n`);
    const child = spawn(cmd, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", (err) => {
      process.stderr.write(`failed to spawn ${cmd}: ${err.message}\n`);
      resolve(1);
    });
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function verifyBinary() {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["-e", "require('onnxruntime-node')"],
      { cwd: repoRoot, env: process.env, stdio: "ignore" },
    );
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

async function main() {
  // Invoked via `pnpm setup:silero`, so the pnpm shim is on PATH for subprocesses.
  const pnpm = "pnpm";

  process.stdout.write(
    "Installing the Silero plugin subtree (avr-vad / onnxruntime-node)…\n" +
      "Note: this installs only the silero plugin's deps. Run `pnpm install`\n" +
      "separately for the rest of the project.\n",
  );
  // Scope to the silero workspace package + its deps only. A bare `pnpm install`
  // would resolve the whole monorepo — pulling unrelated workspace deps and
  // their per-platform optional packages, which looks alarming and is not what
  // "setup:silero" should do.
  const filter = ["--filter", "@step-cli/realtime-vad-silero..."];
  if ((await run(pnpm, ["install", ...filter, ...passthrough])) !== 0) {
    fail("pnpm install (silero subtree) failed.");
    return 1;
  }

  // Force onnxruntime-node's blocked install script to run and fetch the binary.
  if (
    (await run(pnpm, ["rebuild", "onnxruntime-node", ...passthrough])) !== 0
  ) {
    fail("pnpm rebuild onnxruntime-node failed.");
    return 1;
  }

  if (!(await verifyBinary())) {
    fail("onnxruntime-node installed but its native binary failed to load.");
    return 1;
  }

  process.stdout.write(
    [
      "",
      "✓ Silero VAD installed (avr-vad + onnxruntime-node binary present).",
      "",
      "Enable it (deliberate, per-machine choice):",
      '  echo \'{ "vad": "silero" }\' > ~/.step-cli/voice-preferences.json',
      "",
      "Then run duplex voice:",
      "  pnpm step voice -w <workspace>",
      "",
    ].join("\n"),
  );
  return 0;
}

function fail(msg) {
  process.stderr.write(
    [
      "",
      `✗ ${msg}`,
      "",
      "Most failures are the company npm mirror not proxying microsoft.com",
      "(onnxruntime-node downloads its binary from there). Retry via the",
      "official registry or a proxy:",
      "",
      "  pnpm setup:silero --registry https://registry.npmjs.org",
      "  # or:",
      "  HTTPS_PROXY=http://your-proxy:port pnpm setup:silero",
      "",
      "Other fallbacks (manual binary placement) are in",
      "extensions/realtime-vad-silero/README.md → Troubleshooting.",
      "",
    ].join("\n"),
  );
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`setup-silero error: ${err?.message ?? err}\n`);
    process.exit(1);
  },
);
