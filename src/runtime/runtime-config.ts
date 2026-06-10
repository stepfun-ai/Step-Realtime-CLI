import path from "node:path";
import {
  BUILTIN_CLI_DEFAULTS,
  BUILTIN_SERVICE_DEFAULTS,
  DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  STEP_API_KEY_ENV_NAMES,
  STEP_BASE_URL_ENV_NAMES,
  STEP_MODEL_ENV_NAMES,
  STEP_MODEL_PROVIDER_ENV_NAMES,
  STEPCLI_CONFIG_ENV_NAMES,
  STEPCLI_SERVICE_HOST_ENV_NAMES,
  STEPCLI_SERVICE_PORT_ENV_NAMES,
  STEPCLI_SERVICE_STORAGE_ROOT_DIR_ENV_NAMES,
  STEPCLI_SERVICE_TOKEN_ENV_NAMES,
} from "../bootstrap/config/defaults.js";
import {
  loadStepCliConfig,
  resolveExplicitConfigPath,
} from "../bootstrap/config/loader.js";
import {
  resolveCachedModelTokenLimits,
  resolveTokenBudgets,
} from "../bootstrap/config/model-limits.js";
import { normalizeModelsProxyBaseUrl } from "../bootstrap/config/models-proxy.js";
import type { LoadedConfig, ModelProvider } from "../bootstrap/config/types.js";
import {
  loadInstructionPrompt,
  type LoadedInstructionPrompt,
} from "../bootstrap/prompt/instruction-files.js";
import type { StepCliInteractionSurface } from "@step-cli/protocol";
import { resolveStorageRootDirectory } from "@step-cli/utils/path.js";
import { resolveInteractionProfile } from "@step-cli/utils/interaction-surface.js";
import {
  getSharedRuntimeOptionDefinition,
  isCliOptionExplicit,
  type ServiceCliOptions,
  type ServiceRuntimeCliOptionSources,
  type SharedRuntimeCliOptions,
  type SharedRuntimeCliOptionSources,
} from "../commands/shared-runtime-options.js";
import {
  readFirstEnv,
  readFirstPositiveIntEnv,
  readOptionalString,
} from "../commands/command-utils.js";
import { setStderrDevLogStorageRootDirectory } from "./stderr-dev-log.js";
import type { StepCliConfig } from "../gateway/runtime.js";
import {
  resolveStorageLayout,
  type StepCliResolvedStorageLayout,
} from "../gateway/storage/layout.js";
import {
  readSystemPromptFile,
  resolveModelsProxyDefaultModel,
  resolveOptionalValue,
  resolveValue,
  type ResolvedValue,
} from "./runtime-utils.js";

interface ResolvedSharedRuntimeOptions {
  mode: ResolvedValue<StepCliConfig["mode"]>;
  systemPromptProfile: ResolvedValue<StepCliConfig["systemPromptProfile"]>;
  codeMode: ResolvedValue<boolean>;
  toolPresentationProfile: ResolvedValue<
    StepCliConfig["toolPresentationProfile"]
  >;
  toolAliasSeed: ResolvedValue<StepCliConfig["toolAliasSeed"]>;
  toolDescriptionStyle: ResolvedValue<StepCliConfig["toolDescriptionStyle"]>;
  toolSearchIndexProfile: ResolvedValue<
    StepCliConfig["toolSearchIndexProfile"]
  >;
  maxSteps: ResolvedValue<StepCliConfig["maxSteps"]>;
  anthropicThinkingBudgetTokens: ResolvedValue<
    StepCliConfig["anthropicThinkingBudgetTokens"]
  >;
  openaiReasoningEffort: ResolvedValue<
    NonNullable<StepCliConfig["openaiReasoningEffort"]>
  >;
  maxUserClarificationsPerTurn: ResolvedValue<
    StepCliConfig["maxUserClarificationsPerTurn"]
  >;
  maxToolCallsPerStep: ResolvedValue<StepCliConfig["maxToolCallsPerStep"]>;
  maxContextTokens: ResolvedValue<StepCliConfig["maxContextTokens"]>;
  maxOutputTokens: ResolvedValue<StepCliConfig["maxOutputTokens"]>;
  minOutputTokens: ResolvedValue<StepCliConfig["minOutputTokens"]>;
  outputTokenSafetyMargin: ResolvedValue<
    StepCliConfig["outputTokenSafetyMargin"]
  >;
  parallelToolCalls: ResolvedValue<StepCliConfig["parallelToolCalls"]>;
  temperature: ResolvedValue<StepCliConfig["temperature"]>;
  timeoutMs: ResolvedValue<StepCliConfig["timeoutMs"]>;
  commandTimeoutMs: ResolvedValue<StepCliConfig["commandTimeoutMs"]>;
  commandOutputLimit: ResolvedValue<StepCliConfig["commandOutputLimit"]>;
  repeatedToolCallLimit: ResolvedValue<StepCliConfig["repeatedToolCallLimit"]>;
  modelRequestRetries: ResolvedValue<StepCliConfig["modelRequestRetries"]>;
  toolExecutionRetries: ResolvedValue<StepCliConfig["toolExecutionRetries"]>;
  maxToolResultContextChars: ResolvedValue<number>;
  approvalMode: ResolvedValue<StepCliConfig["approvalMode"]>;
  nonInteractiveApproval: ResolvedValue<
    StepCliConfig["nonInteractiveApproval"]
  >;
  pluginsDir: ResolvedValue<StepCliConfig["pluginsDir"]>;
  skillsDir: ResolvedValue<StepCliConfig["skillsDirectoryName"]>;
  storageRootDir: ResolvedValue<string>;
  sessionFile: ResolvedValue<string>;
  sessionAutosave: ResolvedValue<boolean>;
}

