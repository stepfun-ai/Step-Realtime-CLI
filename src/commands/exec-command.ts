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
import { readPromptCommandInput } from "./command-utils.js";
import { resolveStepCliRuntimeConfig } from "../runtime/runtime-config.js";
import { createLocalCliClientApp } from "../runtime/local-cli-app.js";

export async function runExecCommand(argv: string[]): Promise<void> {
  const execProgram = configureCommanderProgram(new Command());

  configureSharedRuntimeOptions(
    execProgram
      .name("step exec")
      .description(
        "Run a single prompt without interactive REPL or TUI prompts",
      )
      .showHelpAfterError()
      .argument("[prompt...]", "One-shot prompt"),
    {
      includeSessionFile: true,
      includeResume: true,
      includeAltScreen: false,
      includeJson: true,
    },
  ).action(
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
      if (prompt.length === 0 && attachments.length === 0) {
        throw new Error(
          "step exec requires a prompt argument, stdin input, or at least one --image attachment",
        );
      }

      const cliOptionSources = readSharedRuntimeCliOptionSources(actionCommand);
      const { stepCliConfig } = await resolveStepCliRuntimeConfig({
        options,
        cliOptionSources,
        resumeSession: Boolean(options.resume),
        useAlternateScreen: false,
        interactionSurface: options.json ? "json" : "headless",
      });
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

  await parseCommanderProgram(execProgram, ["node", "step exec", ...argv]);
}
