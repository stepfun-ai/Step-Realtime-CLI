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
import { resolveStepCliRuntimeConfig } from "../runtime/runtime-config.js";
import { createLocalCliClientApp } from "../runtime/local-cli-app.js";
import {
  isOpenTuiEnabledInCurrentBuild,
  loadOpenTuiClientAppFactoryAtRuntime,
  shouldAutoStartOpenTui,
} from "../runtime/open-tui-capability.js";

// Keep this build flag in the command module so rolldown can fold the bundle's
// TTY startup path away before it ever reaches the OpenTUI loader.
const OPEN_TUI_COMPILE_TIME_ENABLED =
  process.env.STEP_CLI_ENABLE_OPENTUI !== "0";

export async function runResumeCommand(argv: string[]): Promise<void> {
  const resumeProgram = configureCommanderProgram(new Command());

  configureSharedRuntimeOptions(
    resumeProgram
      .name("step resume")
      .description("Resume the specified local session")
      .showHelpAfterError()
      .argument("<sessionId>", "Session id to resume"),
    {
      includeSessionFile: false,
      includeResume: false,
      includeAltScreen: true,
      includeJson: true,
    },
  ).action(
    async (
      sessionId: string,
      options: SharedRuntimeCliOptions,
      actionCommand: Command,
    ) => {
      const cliOptionSources = readSharedRuntimeCliOptionSources(actionCommand);
      const shouldUseTui = shouldAutoStartOpenTui({
        buildEnabled:
          OPEN_TUI_COMPILE_TIME_ENABLED && isOpenTuiEnabledInCurrentBuild(),
        json: Boolean(options.json),
        hasPrompt: false,
        hasAttachments: false,
        stdinIsTty: process.stdin.isTTY === true,
        stdoutIsTty: process.stdout.isTTY === true,
        openTuiEnvValue: process.env.STEP_CLI_ENABLE_OPENTUI,
      });
      const { stepCliConfig } = await resolveStepCliRuntimeConfig({
        options,
        cliOptionSources,
        resumeSession: true,
        useAlternateScreen: shouldUseTui ? options.altScreen : false,
        interactionSurface: shouldUseTui ? "interactive" : undefined,
      });
      const resolvedStepCliConfig = {
        ...stepCliConfig,
        sessionId,
      };

      if (shouldUseTui) {
        const createLocalTuiClientApp =
          await loadOpenTuiClientAppFactoryAtRuntime();
        const app = await createLocalTuiClientApp(resolvedStepCliConfig);
        try {
          await app.run();
        } finally {
          await app.close();
        }
        return;
      }

      const app = await createLocalCliClientApp(resolvedStepCliConfig);
      try {
        await app.run({
          json: Boolean(options.json),
        });
      } finally {
        await app.close();
      }
    },
  );

  await parseCommanderProgram(resumeProgram, ["node", "step resume", ...argv]);
}