interface LocalRuntimeResolution {
  workspaceRoot: string;
  loadedConfig: LoadedConfig;
  provider: ResolvedValue<ModelProvider | undefined>;
  model: ResolvedValue<string>;
  baseUrl: ResolvedValue<string>;
  apiKey: ResolvedValue<string>;
  sharedOptions: ResolvedSharedRuntimeOptions;
  systemPrompt?: string;
  instructionPrompt: LoadedInstructionPrompt;
  interactionProfile: StepCliConfig["interactionProfile"];
  useAlternateScreen: boolean;
  resumeSession: boolean;
  verbose: boolean;
  toolPermissionOverrides?: StepCliConfig["toolPermissionOverrides"];
}

type ResolvedServiceRuntimeOptions = ReturnType<
  typeof resolveServiceRuntimeOptions
>;

export interface StepCliConfigInspection {
  workspaceRoot: string;
  loadedConfig: LoadedConfig;
  runtime: {
    provider: ResolvedValue<ModelProvider | undefined>;
    model: ResolvedValue<string>;
    baseUrl: ResolvedValue<string>;
    apiKey: ResolvedValue<string>;
    sharedOptions: ResolvedSharedRuntimeOptions;
    serviceOptions: ResolvedServiceRuntimeOptions;
    instructionFiles: LoadedInstructionPrompt["files"];
    metadataProbeEligible: boolean;
  };
}

export async function resolveStepCliRuntimeConfig(input: {
  options: SharedRuntimeCliOptions;
  cliOptionSources: SharedRuntimeCliOptionSources;
  resumeSession: boolean;
  useAlternateScreen?: boolean;
  interactionSurface?: StepCliInteractionSurface;
}): Promise<{
  workspaceRoot: string;
  loadedConfig: LoadedConfig;
  stepCliConfig: StepCliConfig;
}> {
  const localResolution = await resolveLocalStepCliRuntimeConfig(input);
  return {
    workspaceRoot: localResolution.workspaceRoot,
    loadedConfig: localResolution.loadedConfig,
    stepCliConfig: await finalizeStepCliRuntimeConfig(localResolution),
  };
}

export async function inspectStepCliConfig(input: {
  workspaceRoot: string;
  explicitConfigPath?: string;
}): Promise<StepCliConfigInspection> {
  const localResolution = await resolveLocalStepCliRuntimeConfig({
    options: {
      workspace: input.workspaceRoot,
      config: input.explicitConfigPath,
    },
    cliOptionSources: {},
    resumeSession: false,
    useAlternateScreen: false,
  });
  const serviceOptions = resolveServiceRuntimeOptions({
    options: {},
    cliOptionSources: {},
    sharedCliOptionSources: {},
    loadedConfig: localResolution.loadedConfig,
    workspaceRoot: localResolution.workspaceRoot,
  });

  return {
    workspaceRoot: localResolution.workspaceRoot,
    loadedConfig: localResolution.loadedConfig,
    runtime: {
      provider: localResolution.provider,
      model: localResolution.model,
      baseUrl: localResolution.baseUrl,
      apiKey: localResolution.apiKey,
      sharedOptions: localResolution.sharedOptions,
      serviceOptions,
      instructionFiles: localResolution.instructionPrompt.files,
      metadataProbeEligible: shouldProbeModelMetadata(localResolution),
    },
  };
}

