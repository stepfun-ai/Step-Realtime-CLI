import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StepCliConfig } from "../gateway/runtime.js";
import type {
  VoiceInputMode,
  VoiceBootstrapConfig,
} from "./voice-bootstrap-config.js";

export const STEP_CLI_TUI_BOOTSTRAP_ENV = "STEP_CLI_TUI_BOOTSTRAP_PATH";
const LOCAL_TUI_EXIT_STATE_BASENAME = "exit-state.json";

export interface LocalTuiExitState {
  sessionId: string;
}

/** Bootstrap payload written to disk and re-read by the OpenTUI subprocess.
 *  Voice options live in their own field so StepCliConfig stays voice-free
 *  (see docs/realtime-voice-integration.md §2.2 / §2.3). */
interface LocalTuiBootstrapPayload {
  stepCliConfig: StepCliConfig;
  voice?: VoiceBootstrapConfig;
}

export interface LocalTuiBootstrapResult {
  stepCliConfig: StepCliConfig;
  voice?: VoiceBootstrapConfig;
}

export async function writeLocalTuiBootstrapConfig(
  stepCliConfig: StepCliConfig,
  voice?: VoiceBootstrapConfig,
): Promise<{
  bootstrapDirPath: string;
  bootstrapFilePath: string;
}> {
  const bootstrapDirPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "step-cli-opentui-"),
  );
  const bootstrapFilePath = path.join(bootstrapDirPath, "bootstrap.json");
  const payload: LocalTuiBootstrapPayload = {
    stepCliConfig: serializeStepCliConfig(stepCliConfig),
    ...(voice ? { voice } : undefined),
  };
  await fs.writeFile(
    bootstrapFilePath,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );

  return {
    bootstrapDirPath,
    bootstrapFilePath,
  };
}

export async function loadLocalTuiBootstrapConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalTuiBootstrapResult> {
  const bootstrapFilePath = env[STEP_CLI_TUI_BOOTSTRAP_ENV];
  if (!bootstrapFilePath) {
    throw new Error(
      `${STEP_CLI_TUI_BOOTSTRAP_ENV} is required to start the OpenTUI runtime`,
    );
  }

  const rawConfig = await fs.readFile(bootstrapFilePath, "utf8");
  const parsed = JSON.parse(rawConfig) as Partial<LocalTuiBootstrapPayload> &
    Partial<StepCliConfig>;

  // Backward-compat: prior layouts wrote StepCliConfig directly at the root.
  // Detect by presence of the new `stepCliConfig` envelope.
  if (parsed.stepCliConfig) {
    return {
      stepCliConfig: parsed.stepCliConfig as StepCliConfig,
      ...(parsed.voice ? { voice: parsed.voice } : undefined),
    };
  }
  return { stepCliConfig: parsed as unknown as StepCliConfig };
}

export async function removeLocalTuiBootstrapConfig(
  bootstrapDirPath: string | null,
): Promise<void> {
  if (!bootstrapDirPath) {
    return;
  }

  await fs.rm(bootstrapDirPath, {
    recursive: true,
    force: true,
  });
}

export function resolveLocalTuiExitStatePath(
  bootstrapFilePath: string,
): string {
  return path.join(
    path.dirname(bootstrapFilePath),
    LOCAL_TUI_EXIT_STATE_BASENAME,
  );
}

export async function writeLocalTuiExitState(
  bootstrapFilePath: string,
  state: LocalTuiExitState,
): Promise<void> {
  await fs.writeFile(
    resolveLocalTuiExitStatePath(bootstrapFilePath),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}

export async function readLocalTuiExitState(
  bootstrapDirPath: string | null,
): Promise<LocalTuiExitState | undefined> {
  if (!bootstrapDirPath) {
    return undefined;
  }

  try {
    const raw = await fs.readFile(
      path.join(bootstrapDirPath, LOCAL_TUI_EXIT_STATE_BASENAME),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { sessionId?: unknown };
    return typeof parsed.sessionId === "string" &&
      parsed.sessionId.trim().length > 0
      ? { sessionId: parsed.sessionId.trim() }
      : undefined;
  } catch {
    return undefined;
  }
}

function serializeStepCliConfig(stepCliConfig: StepCliConfig): StepCliConfig {
  const { interactiveUiFactory: _interactiveUiFactory, ...serializableConfig } =
    stepCliConfig;
  return serializableConfig;
}

export type { VoiceBootstrapConfig, VoiceInputMode };
