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
import {
  isOpenTuiRuntimeSupported,
  loadOpenTuiClientAppFactoryAtRuntime,
} from "../runtime/open-tui-capability.js";
import type { VoiceBootstrapConfig } from "../runtime/voice-bootstrap-config.js";
import {
  loadVoiceConfigFile,
  resolveDefaultVoiceConfigPath,
  type VoiceConfigFile,
} from "../runtime/voice-config-loader.js";

interface VoiceCliOptions extends SharedRuntimeCliOptions {
  voice?: string;
  inputMode?: string;
  speedRatio?: number;
  vad?: string;
  aec?: boolean;
  codingModel?: string;
  codingMaxTurns?: number;
  codingBudgetUsd?: number;
  codingPermissionMode?: string;
  voiceConfig?: string;
}

const STEPFUN_API_KEY_ENV_NAMES = [
  "STEPFUN_API_KEY",
  "STEPFUN_REALTIME_API_KEY",
];
const STEPFUN_ENDPOINT_ENV_NAMES = [
  "STEPFUN_REALTIME_ENDPOINT",
  "STEPFUN_BASE_URL",
];

export async function runVoiceCommand(argv: string[]): Promise<void> {
  const voiceProgram = configureCommanderProgram(new Command());

  configureSharedRuntimeOptions(
    voiceProgram
      .name("step voice")
      .description(
        `Start a realtime voice session for coding tasks. Voice options are
resolved in this order: CLI flag > env var > \`voice\` section in the
step-cli config file (${resolveDefaultVoiceConfigPath()}) > built-in
default.`,
      )
      .showHelpAfterError(),
    {
      includeSessionFile: false,
      includeResume: false,
      includeAltScreen: true,
      includeJson: false,
    },
  )
    .option(
      "--voice-config <path>",
      `Path to the step-cli config file whose \`voice\` section drives this command (default: ${resolveDefaultVoiceConfigPath()})`,
    )
    .option(
      "--voice <voice>",
      "Voice ID (defaults to the backend's default voice)",
    )
    .option("--input-mode <mode>", "Input mode (ptt | duplex)")
    .option("--speed-ratio <ratio>", "Speech speed ratio", parseFloat)
    .option("--vad <name>", "VAD adapter for duplex (energy | silero)")
    .option("--aec", "Enable browser-helper acoustic echo cancellation")
    .option("--no-aec", "Disable browser-helper AEC")
    .option(
      "--coding-model <model>",
      "Model for coding tasks (defaults to step-cli config model)",
    )
    .option("--coding-max-turns <n>", "Max coding turns", parseInt)
    .option("--coding-budget-usd <n>", "Coding budget in USD", parseFloat)
    .option(
      "--coding-permission-mode <mode>",
      "Permission mode for coding tools (default | acceptEdits | bypassPermissions | plan)",
    )
    .action(async (options: VoiceCliOptions, actionCommand: Command) => {
      const cliOptionSources = readSharedRuntimeCliOptionSources(actionCommand);
      const { stepCliConfig } = await resolveStepCliRuntimeConfig({
        options,
        cliOptionSources,
        resumeSession: false,
        useAlternateScreen: options.altScreen,
        interactionSurface: "interactive",
      });

      if (!stepCliConfig.apiKey) {
        process.stderr.write(
          "step voice: No API key found. Run `step config init` and fill apiKey in ~/.step-cli/config.json.\n",
        );
        process.exit(1);
      }

      const voiceConfigPath =
        options.voiceConfig ?? resolveDefaultVoiceConfigPath();
      let voiceConfigFile: VoiceConfigFile | undefined;
      try {
        voiceConfigFile = await loadVoiceConfigFile(voiceConfigPath);
      } catch (err) {
        process.stderr.write(
          `step voice: failed to read \`voice\` section from ${voiceConfigPath}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
        process.exit(1);
      }

      const realtimeApiKey =
        readFirstEnv(STEPFUN_API_KEY_ENV_NAMES) ??
        voiceConfigFile?.realtime?.apiKey;
      if (!realtimeApiKey) {
        process.stderr.write(
          [
            "step voice: realtime backend credentials are missing.",
            "Configure one of:",
            `  - env var ${STEPFUN_API_KEY_ENV_NAMES.join(" or ")}, or`,
            `  - \`voice.realtime.apiKey\` in ${voiceConfigPath}`,
            "",
            `Optionally override the backend endpoint with ${STEPFUN_ENDPOINT_ENV_NAMES[0]} or \`voice.realtime.endpoint\` in the same config file.`,
            "",
          ].join("\n"),
        );
        process.exit(1);
      }
      const realtimeEndpoint =
        readFirstEnv(STEPFUN_ENDPOINT_ENV_NAMES) ??
        voiceConfigFile?.realtime?.endpoint;
      const realtimeModelRaw = voiceConfigFile?.realtime?.model;
      const realtimeModel =
        realtimeModelRaw && realtimeModelRaw.trim().length > 0
          ? realtimeModelRaw.trim()
          : undefined;

      // --aec / --no-aec: commander defaults `aec` to true because of the
      // negatable flag, so distinguish an explicit flag from the default via
      // the option source. Env (STEP_VOICE_AEC) override is applied later at
      // the consumption point (build-voice-runtime), shared with the /voice path.
      const aecSource = actionCommand.getOptionValueSource("aec");
      const aecFromCli = aecSource === "cli" ? options.aec : undefined;
      const resolvedAec = aecFromCli ?? voiceConfigFile?.defaults?.aec;
      const resolvedVad = options.vad ?? voiceConfigFile?.defaults?.vad;

      const voice: VoiceBootstrapConfig = {
        backend: "stepfun_stateless",
        inputMode: normalizeInputMode(
          options.inputMode ?? voiceConfigFile?.defaults?.inputMode,
        ),
        ...resolveOptionalString(
          "voice",
          options.voice ?? voiceConfigFile?.defaults?.voice,
        ),
        ...resolveOptionalNumber(
          "speedRatio",
          options.speedRatio ?? voiceConfigFile?.defaults?.speedRatio,
        ),
        ...(resolvedVad != null && resolvedVad.trim().length > 0
          ? { vad: resolvedVad }
          : undefined),
        ...(resolvedAec != null ? { aec: resolvedAec } : undefined),
        coding: {
          model:
            options.codingModel ??
            voiceConfigFile?.coding?.model ??
            stepCliConfig.model,
          maxTurns:
            options.codingMaxTurns ?? voiceConfigFile?.coding?.maxTurns ?? 30,
          budgetUsd:
            options.codingBudgetUsd ?? voiceConfigFile?.coding?.budgetUsd ?? 5,
          permissionMode: normalizePermissionMode(
            options.codingPermissionMode ??
              voiceConfigFile?.coding?.permissionMode,
          ),
        },
        realtime: {
          apiKey: realtimeApiKey,
          ...(realtimeEndpoint ? { endpoint: realtimeEndpoint } : undefined),
          ...(realtimeModel ? { model: realtimeModel } : undefined),
        },
      };

      const voiceRuntimeError = getVoiceRuntimeError();
      if (voiceRuntimeError !== null) {
        throw new Error(voiceRuntimeError);
      }

      const createLocalTuiClientApp =
        await loadOpenTuiClientAppFactoryAtRuntime();
      const app = await createLocalTuiClientApp(stepCliConfig, voice);
      try {
        await app.run();
      } finally {
        await app.close();
      }
    });

  await parseCommanderProgram(voiceProgram, ["node", "step voice", ...argv]);
}