export function resolveServiceRuntimeOptions(input: {
  options: ServiceCliOptions;
  cliOptionSources: ServiceRuntimeCliOptionSources;
  sharedCliOptionSources: SharedRuntimeCliOptionSources;
  loadedConfig: LoadedConfig;
  workspaceRoot: string;
}): {
  host: string;
  port: number;
  token?: string;
  storageRootDir: string;
} {
  const serviceConfig = input.loadedConfig.service;
  const host = resolveValue(
    [
      isCliOptionExplicit(input.cliOptionSources, "host")
        ? {
            value: readOptionalString(input.options.host),
            source: "cli" as const,
          }
        : undefined,
      {
        value: readFirstEnv(STEPCLI_SERVICE_HOST_ENV_NAMES),
        source: "env" as const,
      },
      {
        value: serviceConfig?.host,
        source: "config.service" as const,
      },
    ],
    {
      value: BUILTIN_SERVICE_DEFAULTS.host,
      source: "fallback" as const,
    },
  );
  const port = resolveValue(
    [
      isCliOptionExplicit(input.cliOptionSources, "port")
        ? {
            value: input.options.port,
            source: "cli" as const,
          }
        : undefined,
      {
        value: readFirstPositiveIntEnv(STEPCLI_SERVICE_PORT_ENV_NAMES),
        source: "env" as const,
      },
      {
        value: serviceConfig?.port,
        source: "config.service" as const,
      },
    ],
    {
      value: BUILTIN_SERVICE_DEFAULTS.port,
      source: "fallback" as const,
    },
  );
  const token = resolveOptionalValue([
    isCliOptionExplicit(input.cliOptionSources, "token")
      ? {
          value: readOptionalString(input.options.token),
          source: "cli" as const,
        }
      : undefined,
    {
      value: readFirstEnv(STEPCLI_SERVICE_TOKEN_ENV_NAMES),
      source: "env" as const,
    },
    {
      value: serviceConfig?.token,
      source: "config.service" as const,
    },
  ]);
  const storageRootDir = resolveValue(
    [
      isCliOptionExplicit(input.sharedCliOptionSources, "storageRootDir")
        ? {
            value: readOptionalString(input.options.storageRootDir),
            source: "cli" as const,
          }
        : undefined,
      {
        value: readFirstEnv(STEPCLI_SERVICE_STORAGE_ROOT_DIR_ENV_NAMES),
        source: "env" as const,
      },
      {
        value: input.loadedConfig.storage?.rootDir,
        source: "config" as const,
      },
    ],
    {
      value: BUILTIN_CLI_DEFAULTS.storage.rootDir,
      source: "fallback" as const,
    },
  );

  return {
    host: host.value,
    port: port.value,
    token: token.value,
    storageRootDir: resolveStorageRootDirectory(
      input.workspaceRoot,
      storageRootDir.value,
    ),
  };
}

