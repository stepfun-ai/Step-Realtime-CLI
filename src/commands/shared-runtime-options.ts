import { Command } from "commander";
import type { OptionValueSource } from "commander";
import { BUILTIN_CLI_DEFAULTS } from "../bootstrap/config/defaults.js";
import {
  formatMaxSteps,
  parseMaxSteps,
} from "../bootstrap/config/max-steps.js";
import type {
  AgentOperatingMode,
  SystemPromptProfile,
  ToolDescriptionStyle,
  ToolPermissionMode,
  ToolPresentationProfile,
  ToolSearchIndexProfile,
} from "@step-cli/protocol";
import {
  collectRepeatedString,
  collectToolOverride,
  parseAnthropicThinkingBudgetTokens,
  parseApprovalMode,
  parseNonInteractiveApproval,
  parseNonNegativeInt,
  parseNumber,
  parseOpenAIReasoningEffort,
  parseOperatingMode,
  parsePositiveInt,
  parseSystemPromptProfile,
  parseToolDescriptionStyle,
  parseToolPresentationProfile,
  parseToolSearchIndexProfile,
} from "./option-parsers.js";

export interface SharedRuntimeCliOptions {
  mode?: AgentOperatingMode;
  config?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  provider?: string;
  anthropicThinkingBudgetTokens?: number;
  openaiReasoningEffort?: "minimal" | "low" | "medium" | "high";
  maxUserClarificationsPerTurn?: number;
  systemPromptFile?: string;
  systemPromptProfile?: SystemPromptProfile;
  codeMode?: boolean;
  toolPresentationProfile?: ToolPresentationProfile;
  toolAliasSeed?: string;
  toolDescriptionStyle?: ToolDescriptionStyle;
  toolSearchIndexProfile?: ToolSearchIndexProfile;
  image?: string[];
  workspace?: string;
  maxSteps?: number;
  maxToolCallsPerStep?: number;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  minOutputTokens?: number;
  outputTokenSafetyMargin?: number;
  parallelToolCalls?: boolean;
  temperature?: number;
  timeoutMs?: number;
  commandTimeoutMs?: number;
  commandOutputLimit?: number;
  repeatedToolCallLimit?: number;
  modelRequestRetries?: number;
  toolExecutionRetries?: number;
  maxToolResultContextChars?: number;
  approvalMode?: "confirm" | "auto" | "strict";
  nonInteractiveApproval?: "allow" | "deny";
  toolOverride?: Record<string, ToolPermissionMode>;
  pluginsDir?: string;
  skillsDir?: string;
  storageRootDir?: string;
  sessionFile?: string;
  resume?: boolean;
  sessionAutosave?: boolean;
  altScreen?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export interface ServiceCliOptions extends SharedRuntimeCliOptions {
  host?: string;
  port?: number;
  token?: string;
}

type SharedRuntimeOptionKey =
  | "mode"
  | "systemPromptProfile"
  | "codeMode"
  | "toolPresentationProfile"
  | "toolAliasSeed"
  | "toolDescriptionStyle"
  | "toolSearchIndexProfile"
  | "maxSteps"
  | "anthropicThinkingBudgetTokens"
  | "openaiReasoningEffort"
  | "maxUserClarificationsPerTurn"
  | "maxToolCallsPerStep"
  | "maxContextTokens"
  | "maxOutputTokens"
  | "minOutputTokens"
  | "outputTokenSafetyMargin"
  | "parallelToolCalls"
  | "temperature"
  | "timeoutMs"
  | "commandTimeoutMs"
  | "commandOutputLimit"
  | "repeatedToolCallLimit"
  | "modelRequestRetries"
  | "toolExecutionRetries"
  | "maxToolResultContextChars"
  | "approvalMode"
  | "nonInteractiveApproval"
  | "pluginsDir"
  | "skillsDir"
  | "storageRootDir"
  | "sessionFile"
  | "sessionAutosave";

type ServiceRuntimeOptionKey = "host" | "port" | "token";

type SharedRuntimeOptionFallbacks = Partial<
  Record<SharedRuntimeOptionKey, unknown>
>;

interface SharedRuntimeOptionDefinition {
  key: SharedRuntimeOptionKey;
  optional?: boolean;
  fallback?: SharedRuntimeOptionFallbacks[SharedRuntimeOptionKey];
  register(program: Command): void;
}

interface ServiceRuntimeOptionDefinition {
  key: ServiceRuntimeOptionKey;
}

const SHARED_RUNTIME_OPTION_DEFINITIONS = [
  {
    key: "mode",
    fallback: BUILTIN_CLI_DEFAULTS.mode,
    register(program) {
      program.option(
        "--mode <mode>",
        "Operating mode: normal|plan",
        parseOperatingMode,
        BUILTIN_CLI_DEFAULTS.mode,
      );
    },
  },
  {
    key: "systemPromptProfile",
    fallback: BUILTIN_CLI_DEFAULTS.systemPromptProfile,
    register(program) {
      program.option(
        "--system-prompt-profile <profile>",
        "System prompt profile: default|minimal",
        parseSystemPromptProfile,
        BUILTIN_CLI_DEFAULTS.systemPromptProfile,
      );
    },
  },
  {
    key: "codeMode",
    fallback: BUILTIN_CLI_DEFAULTS.codeMode,
    register(program) {
      program
        .option(
          "--code-mode",
          "Enable Code Mode tool bundling",
          BUILTIN_CLI_DEFAULTS.codeMode,
        )
        .option(
          "--no-code-mode",
          "Disable Code Mode and expose the standard tool surface",
        );
    },
  },
  {
    key: "toolPresentationProfile",
    fallback: BUILTIN_CLI_DEFAULTS.toolPresentationProfile,
    register(program) {
      program.option(
        "--tool-presentation-profile <profile>",
        "Tool presentation profile: grouped|raw|obfuscated (legacy aliases: compact|canonical)",
        parseToolPresentationProfile,
        BUILTIN_CLI_DEFAULTS.toolPresentationProfile,
      );
    },
  },
  {
    key: "toolAliasSeed",
    optional: true,
    register(program) {
      program.option(
        "--tool-alias-seed <seed>",
        "Seed used to derive stable obfuscated tool aliases",
      );
    },
  },
  {
    key: "toolDescriptionStyle",
    fallback: BUILTIN_CLI_DEFAULTS.toolDescriptionStyle,
    register(program) {
      program.option(
        "--tool-description-style <style>",
        "Tool description style: canonical|simple",
        parseToolDescriptionStyle,
        BUILTIN_CLI_DEFAULTS.toolDescriptionStyle,
      );
    },
  },
  {
    key: "toolSearchIndexProfile",
    fallback: BUILTIN_CLI_DEFAULTS.toolSearchIndexProfile,
    register(program) {
      program.option(
        "--tool-search-index-profile <profile>",
        "Tool search index profile: presented|canonical",
        parseToolSearchIndexProfile,
        BUILTIN_CLI_DEFAULTS.toolSearchIndexProfile,
      );
    },
  },
  {
    key: "maxSteps",
    fallback: BUILTIN_CLI_DEFAULTS.maxSteps,
    register(program) {
      program.option(
        "--max-steps <n>",
        `Max tool-iteration steps or 'unlimited' (default: ${formatMaxSteps(BUILTIN_CLI_DEFAULTS.maxSteps)})`,
        parseMaxSteps,
      );
    },
  },
  {
    key: "anthropicThinkingBudgetTokens",
    optional: true,
    register(program) {
      program.option(
        "--anthropic-thinking-budget-tokens <n>",
        "Anthropic tool-turn thinking budget tokens (>= 1024; default: 16000 when provider=anthropic)",
        parseAnthropicThinkingBudgetTokens,
      );
    },
  },
  {
    key: "openaiReasoningEffort",
    fallback: BUILTIN_CLI_DEFAULTS.openaiReasoningEffort,
    register(program) {
      program.option(
        "--openai-reasoning-effort <effort>",
        "OpenAI tool-turn reasoning effort: minimal|low|medium|high",
        parseOpenAIReasoningEffort,
        BUILTIN_CLI_DEFAULTS.openaiReasoningEffort,
      );
    },
  },
  {
    key: "maxUserClarificationsPerTurn",
    fallback: BUILTIN_CLI_DEFAULTS.maxUserClarificationsPerTurn,
    register(program) {
      program.option(
        "--max-user-clarifications-per-turn <n>",
        "Max clarify_user requests allowed in one turn (0 disables the tool budget entirely for that turn)",
        parseNonNegativeInt,
        BUILTIN_CLI_DEFAULTS.maxUserClarificationsPerTurn,
      );
    },
  },
  {
    key: "maxToolCallsPerStep",
    fallback: BUILTIN_CLI_DEFAULTS.maxToolCallsPerStep,
    register(program) {
      program.option(
        "--max-tool-calls-per-step <n>",
        "Max tool calls in a single step",
        parsePositiveInt,
        BUILTIN_CLI_DEFAULTS.maxToolCallsPerStep,
      );
    },
  },
  {
    key: "maxContextTokens",
    fallback: BUILTIN_CLI_DEFAULTS.maxContextTokens,
    register(program) {
      program.option(
        "--max-context-tokens <n>",
        "Context token budget",
        parsePositiveInt,
        BUILTIN_CLI_DEFAULTS.maxContextTokens,
      );
    },
  },
  {
    key: "maxOutputTokens",
    fallback: BUILTIN_CLI_DEFAULTS.maxOutputTokens,
    register(program) {
      program.option(
        "--max-output-tokens <n>",
        "Max model output tokens",
        parsePositiveInt,
        BUILTIN_CLI_DEFAULTS.maxOutputTokens,
      );
    },
  },
  {
    key: "minOutputTokens",
    fallback: BUILTIN_CLI_DEFAULTS.minOutputTokens,
    register(program) {
      program.option(
        "--min-output-tokens <n>",
        "Min model output tokens per step",
        parsePositiveInt,
        BUILTIN_CLI_DEFAULTS.minOutputTokens,
      );
    },
  },
  {
    key: "outputTokenSafetyMargin",
    fallback: BUILTIN_CLI_DEFAULTS.outputTokenSafetyMargin,
    register(program) {
      program.option(
        "--output-token-safety-margin <n>",
        "Reserved token margin for estimator error",
        parsePositiveInt,
        BUILTIN_CLI_DEFAULTS.outputTokenSafetyMargin,
      );
    },
  },
  {
    key: "parallelToolCalls",
    fallback: BUILTIN_CLI_DEFAULTS.parallelToolCalls,
    register(program) {
      program
        .option(
          "--parallel-tool-calls",
          "Enable model-native parallel tool calls",
          BUILTIN_CLI_DEFAULTS.parallelToolCalls,
        )
        .option(
          "--no-parallel-tool-calls",
          "Disable model-native parallel tool calls",
        );
    },
  },
  {
    key: "temperature",
    fallback: BUILTIN_CLI_DEFAULTS.temperature,
    register(program) {
      program.option(
        "--temperature <n>",
        "Sampling temperature",
        parseNumber,
        BUILTIN_CLI_DEFAULTS.temperature,
      );
    },
  },
  {
    key: "timeoutMs",
    fallback: BUILTIN_CLI_DEFAULTS.timeoutMs,
    register(program) {
      program.option(
        "--timeout-ms <n>",
        "Model request timeout",
        parsePositiveInt,
        BUILTIN_CLI_DEFAULTS.timeoutMs,
      );
    },
  },
  {
    key: "commandTimeoutMs",
    fallback: BUILTIN_CLI_DEFAULTS.commandTimeoutMs,
    register(program) {
      program.option(
        "--command-timeout-ms <n>",
        "Shell command timeout",
        parsePositiveInt,
        BUILTIN_CLI_DEFAULTS.commandTimeoutMs,
      );
    },
  },
  {
    key: "commandOutputLimit",
    fallback: BUILTIN_CLI_DEFAULTS.commandOutputLimit,
    register(program) {
      program.option(
        "--command-output-limit <n>",
        "Shell output char limit",
        parsePositiveInt,
        BUILTIN_CLI_DEFAULTS.commandOutputLimit,
      );
    },
  },
  {
    key: "repeatedToolCallLimit",
    fallback: BUILTIN_CLI_DEFAULTS.repeatedToolCallLimit,
    register(program) {
      program.option(
        "--repeated-tool-call-limit <n>",
        "Max allowed identical tool call repeats",
        parsePositiveInt,
        BUILTIN_CLI_DEFAULTS.repeatedToolCallLimit,
      );
    },
  },
  {
    key: "modelRequestRetries",
    fallback: BUILTIN_CLI_DEFAULTS.modelRequestRetries,
    register(program) {
      program.option(
        "--model-request-retries <n>",
        "Retry count for model API call failures",
        parseNonNegativeInt,
        BUILTIN_CLI_DEFAULTS.modelRequestRetries,
      );
    },
  },
  {
    key: "toolExecutionRetries",
    fallback: BUILTIN_CLI_DEFAULTS.toolExecutionRetries,
    register(program) {
      program.option(
        "--tool-execution-retries <n>",
        "Retry count for transient tool failures",
        parseNonNegativeInt,
        BUILTIN_CLI_DEFAULTS.toolExecutionRetries,
      );
    },
  },
  {
    key: "maxToolResultContextChars",
    fallback: BUILTIN_CLI_DEFAULTS.maxToolResultContextChars,
    register(program) {
      program.option(
        "--max-tool-result-context-chars <n>",
        "Max chars for each tool result injected back into model context",
        parsePositiveInt,
        BUILTIN_CLI_DEFAULTS.maxToolResultContextChars,
      );
    },
  },
  {
    key: "approvalMode",
    fallback: BUILTIN_CLI_DEFAULTS.approvalMode,
    register(program) {
      program.option(
        "--approval-mode <mode>",
        "Tool approval mode: confirm|auto|strict",
        parseApprovalMode,
        BUILTIN_CLI_DEFAULTS.approvalMode,
      );
    },
  },
  {
    key: "nonInteractiveApproval",
    fallback: BUILTIN_CLI_DEFAULTS.nonInteractiveApproval,
    register(program) {
      program.option(
        "--non-interactive-approval <mode>",
        "Behavior when approval is required but interactive approval is unavailable: allow|deny",
        parseNonInteractiveApproval,
        BUILTIN_CLI_DEFAULTS.nonInteractiveApproval,
      );
    },
  },
  {
    key: "pluginsDir",
    optional: true,
    register(program) {
      program.option(
        "--plugins-dir <path>",
        "External plugins directory (contains */step.plugin.json)",
      );
    },
  },
  {
    key: "skillsDir",
    fallback: BUILTIN_CLI_DEFAULTS.skillsDir,
    register(program) {
      program.option(
        "--skills-dir <name>",
        "Skills directory name under workspace",
        BUILTIN_CLI_DEFAULTS.skillsDir,
      );
    },
  },
  {
    key: "storageRootDir",
    fallback: BUILTIN_CLI_DEFAULTS.storage.rootDir,
    register(program) {
      program.option(
        "--storage-root-dir <path>",
        `Storage root directory; relative paths resolve from workspace, "~" resolves from HOME (default: ${BUILTIN_CLI_DEFAULTS.storage.rootDir})`,
      );
    },
  },
  {
    key: "sessionFile",
    fallback: BUILTIN_CLI_DEFAULTS.sessionFile,
    register(program) {
      program.option(
        "--session-file <path>",
        `Local session selector; non-default values use basename as session id, default selector creates a new local session id for each run (default: ${BUILTIN_CLI_DEFAULTS.sessionFile})`,
      );
    },
  },
  {
    key: "sessionAutosave",
    fallback: BUILTIN_CLI_DEFAULTS.sessionAutosave,
    register(program) {
      program
        .option(
          "--session-autosave",
          "Autosave session after each turn",
          BUILTIN_CLI_DEFAULTS.sessionAutosave,
        )
        .option(
          "--no-session-autosave",
          "Disable autosave session after each turn",
        );
    },
  },
] as const satisfies readonly SharedRuntimeOptionDefinition[];

const SERVICE_RUNTIME_OPTION_DEFINITIONS = [
  { key: "host" },
  { key: "port" },
  { key: "token" },
] as const satisfies readonly ServiceRuntimeOptionDefinition[];

const SHARED_RUNTIME_SOURCE_KEYS = [
  ...SHARED_RUNTIME_OPTION_DEFINITIONS.map((definition) => definition.key),
  "provider",
  "model",
  "baseUrl",
  "apiKey",
] as const;

type SharedRuntimeSourceKey = (typeof SHARED_RUNTIME_SOURCE_KEYS)[number];

export type SharedRuntimeCliOptionSources = Partial<
  Record<SharedRuntimeSourceKey, OptionValueSource | undefined>
>;

export type ServiceRuntimeCliOptionSources = Partial<
  Record<ServiceRuntimeOptionKey, OptionValueSource | undefined>
>;

export function getSharedRuntimeOptionDefinition(
  key: SharedRuntimeOptionKey,
): SharedRuntimeOptionDefinition {
  return SHARED_RUNTIME_OPTION_DEFINITIONS.find(
    (definition) => definition.key === key,
  )!;
}

export function readSharedRuntimeCliOptionSources(
  command: Command,
): SharedRuntimeCliOptionSources {
  return readCommandOptionSources(command, SHARED_RUNTIME_SOURCE_KEYS);
}

export function readServiceRuntimeCliOptionSources(
  command: Command,
): ServiceRuntimeCliOptionSources {
  return readCommandOptionSources(
    command,
    SERVICE_RUNTIME_OPTION_DEFINITIONS.map((definition) => definition.key),
  );
}

export function isCliOptionExplicit(
  sources:
    | SharedRuntimeCliOptionSources
    | ServiceRuntimeCliOptionSources
    | undefined,
  key: string,
): boolean {
  return sources?.[key as keyof typeof sources] === "cli";
}

export function configureSharedRuntimeOptions(
  program: Command,
  options: {
    includeSessionFile: boolean;
    includeResume: boolean;
    includeAltScreen: boolean;
    includeJson: boolean;
  },
): Command {
  program
    .option(
      "--config <path>",
      "Path to step-cli config file (replaces default user/workspace lookup)",
    )
    .option("-m, --model <model>", "Model id")
    .option("--base-url <url>", "Model API base URL")
    .option("--api-key <key>", "API key")
    .option(
      "--provider <provider>",
      "Model provider: openai|response|anthropic",
    )
    .option("--system-prompt-file <path>", "Load system prompt from file")
    .option(
      "--image <path-or-url>",
      "Attach an image from a local file path or URL; can be repeated",
      collectRepeatedString,
      [] as string[],
    )
    .option("-w, --workspace <path>", "Workspace directory", process.cwd())
    .option(
      "--tool-override <tool=mode>",
      "Override per-tool permission mode, can be repeated (mode: allow|confirm|deny)",
      collectToolOverride,
      {} as Record<string, ToolPermissionMode>,
    )
    .option("--verbose", "Verbose execution logs", false);

  for (const definition of SHARED_RUNTIME_OPTION_DEFINITIONS) {
    if (!options.includeSessionFile && definition.key === "sessionFile") {
      continue;
    }
    definition.register(program);
  }

  if (options.includeResume) {
    program.option("--resume", "Resume memory from --session-file", false);
  }

  if (options.includeAltScreen) {
    program
      .option(
        "--alt-screen",
        "Force the TUI into the terminal alternate screen",
      )
      .option(
        "--no-alt-screen",
        "Run TUI inline without the terminal alternate screen",
      );
  }

  if (options.includeJson) {
    program.option("--json", "JSON output", false);
  }

  return program;
}

function readCommandOptionSources<T extends readonly string[]>(
  command: Command,
  keys: T,
): Partial<Record<T[number], OptionValueSource | undefined>> {
  const sources: Partial<Record<T[number], OptionValueSource | undefined>> = {};
  for (const key of keys) {
    sources[key as T[number]] = readCommandOptionSource(command, key);
  }
  return sources;
}

function readCommandOptionSource(
  command: Command,
  key: string,
): OptionValueSource | undefined {
  let firstSource: OptionValueSource | undefined;
  let current: Command | null = command;

  while (current) {
    const source = current.getOptionValueSource(key);
    if (source === "cli") {
      return source;
    }
    firstSource ??= source;
    current = current.parent;
  }

  return firstSource;
}
