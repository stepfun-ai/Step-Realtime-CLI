import { Command } from "commander";
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
  resolveOpenTuiClientAppFactoryAtRuntime,
} from "../runtime/open-tui-capability.js";

// Keep this build flag in the command module so rolldown can fold the bundle's
// TTY startup path away before it ever reaches the OpenTUI loader.
const OPEN_TUI_COMPILE_TIME_ENABLED =
  process.env.STEP_CLI_ENABLE_OPENTUI !== "0";

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
          const openTuiRuntime =
            await resolveOpenTuiClientAppFactoryAtRuntime();
          if (openTuiRuntime.available) {
            const app =
              await openTuiRuntime.createLocalTuiClientApp(stepCliConfig);
            try {
              await app.run();
            } finally {
              await app.close();
            }
            return;
          }

          process.stderr.write(
            `step-cli warning: OpenTUI runtime unavailable, falling back to the text CLI: ${openTuiRuntime.reason}\n`,
          );
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