async function resolveLocalStepCliRuntimeConfig(input: {
  options: SharedRuntimeCliOptions;
  cliOptionSources: SharedRuntimeCliOptionSources;
  resumeSession: boolean;
  useAlternateScreen?: boolean;
  interactionSurface?: StepCliInteractionSurface;
}): Promise<LocalRuntimeResolution> {
  const workspaceRoot = path.resolve(
    readOptionalString(input.options.workspace) ?? process.cwd(),
  );
  const explicitConfigPath = resolveExplicitConfigPath(
    readOptionalString(input.options.config),
    readFirstEnv(STEPCLI_CONFIG_ENV_NAMES),
  );
  const loadedConfig = await loadStepCliConfig({
    workspaceRoot,
    explicitConfigPath,
  });
  const provider = resolveOptionalValue([
    isCliOptionExplicit(input.cliOptionSources, "provider")
      ? {
          value: parseProvider(readOptionalString(input.options.provider)),
          source: "cli" as const,
        }
      : undefined,
    {
      value: parseProvider(readFirstEnv(STEP_MODEL_PROVIDER_ENV_NAMES)),
      source: "env" as const,
    },
    {
      value: loadedConfig.model?.provider,
      source: "config" as const,
    },
  ]);
  const modelsProxy = loadedConfig.integrations?.modelsProxy;
  const model = resolveValue(
    [
      isCliOptionExplicit(input.cliOptionSources, "model")
        ? {
            value: readOptionalString(input.options.model),
            source: "cli" as const,
          }
        : undefined,
      {
        value: readFirstEnv(STEP_MODEL_ENV_NAMES),
        source: "env" as const,
      },
      {
        value: loadedConfig.model?.model,
        source: "config" as const,
      },
      {
        value: resolveModelsProxyDefaultModel(modelsProxy?.models),
        source: "config.modelsProxy" as const,
      },
    ],
    {
      value: DEFAULT_MODEL,
      source: "fallback" as const,
    },
  );
  const baseUrl = resolveValue(
    [
      isCliOptionExplicit(input.cliOptionSources, "baseUrl")
        ? {
            value: readOptionalString(input.options.baseUrl),
            source: "cli" as const,
          }
        : undefined,
      {
        value: readFirstEnv(STEP_BASE_URL_ENV_NAMES),
        source: "env" as const,
      },
      {
        value: loadedConfig.model?.baseUrl,
        source: "config" as const,
      },
      {
        value: normalizeModelsProxyBaseUrl(modelsProxy?.baseUrl, {
          api: modelsProxy?.api,
          provider: provider.value,
        }),
        source: "config.modelsProxy" as const,
      },
    ],
    {
      value: DEFAULT_BASE_URL,
      source: "fallback" as const,
    },
  );
  const apiKey = resolveValue(
    [
      isCliOptionExplicit(input.cliOptionSources, "apiKey")
        ? {
            value: readOptionalString(input.options.apiKey),
            source: "cli" as const,
          }
        : undefined,
      {
        value: readFirstEnv(STEP_API_KEY_ENV_NAMES),
        source: "env" as const,
      },
      {
        value: loadedConfig.model?.apiKey,
        source: "config" as const,
      },
      {
        value: modelsProxy?.apiKey,
        source: "config.modelsProxy" as const,
      },
    ],
    {
      value: "",
      source: "fallback" as const,
    },
  );
  const sharedOptions = resolveSharedRuntimeOptions({
    options: input.options,
    cliOptionSources: input.cliOptionSources,
    loadedConfig,
  });
  setStderrDevLogStorageRootDirectory(
    resolveStorageRootDirectory(
      workspaceRoot,
      sharedOptions.storageRootDir.value,
    ),
  );
  const systemPrompt = input.options.systemPromptFile
    ? await readSystemPromptFile(input.options.systemPromptFile)
    : undefined;
  const instructionPrompt = loadInstructionPrompt(workspaceRoot);
  const interactionProfile = resolveInteractionProfile({
    json: Boolean(input.options.json),
    surfaceOverride: input.interactionSurface,
  });
  const useAlternateScreen =
    input.useAlternateScreen ??
    loadedConfig.clients?.tui?.altScreen ??
    (interactionProfile.surface === "interactive" ? true : false);
  const toolPermissionOverrides =
    loadedConfig.tools?.approval?.overrides || input.options.toolOverride
      ? {
          ...loadedConfig.tools?.approval?.overrides,
          ...input.options.toolOverride,
        }
      : undefined;

  return {
    workspaceRoot,
    loadedConfig,
    provider,
    model,
    baseUrl,
    apiKey,
    sharedOptions,
    systemPrompt,
    instructionPrompt,
    interactionProfile,
    useAlternateScreen,
    resumeSession: input.resumeSession,
    verbose: Boolean(input.options.verbose),
    toolPermissionOverrides,
  };
}

