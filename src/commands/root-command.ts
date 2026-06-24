import { Command } from "commander";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  configureCommanderProgram,
  parseCommanderProgram,
} from "./commander-utils.js";
import {
  configureSharedRuntimeOptions,
  readSharedRuntimeCliOptionSources,
  type SharedRuntimeCliOptions,
} from "./shared-runtime-options.js";
import { STEP_CLI_VERSION } from "../version.js";
import { readPromptCommandInput } from "./command-utils.js";
import { resolveStepCliRuntimeConfig } from "../runtime/runtime-config.js";
import { createLocalCliClientApp } from "../runtime/local-cli-app.js";
import {
  isOpenTuiEnabledInCurrentBuild,
  loadOpenTuiClientAppFactoryAtRuntime,
} from "../runtime/open-tui-capability.js";

// OpenTUI is always enabled; keep this compile-time constant so rolldown
// can fold the bundle's TTY startup path away before it reaches the loader.
const OPEN_TUI_COMPILE_TIME_ENABLED = true;

export async function runRootCommand(argv: string[]): Promise<void> {
  const program = configureCommanderProgram(new Command());

  configureSharedRuntimeOptions(
    program
      .name("step-cli")
      .description("Fast CLI coding assistant (OpenAI/Anthropic, tool-enabled)")
      .version(STEP_CLI_VERSION.value)
      .argument("[prompt...]", "One-shot prompt"),
    {
      includeSessionFile: true,
      includeResume: true,
      includeAltScreen: true,
      includeJson: true,
    },
  )
    .addHelpText(
      "after",
      [
        "",
        "One-shot commands:",
        "  step exec                  Run a single prompt non-interactively",
        "  step resume <session_id>   Resume the specified local session",
        "  step goal                  Manage a persistent session goal",
        "  step artifacts             Inspect persisted run artifacts",
        "  step theme                 Export the current TUI theme file",
        "  step theme check <file>    Validate a custom TUI theme file",
        "  step voice                 Start the realtime voice TUI (preview)",
        "  step vad                   Inspect or select the voice activity detector",
        "  step aec                   Enable/disable browser-helper echo cancellation",
        "",
        "Config commands:",
        "  step config path           Show user/workspace config paths",
        "  step config show           Show merged config and resolved defaults",
        "  step config init           Create a step-cli config template",
        "  step config sync           Fill in config keys missing from newer versions",
        "",
        "Service commands:",
        "  step serve                 Run local step-cli HTTP session service",
      ].join("\n"),
    )
    .action(
      async (
        promptParts: string[],
        options: SharedRuntimeCliOptions,
        actionCommand: Command,
      ) => {
        const { prompt, attachments } = await readPromptCommandInput({
          promptParts,
          imageValues: options.image,
          baseDir: process.cwd(),
        });
        const cliOptionSources =
          readSharedRuntimeCliOptionSources(actionCommand);
        const shouldUseTui =
          OPEN_TUI_COMPILE_TIME_ENABLED &&
          isOpenTuiEnabledInCurrentBuild() &&
          !options.json &&
          (prompt?.trim().length ?? 0) === 0 &&
          (attachments?.length ?? 0) === 0 &&
          process.stdin.isTTY === true &&
          process.stdout.isTTY === true;
        const { stepCliConfig } = await resolveStepCliRuntimeConfig({
          options,
          cliOptionSources,
          resumeSession: Boolean(options.resume),
          useAlternateScreen: shouldUseTui ? options.altScreen : false,
          interactionSurface: shouldUseTui ? "interactive" : undefined,
        });
        if (shouldUseTui) {
          // @opentui/core is a Bun-only bundle: it statically imports from
          // "bun:ffi" which Node's ESM loader cannot resolve (ERR_UNSUPPORTED_ESM_URL_SCHEME).
          // The TUI must therefore run under Bun. Non-TUI paths (exec/serve/help/...)
          // are unaffected and continue to run under Node. When already in a Bun
          // process (process.versions.bun is defined) we proceed in-process;
          // otherwise we respawn ourselves under Bun, inheriting stdio so the
          // child re-acquires the TTY. No config/IPC hand-off is needed — the
          // child re-parses argv and re-resolves the runtime config from scratch.
          if (typeof process.versions.bun === "undefined") {
            const bunProbe = spawnSync("bun", ["--version"], {
              stdio: "ignore",
            });
            if (bunProbe.error || bunProbe.status !== 0) {
              process.stderr.write(
                "step-cli: TUI requires the Bun runtime (@opentui/core uses bun:ffi, unsupported by Node). " +
                  "Install Bun from https://bun.sh then retry.\n",
              );
              process.exitCode = 1;
              return;
            }

            const entryScriptPath =
              process.argv[1] ??
              path.join(
                path.resolve(
                  path.dirname(fileURLToPath(import.meta.url)),
                  "..",
                ),
                "bin",
                "step-cli.js",
              );

            await new Promise<void>((resolve) => {
              const child = spawn(
                "bun",
                [entryScriptPath, ...process.argv.slice(2)],
                {
                  stdio: "inherit",
                  env: process.env,
                },
              );
              child.once("error", () => {
                process.exitCode = 1;
                resolve();
              });
              child.once("exit", (code, signal) => {
                if (signal) {
                  try {
                    process.kill(process.pid, signal);
                  } catch {
                    /* signal forwarding best-effort */
                  }
                }
                process.exitCode = code ?? 1;
                resolve();
              });
            });
            return;
          }

          const createLocalTuiClientApp =
            await loadOpenTuiClientAppFactoryAtRuntime();
          const app = await createLocalTuiClientApp(stepCliConfig);
          try {
            await app.run();
          } finally {
            await app.close();
          }
          return;
        }

        const app = await createLocalCliClientApp(stepCliConfig);
        try {
          await app.run({
            prompt,
            attachments,
            json: Boolean(options.json),
          });
        } finally {
          await app.close();
        }
      },
    );

  await parseCommanderProgram(program, ["node", "step", ...argv]);
}
