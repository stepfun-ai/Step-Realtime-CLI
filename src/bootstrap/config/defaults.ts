import type { OpenAIReasoningEffort } from "@step-cli/protocol";
import type { StorageLayoutConfig } from "./types.js";
import { UNLIMITED_MAX_STEPS } from "./max-steps.js";

export const DEFAULT_MODEL = "step/native";
export const DEFAULT_BASE_URL = "https://api.stepfun.com/v1";
export const DEFAULT_MODELS_PROXY_BASE_URL = "https://api.stepfun.com/v1";
export const DEFAULT_CONFIG_TEMPLATE_PROVIDER = "openai";
export const DEFAULT_CONFIG_TEMPLATE_MODEL = "step-3.7-flash";
export const DEFAULT_CONFIG_TEMPLATE_MODELS_PROXY_API = "";
// Keep the user-facing default in "~" form; runtime resolution expands it to HOME.
export const DEFAULT_STORAGE_ROOT_DIR = "~/.step-cli";
export const DEFAULT_SESSION_FILE = "session";
export const MIN_ANTHROPIC_THINKING_BUDGET_TOKENS = 1_024;
export const DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS = 16_000;
export const DEFAULT_OPENAI_REASONING_EFFORT: OpenAIReasoningEffort = "high";
export const STEPCLI_CONFIG_ENV_NAMES = [
  "STEPCLI_CONFIG_PATH",
  "STEP_CLI_CONFIG_PATH",
] as const;
export const STEP_MODEL_ENV_NAMES = ["STEP_MODEL"] as const;
export const STEP_MODEL_PROVIDER_ENV_NAMES = ["STEP_MODEL_PROVIDER"] as const;
export const STEP_BASE_URL_ENV_NAMES = ["STEP_BASE_URL"] as const;
export const STEP_API_KEY_ENV_NAMES = ["STEP_API_KEY"] as const;
export const STEPCLI_SERVICE_HOST_ENV_NAMES = [
  "STEPCLI_SERVICE_HOST",
  "STEP_CLI_SERVICE_HOST",
] as const;
export const STEPCLI_SERVICE_PORT_ENV_NAMES = [
  "STEPCLI_SERVICE_PORT",
  "STEP_CLI_SERVICE_PORT",
] as const;
export const STEPCLI_SERVICE_TOKEN_ENV_NAMES = [
  "STEPCLI_SERVICE_TOKEN",
  "STEP_CLI_SERVICE_TOKEN",
] as const;
export const STEPCLI_SERVICE_STORAGE_ROOT_DIR_ENV_NAMES = [
  "STEPCLI_SERVICE_STORAGE_ROOT_DIR",
  "STEP_CLI_SERVICE_STORAGE_ROOT_DIR",
] as const;

export const BUILTIN_STORAGE_LAYOUT_DEFAULTS: Required<StorageLayoutConfig> = {
  workspaceTrustFile: "workspace-trust.json",
  teamInboxDir: "team/inbox",
  themesDir: "themes",
  sessionAssetsDir: "assets",
  sessionProgressDir: "progress",
  sessionProgressFile: "progress.md",
  sessionArtifactsDir: "artifacts",
  sessionTranscriptsDir: "transcripts",
  sessionTeamInboxDir: "team/inbox",
  sessionTraceDir: "trace",
} as const;

export const BUILTIN_CLI_DEFAULTS: {
  readonly mode: "normal";
  readonly systemPromptProfile: "default";
  readonly codeMode: true;
  readonly toolPresentationProfile: "grouped";
  readonly toolDescriptionStyle: "canonical";
  readonly toolSearchIndexProfile: "presented";
  readonly maxSteps: number;
  readonly maxToolCallsPerStep: number;
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  readonly minOutputTokens: number;
  readonly outputTokenSafetyMargin: number;
  readonly parallelToolCalls: boolean;
  readonly temperature: number;
  readonly timeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly commandOutputLimit: number;
  readonly repeatedToolCallLimit: number;
  readonly modelRequestRetries: number;
  readonly toolExecutionRetries: number;
  readonly maxToolResultContextChars: number;
  readonly openaiReasoningEffort: OpenAIReasoningEffort;
  readonly maxUserClarificationsPerTurn: number;
  readonly approvalMode: "confirm";
  readonly nonInteractiveApproval: "deny";
  readonly skillsDir: string;
  readonly storage: {
    readonly rootDir: string;
    readonly layout: Required<StorageLayoutConfig>;
  };
  readonly sessionFile: string;
  readonly sessionAutosave: boolean;
  readonly sessionTraceEnabled: boolean;
  readonly sessionTraceKeepLast: number;
  readonly sessionTraceMaxBodyBytes: number;
  readonly sessionTraceHeaderInjectionBaseUrls: readonly string[];
} = {
  mode: "normal" as const,
  systemPromptProfile: "default" as const,
  codeMode: true,
  toolPresentationProfile: "grouped" as const,
  toolDescriptionStyle: "canonical" as const,
  toolSearchIndexProfile: "presented" as const,
  maxSteps: UNLIMITED_MAX_STEPS,
  maxToolCallsPerStep: 24,
  maxContextTokens: 160_000,
  maxOutputTokens: 48_000,
  minOutputTokens: 512,
  outputTokenSafetyMargin: 1_024,
  parallelToolCalls: true,
  temperature: 0.2,
  timeoutMs: 120_000,
  commandTimeoutMs: 30_000,
  commandOutputLimit: 40_000,
  repeatedToolCallLimit: 2,
  modelRequestRetries: 2,
  toolExecutionRetries: 1,
  maxToolResultContextChars: 10_000,
  openaiReasoningEffort: DEFAULT_OPENAI_REASONING_EFFORT,
  maxUserClarificationsPerTurn: 3,
  approvalMode: "confirm" as const,
  nonInteractiveApproval: "deny" as const,
  skillsDir: "skills",
  storage: {
    rootDir: DEFAULT_STORAGE_ROOT_DIR,
    layout: BUILTIN_STORAGE_LAYOUT_DEFAULTS,
  },
  sessionFile: DEFAULT_SESSION_FILE,
  sessionAutosave: true,
  sessionTraceEnabled: true,
  sessionTraceKeepLast: 200,
  sessionTraceMaxBodyBytes: 1 << 20,
  sessionTraceHeaderInjectionBaseUrls: [],
} as const;

export const BUILTIN_SERVICE_DEFAULTS: {
  readonly host: string;
  readonly port: number;
} = {
  host: "127.0.0.1",
  port: 47123,
} as const;