async function finalizeStepCliRuntimeConfig(
  localResolution: LocalRuntimeResolution,
): Promise<StepCliConfig> {
  const tokenBudgets = shouldProbeModelMetadata(localResolution)
    ? resolveTokenBudgets({
        cliMaxContextTokens:
          localResolution.sharedOptions.maxContextTokens.source === "cli"
            ? localResolution.sharedOptions.maxContextTokens.value
            : undefined,
        cliMaxOutputTokens:
          localResolution.sharedOptions.maxOutputTokens.source === "cli"
            ? localResolution.sharedOptions.maxOutputTokens.value
            : undefined,
        configMaxContextTokens:
          localResolution.sharedOptions.maxContextTokens.source === "config"
            ? localResolution.sharedOptions.maxContextTokens.value
            : undefined,
        configMaxOutputTokens:
          localResolution.sharedOptions.maxOutputTokens.source === "config"
            ? localResolution.sharedOptions.maxOutputTokens.value
            : undefined,
        metadata: await resolveCachedModelTokenLimits({
          model: localResolution.model.value,
          baseUrl: localResolution.baseUrl.value,
          apiKey: localResolution.apiKey.value,
          provider: localResolution.provider.value,
          timeoutMs: Math.min(
            localResolution.sharedOptions.timeoutMs.value,
            5_000,
          ),
        }),
        fallbackMaxContextTokens: BUILTIN_CLI_DEFAULTS.maxContextTokens,
        fallbackMaxOutputTokens: BUILTIN_CLI_DEFAULTS.maxOutputTokens,
      })
    : resolveTokenBudgets({
        cliMaxContextTokens:
          localResolution.sharedOptions.maxContextTokens.source === "cli"
            ? localResolution.sharedOptions.maxContextTokens.value
            : undefined,
        cliMaxOutputTokens:
          localResolution.sharedOptions.maxOutputTokens.source === "cli"
            ? localResolution.sharedOptions.maxOutputTokens.value
            : undefined,
        configMaxContextTokens:
          localResolution.sharedOptions.maxContextTokens.source === "config"
            ? localResolution.sharedOptions.maxContextTokens.value
            : undefined,
        configMaxOutputTokens:
          localResolution.sharedOptions.maxOutputTokens.source === "config"
            ? localResolution.sharedOptions.maxOutputTokens.value
            : undefined,
        metadata: null,
        fallbackMaxContextTokens: BUILTIN_CLI_DEFAULTS.maxContextTokens,
        fallbackMaxOutputTokens: BUILTIN_CLI_DEFAULTS.maxOutputTokens,
      });

  const maxContextTokens =
    tokenBudgets.maxContextTokensSource === "cli"
      ? localResolution.sharedOptions.maxContextTokens
      : tokenBudgets.maxContextTokensSource === "config"
        ? localResolution.sharedOptions.maxContextTokens
        : {
            value: tokenBudgets.maxContextTokens,
            source:
              tokenBudgets.maxContextTokensSource === "metadata"
                ? "metadata"
                : "fallback",
          };
  const maxOutputTokens =
    tokenBudgets.maxOutputTokensSource === "cli"
      ? localResolution.sharedOptions.maxOutputTokens
      : tokenBudgets.maxOutputTokensSource === "config"
        ? localResolution.sharedOptions.maxOutputTokens
        : {
            value: tokenBudgets.maxOutputTokens,
            source:
              tokenBudgets.maxOutputTokensSource === "metadata"
                ? "metadata"
                : "fallback",
          };

  if (
    localResolution.sharedOptions.minOutputTokens.value > maxOutputTokens.value
  ) {
    throw new Error("--min-output-tokens must be <= --max-output-tokens");
  }

  if (
    localResolution.provider.value === "anthropic" &&
    maxOutputTokens.value <=
      (localResolution.sharedOptions.anthropicThinkingBudgetTokens.value ??
        DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS)
  ) {
    throw new Error(
      "--max-output-tokens must be > --anthropic-thinking-budget-tokens",
    );
  }

  const storageRootDir = resolveStorageRootDirectory(
    localResolution.workspaceRoot,
    localResolution.sharedOptions.storageRootDir.value,
  );
  const storageLayout = resolveStorageLayout(
    storageRootDir,
    resolveConfiguredStorageLayoutPaths(localResolution.loadedConfig.storage),
  );

  return {
    mode: localResolution.sharedOptions.mode.value,
    model: localResolution.model.value,
    provider: localResolution.provider.value,
    baseUrl: localResolution.baseUrl.value,
    apiKey: localResolution.apiKey.value,
    anthropicThinkingBudgetTokens:
      localResolution.provider.value === "anthropic"
        ? (localResolution.sharedOptions.anthropicThinkingBudgetTokens.value ??
          DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS)
        : localResolution.sharedOptions.anthropicThinkingBudgetTokens.value,
    openaiReasoningEffort:
      localResolution.sharedOptions.openaiReasoningEffort.value,
    maxUserClarificationsPerTurn:
      localResolution.sharedOptions.maxUserClarificationsPerTurn.value,
    systemPrompt: localResolution.systemPrompt,
    instructionPrompt: localResolution.instructionPrompt.prompt,
    systemPromptProfile:
      localResolution.sharedOptions.systemPromptProfile.value,
    codeMode: localResolution.sharedOptions.codeMode.value,
    toolPresentationProfile:
      localResolution.sharedOptions.toolPresentationProfile.value,
    toolAliasSeed: localResolution.sharedOptions.toolAliasSeed.value,
    toolDescriptionStyle:
      localResolution.sharedOptions.toolDescriptionStyle.value,
    toolSearchIndexProfile:
      localResolution.sharedOptions.toolSearchIndexProfile.value,
    agentPresets: localResolution.loadedConfig.agents?.presets,
    mcpServers: localResolution.loadedConfig.integrations?.mcp?.servers,
    workspaceRoot: localResolution.workspaceRoot,
    maxSteps: localResolution.sharedOptions.maxSteps.value,
    maxToolCallsPerStep:
      localResolution.sharedOptions.maxToolCallsPerStep.value,
    maxContextTokens: maxContextTokens.value,
    maxOutputTokens: maxOutputTokens.value,
    minOutputTokens: localResolution.sharedOptions.minOutputTokens.value,
    outputTokenSafetyMargin:
      localResolution.sharedOptions.outputTokenSafetyMargin.value,
    parallelToolCalls: localResolution.sharedOptions.parallelToolCalls.value,
    temperature: localResolution.sharedOptions.temperature.value,
    timeoutMs: localResolution.sharedOptions.timeoutMs.value,
    commandTimeoutMs: localResolution.sharedOptions.commandTimeoutMs.value,
    commandOutputLimit: localResolution.sharedOptions.commandOutputLimit.value,
    repeatedToolCallLimit:
      localResolution.sharedOptions.repeatedToolCallLimit.value,
    maxToolResultCharsInContext:
      localResolution.sharedOptions.maxToolResultContextChars.value,
    modelRequestRetries:
      localResolution.sharedOptions.modelRequestRetries.value,
    toolExecutionRetries:
      localResolution.sharedOptions.toolExecutionRetries.value,
    approvalMode: localResolution.sharedOptions.approvalMode.value,
    nonInteractiveApproval:
      localResolution.sharedOptions.nonInteractiveApproval.value,
    toolPermissionOverrides: localResolution.toolPermissionOverrides,
    pluginsDir: localResolution.sharedOptions.pluginsDir.value,
    skillsDirectoryName: localResolution.sharedOptions.skillsDir.value,
    storageRootDir,
    storageLayout,
    interactionProfile: localResolution.interactionProfile,
    sessionFile: localResolution.sharedOptions.sessionFile.value,
    resumeSession: localResolution.resumeSession,
    autoSaveSession: localResolution.sharedOptions.sessionAutosave.value,
    sessionTraceEnabled:
      localResolution.loadedConfig.session?.trace?.enabled ??
      BUILTIN_CLI_DEFAULTS.sessionTraceEnabled,
    sessionTraceKeepLast:
      localResolution.loadedConfig.session?.trace?.keepLast ??
      BUILTIN_CLI_DEFAULTS.sessionTraceKeepLast,
    sessionTraceMaxBodyBytes:
      localResolution.loadedConfig.session?.trace?.maxBodyBytes ??
      BUILTIN_CLI_DEFAULTS.sessionTraceMaxBodyBytes,
    sessionTraceHeaderInjectionBaseUrls: localResolution.loadedConfig.session
      ?.trace?.headerInjectionBaseUrls ?? [
      ...BUILTIN_CLI_DEFAULTS.sessionTraceHeaderInjectionBaseUrls,
    ],
    useAlternateScreen: localResolution.useAlternateScreen,
    tuiScroll: localResolution.loadedConfig.clients?.tui?.scroll,
    verbose: localResolution.verbose,
  };
}

