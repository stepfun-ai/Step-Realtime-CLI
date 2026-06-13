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

export interface VadCommandIo {
  stdout?: WriteTarget;
  stderr?: WriteTarget;
}

export async function runVadCommand(
  argv: string[],
  io: VadCommandIo = {},
): Promise<void> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const program = createVadCommandProgram({ stdout, stderr });
  await parseCommanderProgram(program, ["node", "step vad", ...argv]);
}

function createVadCommandProgram(input: {
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
    .name("step vad")
    .description("List or select the voice activity detector for duplex voice")
    .showHelpAfterError();

  program
    .command("list")
    .description("List available VAD adapters and their install state")
    .action(async () => {
      const rt = await import("@step-cli/realtime");
      input.stdout.write(`${await rt.handleVadList()}\n`);
    });

  program
    .command("status")
    .description("Show the currently selected VAD (voice.defaults.vad)")
    .option(
      "--config <path>",
      `Config file to read (default: ${resolveDefaultVoiceConfigPath()})`,
    )
    .action(async (opts: { config?: string }) => {
      const path = opts.config ?? resolveDefaultVoiceConfigPath();
      let defaults: Awaited<ReturnType<typeof readVoiceDefaults>>;
      try {
        defaults = await readVoiceDefaults(path);
      } catch (err) {
        input.stderr.write(
          `${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
        return;
      }
      const selected = defaults.vad;
      input.stdout.write(
        [
          `config: ${path}`,
          `  voice.defaults.vad: ${
            selected === undefined ? "(unset → energy)" : selected
          }`,
          `effective: ${selected ?? "energy"} (only used in duplex; PTT bypasses VAD)`,
        ].join("\n") + "\n",
      );
    });

  program
    .command("set")
    .description(
      'Persist the VAD selection to ~/.step-cli/config.json `voice.defaults.vad` (e.g. "energy" or "silero")',
    )
    .argument("<name>", "VAD adapter name: energy | silero")
    .option(
      "--config <path>",
      `Config file to write (default: ${resolveDefaultVoiceConfigPath()})`,
    )
    .action(async (name: string, opts: { config?: string }) => {
      const rt = await import("@step-cli/realtime");
      const validation = await rt.validateVadName(name);
      if (!validation.ok) {
        input.stderr.write(`${validation.message}\n`);
        process.exitCode = 1;
        return;
      }
      try {
        const { configPath } = await setVoiceDefault("vad", name, opts.config);
        input.stdout.write(
          `VAD set to "${name}" in ${configPath} (voice.defaults.vad).\n`,
        );
      } catch (err) {
        input.stderr.write(
          `${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });

  return program;
}