/**
 * Returns null when voice mode may proceed, or an error message string when
 * the runtime cannot support OpenTUI. Pure function for unit testing.
 */
export function getVoiceRuntimeError(): string | null {
  if (isOpenTuiRuntimeSupported()) {
    return null;
  }
  const installHint =
    process.platform === "win32"
      ? "Install Bun via `winget install Oven-sh.Bun`"
      : "Install Bun from https://bun.sh";
  return `step voice requires Bun runtime on this platform. ${installHint}, or set STEP_BUN_BIN, then re-run.`;
}

function normalizeInputMode(
  value: string | undefined,
): VoiceBootstrapConfig["inputMode"] {
  return value === "ptt" ? "ptt" : "duplex";
}

function normalizePermissionMode(
  value: string | undefined,
): VoiceBootstrapConfig["coding"]["permissionMode"] {
  switch (value) {
    case "acceptEdits":
    case "bypassPermissions":
    case "plan":
    case "default":
      return value;
    default:
      // Unset/invalid → full pass-through (voice coding runs autonomously).
      return "bypassPermissions";
  }
}

function readFirstEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function resolveOptionalString(
  key: "voice",
  value: string | undefined,
): Partial<Pick<VoiceBootstrapConfig, "voice">> {
  return value != null && value.trim().length > 0 ? { [key]: value } : {};
}

function resolveOptionalNumber(
  key: "speedRatio",
  value: number | undefined,
): Partial<Pick<VoiceBootstrapConfig, "speedRatio">> {
  return value != null && Number.isFinite(value) ? { [key]: value } : {};
}