function resolveConfiguredStorageLayoutPaths(
  storage: LoadedConfig["storage"] | undefined,
): StepCliResolvedStorageLayout["paths"] {
  const builtinLayout = BUILTIN_CLI_DEFAULTS.storage.layout;
  const layout = storage?.layout ?? {};
  return {
    ...builtinLayout,
    ...layout,
  };
}

function resolveSharedRuntimeOptions(input: {
  options: SharedRuntimeCliOptions;
  cliOptionSources: SharedRuntimeCliOptionSources;
  loadedConfig: LoadedConfig;
}): ResolvedSharedRuntimeOptions {
  return {
    mode: resolveSharedRuntimeOption("mode", input),
    systemPromptProfile: resolveSharedRuntimeOption(
      "systemPromptProfile",
      input,
    ),
    codeMode: resolveSharedRuntimeOption("codeMode", input),
    toolPresentationProfile: resolveSharedRuntimeOption(
      "toolPresentationProfile",
      input,
    ),
    toolAliasSeed: resolveSharedRuntimeOption("toolAliasSeed", input),
    toolDescriptionStyle: resolveSharedRuntimeOption(
      "toolDescriptionStyle",
      input,
    ),
    toolSearchIndexProfile: resolveSharedRuntimeOption(
      "toolSearchIndexProfile",
      input,
    ),
    maxSteps: resolveSharedRuntimeOption("maxSteps", input),
    anthropicThinkingBudgetTokens: resolveSharedRuntimeOption(
      "anthropicThinkingBudgetTokens",
      input,
    ),
    openaiReasoningEffort: resolveSharedRuntimeOption(
      "openaiReasoningEffort",
      input,
    ),
    maxUserClarificationsPerTurn: resolveSharedRuntimeOption(
      "maxUserClarificationsPerTurn",
      input,
    ),
    maxToolCallsPerStep: resolveSharedRuntimeOption(
      "maxToolCallsPerStep",
      input,
    ),
    maxContextTokens: resolveSharedRuntimeOption("maxContextTokens", input),
    maxOutputTokens: resolveSharedRuntimeOption("maxOutputTokens", input),
    minOutputTokens: resolveSharedRuntimeOption("minOutputTokens", input),
    outputTokenSafetyMargin: resolveSharedRuntimeOption(
      "outputTokenSafetyMargin",
      input,
    ),
    parallelToolCalls: resolveSharedRuntimeOption("parallelToolCalls", input),
    temperature: resolveSharedRuntimeOption("temperature", input),
    timeoutMs: resolveSharedRuntimeOption("timeoutMs", input),
    commandTimeoutMs: resolveSharedRuntimeOption("commandTimeoutMs", input),
    commandOutputLimit: resolveSharedRuntimeOption("commandOutputLimit", input),
    repeatedToolCallLimit: resolveSharedRuntimeOption(
      "repeatedToolCallLimit",
      input,
    ),
    modelRequestRetries: resolveSharedRuntimeOption(
      "modelRequestRetries",
      input,
    ),
    toolExecutionRetries: resolveSharedRuntimeOption(
      "toolExecutionRetries",
      input,
    ),
    maxToolResultContextChars: resolveSharedRuntimeOption(
      "maxToolResultContextChars",
      input,
    ),
    approvalMode: resolveSharedRuntimeOption("approvalMode", input),
    nonInteractiveApproval: resolveSharedRuntimeOption(
      "nonInteractiveApproval",
      input,
    ),
    pluginsDir: resolveSharedRuntimeOption("pluginsDir", input),
    skillsDir: resolveSharedRuntimeOption("skillsDir", input),
    storageRootDir: resolveSharedRuntimeOption("storageRootDir", input),
    sessionFile: resolveSharedRuntimeOption("sessionFile", input),
    sessionAutosave: resolveSharedRuntimeOption("sessionAutosave", input),
  };
}

