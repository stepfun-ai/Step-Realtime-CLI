import os from "node:os";
import { Command } from "commander";
import { resolveDefaultVoiceConfigPath } from "../runtime/voice-config-loader.js";
import { readVoiceDefaults, setVoiceDefault } from "./voice-settings-writer.js";
import {
  configureCommanderProgram,
  parseCommanderProgram,
} from "./commander-utils.js";

interface WriteTarget {
  write(chunk: string): unknown;
}

export interface AecCommandIo {
  stdout?: WriteTarget;
  stderr?: WriteTarget;
}

export async function runAecCommand(
  argv: string[],
  io: AecCommandIo = {},
): Promise<void> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const program = createAecCommandProgram({ stdout, stderr });
  await parseCommanderProgram(program, ["node", "step aec", ...argv]);
}

function createAecCommandProgram(input: {
  stdout: WriteTarget;
  stderr: WriteTarget;
}): Command {
  const program = configureCommanderProgram(new Command(), {
    writeOut: (chunk) => {
      input.stdout.write(chunk);
    },
    writeErr: (chunk) => {
      input.stderr.write(chunk);
    },
  });

  program
    .name("step aec")
    .description(
      "Enable, disable, or inspect browser-helper acoustic echo cancellation for duplex voice",
    )
    .showHelpAfterError();

  const configOption: [string, string] = [
    "--config <path>",
    `Config file to read/write (default: ${resolveDefaultVoiceConfigPath()})`,
  ];

  program
    .command("on")
    .description("Enable AEC (voice.defaults.aec = true)")
    .option(...configOption)
    .action(async (opts: { config?: string }) => {
      await applyAec(input, true, opts.config);
    });

  program
    .command("off")
    .description("Disable AEC (voice.defaults.aec = false)")
    .option(...configOption)
    .action(async (opts: { config?: string }) => {
      await applyAec(input, false, opts.config);
    });

  program
    .command("status")
    .description("Show the resolved AEC setting (config, env override, Chrome)")
    .option(...configOption)
    .action(async (opts: { config?: string }) => {
      await reportAecStatus(input, opts.config);
    });

  return program;
}

async function applyAec(
  input: { stdout: WriteTarget; stderr: WriteTarget },
  value: boolean,
  configPath: string | undefined,
): Promise<void> {
  try {
    const { configPath: written } = await setVoiceDefault(
      "aec",
      value,
      configPath,
    );
    input.stdout.write(
      `AEC ${value ? "enabled" : "disabled"} in ${written} (voice.defaults.aec).\n`,
    );
  } catch (err) {
    input.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

async function reportAecStatus(
  input: { stdout: WriteTarget; stderr: WriteTarget },
  configPath: string | undefined,
): Promise<void> {
  const path = configPath ?? resolveDefaultVoiceConfigPath();
  const defaults = await readVoiceDefaults(path);
  const envOverride = process.env.STEP_VOICE_AEC === "1";
  const configValue = defaults.aec ?? false;
  const effective = envOverride || configValue;

  // Probe Chrome availability so the user knows whether AEC can actually run.
  let chrome: string | undefined;
  try {
    const aec = await import("@step-cli/realtime-aec");
    chrome = aec.findChrome();
  } catch {
    chrome = undefined;
  }

  const lines = [
    `config: ${path}`,
    `  voice.defaults.aec: ${defaults.aec === undefined ? "(unset → false)" : configValue}`,
    `env STEP_VOICE_AEC override: ${envOverride ? "on (forces enabled)" : "(unset)"}`,
    `effective: ${effective ? "ENABLED" : "disabled"}`,
  ];
  if (chrome) {
    lines.push(`Chrome helper: found (${chrome})`);
  } else if (os.platform() === "win32") {
    lines.push(
      "Chrome helper: NOT found — Windows voice mode requires BrowserAudioDriver.",
      "  Install Chrome/Chromium, then re-run `step aec status`:",
      ...chromeInstallHint().map((l) => `    ${l}`),
      "  Or point STEP_CHROME_PATH at an existing binary:",
      "    $env:STEP_CHROME_PATH = 'C:\\Path\\To\\chrome.exe'",
    );
  } else {
    lines.push(
      "Chrome helper: NOT found — AEC cannot run, will fall back to sox (no echo cancellation).",
      "  Install a Chrome/Chromium, then re-run `step aec status`:",
      ...chromeInstallHint().map((l) => `    ${l}`),
      "  Or point STEP_CHROME_PATH at an existing binary:",
      "    export STEP_CHROME_PATH=/path/to/google-chrome",
    );
  }
  input.stdout.write(lines.join("\n") + "\n");
}

/** Platform-specific Chrome/Chromium install commands for the AEC helper. */
function chromeInstallHint(): string[] {
  switch (os.platform()) {
    case "darwin":
      return [
        "brew install --cask google-chrome",
        "(or download: https://www.google.com/chrome/)",
      ];
    case "linux":
      return [
        "sudo apt install -y chromium-browser   # Debian/Ubuntu",
        "sudo dnf install -y chromium            # Fedora",
        "(or download Chrome .deb/.rpm: https://www.google.com/chrome/)",
      ];
    case "win32":
      return ["Download Chrome: https://www.google.com/chrome/"];
    default:
      return ["Download Chrome/Chromium: https://www.google.com/chrome/"];
  }
}
