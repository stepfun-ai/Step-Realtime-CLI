import process from "node:process";
import type { StepCliConfig } from "../gateway/runtime.js";
import {
  buildResumeCommand,
  resolveLocalSessionTarget,
} from "./local-session-target.js";
import {
  readLocalTuiExitState,
  removeLocalTuiBootstrapConfig,
  STEP_CLI_TUI_BOOTSTRAP_ENV,
  writeLocalTuiBootstrapConfig,
} from "./local-tui-bootstrap.js";
import type { VoiceBootstrapConfig } from "./voice-bootstrap-config.js";

export type CreateLocalTuiClientApp = (
  stepCliConfig: StepCliConfig,
  voice?: VoiceBootstrapConfig,
) => Promise<LocalStepCliTuiApp>;

export class LocalStepCliTuiApp {
  private readonly stepCliConfig: StepCliConfig;
  private readonly voice?: VoiceBootstrapConfig;
  private bootstrapDirPath: string | null = null;

  constructor(stepCliConfig: StepCliConfig, voice?: VoiceBootstrapConfig) {
    this.stepCliConfig = stepCliConfig;
    this.voice = voice;
  }

  async run(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("OpenTUI requires an interactive terminal");
    }

    const { bootstrapDirPath, bootstrapFilePath } =
      await writeLocalTuiBootstrapConfig(this.stepCliConfig, this.voice);
    this.bootstrapDirPath = bootstrapDirPath;
    let exitedCleanly = false;

    try {
      await runLocalOpenTuiWithBootstrap({
        bootstrapFilePath,
      });
      exitedCleanly = true;
    } finally {
      if (exitedCleanly) {
        const finalSessionId =
          (await readLocalTuiExitState(this.bootstrapDirPath))?.sessionId ??
          this.stepCliConfig.sessionId;
        if (finalSessionId?.trim()) {
          process.stdout.write(
            `Resume with: ${buildResumeCommand({
              sessionId: finalSessionId.trim(),
              workspaceRoot: this.stepCliConfig.workspaceRoot,
            })}\n`,
          );
        }
      }
      await removeLocalTuiBootstrapConfig(this.bootstrapDirPath);
      this.bootstrapDirPath = null;
    }
  }

  async close(): Promise<void> {
    await removeLocalTuiBootstrapConfig(this.bootstrapDirPath);
    this.bootstrapDirPath = null;
  }
}

/** @public — dynamically imported by root-command and resume-command */
export async function createLocalTuiClientApp(
  stepCliConfig: StepCliConfig,
  voice?: VoiceBootstrapConfig,
): Promise<LocalStepCliTuiApp> {
  const { sessionId } = await resolveLocalSessionTarget(stepCliConfig);
  return new LocalStepCliTuiApp(
    {
      ...stepCliConfig,
      sessionId,
    },
    voice,
  );
}

export async function runLocalOpenTuiWithBootstrap(input: {
  bootstrapFilePath: string;
  runner?: () => Promise<void>;
}): Promise<void> {
  const previousBootstrapFilePath = process.env[STEP_CLI_TUI_BOOTSTRAP_ENV];
  process.env[STEP_CLI_TUI_BOOTSTRAP_ENV] = input.bootstrapFilePath;

  try {
    await (input.runner ?? runLocalOpenTui)();
  } finally {
    if (previousBootstrapFilePath === undefined) {
      delete process.env[STEP_CLI_TUI_BOOTSTRAP_ENV];
    } else {
      process.env[STEP_CLI_TUI_BOOTSTRAP_ENV] = previousBootstrapFilePath;
    }
  }
}

async function runLocalOpenTui(): Promise<void> {
  const runtimeModule = (await import("./local-opentui-entry.js")) as {
    runLocalOpenTui?: () => Promise<void>;
  };
  if (typeof runtimeModule.runLocalOpenTui !== "function") {
    throw new Error("OpenTUI entrypoint did not export runLocalOpenTui()");
  }
  await runtimeModule.runLocalOpenTui();
}