function resolveSharedRuntimeOption(
  key: Parameters<typeof getSharedRuntimeOptionDefinition>[0],
  input: {
    options: SharedRuntimeCliOptions;
    cliOptionSources: SharedRuntimeCliOptionSources;
    loadedConfig: LoadedConfig;
  },
): ResolvedValue<any> {
  const definition = getSharedRuntimeOptionDefinition(key);
  const cliValue = readSharedRuntimeCliValue(key, input.options);
  const configValue = readBootstrapSharedRuntimeOption(key, input.loadedConfig);

  if (definition.optional) {
    return resolveOptionalValue([
      isCliOptionExplicit(input.cliOptionSources, key)
        ? {
            value: cliValue,
            source: "cli" as const,
          }
        : undefined,
      {
        value: configValue,
        source: "config" as const,
      },
    ]);
  }

  return resolveValue(
    [
      isCliOptionExplicit(input.cliOptionSources, key)
        ? {
            value: cliValue,
            source: "cli" as const,
          }
        : undefined,
      {
        value: configValue,
        source: "config" as const,
      },
    ],
    {
      value: definition.fallback,
      source: "fallback" as const,
    },
  );
}

function readBootstrapSharedRuntimeOption(
  key: Parameters<typeof getSharedRuntimeOptionDefinition>[0],
  config: LoadedConfig,
): unknown {
  switch (key) {
    case "mode":
      return config.agent?.mode;
    case "systemPromptProfile":
      return config.agent?.systemPromptProfile;
    case "codeMode":
      return config.tools?.codeMode;
    case "toolPresentationProfile":
      return config.tools?.presentation?.profile;
    case "toolAliasSeed":
      return config.tools?.presentation?.aliasSeed;
    case "toolDescriptionStyle":
      return config.tools?.presentation?.descriptionStyle;
    case "toolSearchIndexProfile":
      return config.tools?.presentation?.searchIndexProfile;
    case "maxSteps":
      return config.agent?.maxSteps;
    case "anthropicThinkingBudgetTokens":
      return config.model?.reasoning?.anthropicThinkingBudgetTokens;
    case "openaiReasoningEffort":
      return config.model?.reasoning?.openaiReasoningEffort;
    case "maxUserClarificationsPerTurn":
      return config.agent?.maxUserClarificationsPerTurn;
    case "maxToolCallsPerStep":
      return config.tools?.maxCallsPerStep;
    case "maxContextTokens":
      return config.model?.tokens?.maxContext;
    case "maxOutputTokens":
      return config.model?.tokens?.maxOutput;
    case "minOutputTokens":
      return config.model?.tokens?.minOutput;
    case "outputTokenSafetyMargin":
      return config.model?.tokens?.outputSafetyMargin;
    case "parallelToolCalls":
      return config.tools?.parallelCalls;
    case "temperature":
      return config.agent?.temperature;
    case "timeoutMs":
      return config.model?.timeoutMs;
    case "commandTimeoutMs":
      return config.tools?.commandTimeoutMs;
    case "commandOutputLimit":
      return config.tools?.commandOutputLimit;
    case "repeatedToolCallLimit":
      return config.tools?.repeatedCallLimit;
    case "modelRequestRetries":
      return config.agent?.retries?.modelRequest;
    case "toolExecutionRetries":
      return config.agent?.retries?.toolExecution;
    case "maxToolResultContextChars":
      return config.tools?.maxResultContextChars;
    case "approvalMode":
      return config.tools?.approval?.mode;
    case "nonInteractiveApproval":
      return config.tools?.approval?.nonInteractive;
    case "pluginsDir":
      return config.workspace?.pluginsDir;
    case "skillsDir":
      return config.workspace?.skillsDirName;
    case "storageRootDir":
      return config.storage?.rootDir;
    case "sessionFile":
      return undefined;
    case "sessionAutosave":
      return config.session?.autosave;
  }
}

function readSharedRuntimeCliValue(
  key: Parameters<typeof getSharedRuntimeOptionDefinition>[0],
  options: SharedRuntimeCliOptions,
): unknown {
  switch (key) {
    case "toolAliasSeed":
      return readOptionalString(options.toolAliasSeed);
    case "pluginsDir":
      return readOptionalString(options.pluginsDir);
    case "skillsDir":
      return readOptionalString(options.skillsDir);
    case "storageRootDir":
      return readOptionalString(options.storageRootDir);
    case "sessionFile":
      return readOptionalString(options.sessionFile);
    default:
      return options[key];
  }
}

function shouldProbeModelMetadata(
  localResolution: LocalRuntimeResolution,
): boolean {
  return (
    localResolution.sharedOptions.maxContextTokens.source === "fallback" ||
    localResolution.sharedOptions.maxOutputTokens.source === "fallback"
  );
}

function parseProvider(provider: unknown): ModelProvider | undefined {
  if (provider === undefined || provider === null || provider === "") {
    return undefined;
  }

  if (
    provider === "openai" ||
    provider === "response" ||
    provider === "anthropic"
  ) {
    return provider;
  }

  throw new Error(
    `Unsupported provider: ${String(provider)}. Expected one of: openai, response, anthropic`,
  );
}
