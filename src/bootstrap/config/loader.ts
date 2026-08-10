import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_CONFIG_TEMPLATE_MODEL,
  DEFAULT_CONFIG_TEMPLATE_MODELS_PROXY_API,
  DEFAULT_CONFIG_TEMPLATE_PROVIDER,
  DEFAULT_MODELS_PROXY_BASE_URL,
  DEFAULT_STORAGE_ROOT_DIR,
  MIN_ANTHROPIC_THINKING_BUDGET_TOKENS,
} from "./defaults.js";
import { readConfiguredMaxSteps } from "./max-steps.js";
import {
  describeToolPresentationProfileOptions,
  parseToolPresentationProfile,
} from "@step-cli/core/tools/presentation-profile.js";
import type { StepCliTuiScrollConfig } from "@step-cli/protocol";
import { uniquePaths } from "@step-cli/utils/path.js";
import type {
  ApprovalMode,
  LoadedConfig,
  NonInteractiveApproval,
  AgentConfig,
  AgentPresetConfig,
  AgentsConfig,
  ClientsConfig,
  ConfigFile,
  ConfigPaths,
  IntegrationsConfig,
  McpServerConfig,
  ModelConfig,
  ModelsProxyConfig,
  ServiceConfig,
  SessionConfig,
  StorageConfig,
  StorageLayoutConfig,
  ToolsConfig,
  WorkspaceConfig,
} from "./types.js";

const CONFIG_DIRNAME = ".step-cli";
const CONFIG_BASENAME = "config.json";

interface ParsedConfigEntry {
  path: string;
  config: ConfigFile;
}

interface NormalizedLegacyParsedConfigRoot {
  defaultsInput: Record<string, unknown>;
  modelsProxyInput?: Record<string, unknown>;
  serviceInput?: Record<string, unknown>;
  agentPresetsInput?: unknown;
  mcpServersInput?: Record<string, unknown>;
  tuiInput?: Record<string, unknown>;
}

interface LegacyStepCliConfigDefaults {
  mode?: AgentConfig["mode"];
  systemPromptProfile?: AgentConfig["systemPromptProfile"];
  codeMode?: boolean;
  toolPresentationProfile?: NonNullable<
    NonNullable<ToolsConfig["presentation"]>["profile"]
  >;
  toolAliasSeed?: NonNullable<ToolsConfig["presentation"]>["aliasSeed"];
  toolDescriptionStyle?: NonNullable<
    NonNullable<ToolsConfig["presentation"]>["descriptionStyle"]
  >;
  toolSearchIndexProfile?: NonNullable<
    NonNullable<ToolsConfig["presentation"]>["searchIndexProfile"]
  >;
  model?: string;
  provider?: ModelConfig["provider"];
  baseUrl?: string;
  apiKey?: string;
  anthropicThinkingBudgetTokens?: NonNullable<
    NonNullable<ModelConfig["reasoning"]>["anthropicThinkingBudgetTokens"]
  >;
  openaiReasoningEffort?: NonNullable<
    NonNullable<ModelConfig["reasoning"]>["openaiReasoningEffort"]
  >;
  maxUserClarificationsPerTurn?: AgentConfig["maxUserClarificationsPerTurn"];
  maxSteps?: AgentConfig["maxSteps"];
  maxToolCallsPerStep?: ToolsConfig["maxCallsPerStep"];
  maxContextTokens?: NonNullable<
    NonNullable<ModelConfig["tokens"]>["maxContext"]
  >;
  maxOutputTokens?: NonNullable<
    NonNullable<ModelConfig["tokens"]>["maxOutput"]
  >;
  minOutputTokens?: NonNullable<
    NonNullable<ModelConfig["tokens"]>["minOutput"]
  >;
  outputTokenSafetyMargin?: NonNullable<
    NonNullable<ModelConfig["tokens"]>["outputSafetyMargin"]
  >;
  parallelToolCalls?: ToolsConfig["parallelCalls"];
  temperature?: AgentConfig["temperature"];
  timeoutMs?: ModelConfig["timeoutMs"];
  commandTimeoutMs?: ToolsConfig["commandTimeoutMs"];
  commandOutputLimit?: ToolsConfig["commandOutputLimit"];
  repeatedToolCallLimit?: ToolsConfig["repeatedCallLimit"];
  modelRequestRetries?: NonNullable<
    NonNullable<AgentConfig["retries"]>["modelRequest"]
  >;
  toolExecutionRetries?: NonNullable<
    NonNullable<AgentConfig["retries"]>["toolExecution"]
  >;
  maxToolResultContextChars?: ToolsConfig["maxResultContextChars"];
  approvalMode?: ApprovalMode;
  nonInteractiveApproval?: NonInteractiveApproval;
  toolOverride?: Record<string, "allow" | "confirm" | "deny">;
  pluginsDir?: string;
  skillsDir?: string;
  storage?: StorageConfig;
  sessionFile?: string;
  sessionAutosave?: boolean;
  altScreen?: boolean;
}

export function getDefaultUserConfigPath(): string {
  return path.join(os.homedir(), CONFIG_DIRNAME, CONFIG_BASENAME);
}

export function getDefaultWorkspaceConfigPath(workspaceRoot: string): string {
  return path.join(
    path.resolve(workspaceRoot),
    CONFIG_DIRNAME,
    CONFIG_BASENAME,
  );
}

export function resolveExplicitConfigPath(
  cliConfigPath: string | undefined,
  envConfigPath: string | undefined,
): string | undefined {
  const direct = readOptionalString(cliConfigPath);
  if (direct) {
    return path.resolve(direct);
  }

  const fromEnv = readOptionalString(envConfigPath);
  if (fromEnv) {
    return path.resolve(fromEnv);
  }

  return undefined;
}

export function resolveStepCliConfigPaths(input: {
  workspaceRoot: string;
  explicitConfigPath?: string;
}): ConfigPaths {
  return {
    userConfigPath: getDefaultUserConfigPath(),
    workspaceConfigPath: getDefaultWorkspaceConfigPath(input.workspaceRoot),
    explicitConfigPath: input.explicitConfigPath
      ? path.resolve(input.explicitConfigPath)
      : undefined,
  };
}

export async function loadStepCliConfig(input: {
  workspaceRoot: string;
  explicitConfigPath?: string;
}): Promise<LoadedConfig> {
  const paths = resolveStepCliConfigPaths(input);
  const entries = paths.explicitConfigPath
    ? [await readConfigEntry(paths.explicitConfigPath, true)]
    : await Promise.all(
        uniquePaths([paths.userConfigPath, paths.workspaceConfigPath]).map(
          (entryPath) => readConfigEntry(entryPath, false),
        ),
      );

  let config: ConfigFile = {};
  const loadedPaths: string[] = [];

  for (const entry of entries) {
    if (!entry) {
      continue;
    }

    loadedPaths.push(entry.path);
    config = mergeConfigFile(config, entry.config);
  }

  return {
    ...paths,
    loadedPaths,
    ...config,
  };
}

export async function writeDefaultConfigTemplate(
  targetPath: string,
  options: {
    force: boolean;
  },
): Promise<string> {
  const absolutePath = path.resolve(targetPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });

  try {
    await fs.writeFile(absolutePath, createDefaultConfigTemplate(), {
      encoding: "utf8",
      flag: options.force ? "w" : "wx",
    });
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") {
      throw new Error(
        `Config file already exists: ${absolutePath}. Re-run with --force to overwrite.`,
      );
    }
    throw error;
  }

  return absolutePath;
}

export function createDefaultConfigTemplate(): string {
  return `${JSON.stringify(
    {
      model: {
        model: DEFAULT_CONFIG_TEMPLATE_MODEL,
        provider: DEFAULT_CONFIG_TEMPLATE_PROVIDER,
        apiKey: "<your_api_key>",
      },
      storage: {
        rootDir: DEFAULT_STORAGE_ROOT_DIR,
      },
      integrations: {
        modelsProxy: {
          baseUrl: DEFAULT_MODELS_PROXY_BASE_URL,
          api: DEFAULT_CONFIG_TEMPLATE_MODELS_PROXY_API,
          models: [DEFAULT_CONFIG_TEMPLATE_MODEL],
        },
      },
      session: {
        autosave: true,
      },
      clients: {
        tui: {
          altScreen: false,
        },
      },
      voice: {
        realtime: {
          apiKey: "<your_stepfun_api_key>",
          endpoint: "wss://api.stepfun.com/v1/realtime/stateless",
        },
        defaults: {
          backend: "stepfun_stateless",
          inputMode: "duplex",
          vad: "energy",
          aec: false,
          speedRatio: 1.1,
        },
        coding: {
          maxTurns: 30,
          budgetUsd: 5,
          permissionMode: "bypassPermissions",
        },
      },
    },
    null,
    2,
  )}\n`;
}

async function readConfigEntry(
  filePath: string,
  required: boolean,
): Promise<ParsedConfigEntry | undefined> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT" && !required) {
      return undefined;
    }
    throw new Error(
      `Failed to read step-cli config at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = parseConfigContent(filePath, content);
  const root = readRecord(parsed);
  if (!root) {
    throw new Error(
      `Expected step-cli config at ${filePath} to contain an object at the top level`,
    );
  }

  const normalized = normalizeParsedConfigRoot(root);
  const legacyDefaults = readLegacyConfigDefaults(
    normalized.defaultsInput,
    "config.defaults",
  );
  const legacyService = normalizeServiceConfig(
    readServiceConfig(normalized.serviceInput, "config.service"),
  );
  const legacyConfig = convertLegacyConfigToCanonical({
    defaults: legacyDefaults,
    modelsProxy: readModelsProxyConfig(
      normalized.modelsProxyInput,
      "config.modelsProxy",
    ),
    service: legacyService,
    agentPresets: readAgentPresets(
      normalized.agentPresetsInput,
      "config.agentPresets",
    ),
    mcpServers: readMcpServers(normalized.mcpServersInput, "config.mcpServers"),
    tui: readTuiConfig(normalized.tuiInput, "config.tui"),
  });
  const canonicalConfig = readCanonicalConfig(root, "config");

  return {
    path: filePath,
    config: mergeConfigFile(legacyConfig, canonicalConfig),
  };
}

function normalizeParsedConfigRoot(
  root: Record<string, unknown>,
): NormalizedLegacyParsedConfigRoot {
  const nestedDefaults = readRecord(root.defaults);
  const nestedModelsProxy = readRecord(
    readRecord(readRecord(root.models)?.providers)?.modelsproxy,
  );
  const aliasModelsProxy =
    readRecord(root.modelsProxy) ?? readRecord(root.modelsproxy);
  const nestedService = readRecord(root.service);
  const aliasService = readRecord(root.server);
  const nestedMcpRoot = readRecord(root.mcp);
  const topLevelMcpServers =
    readRecord(root.mcpServers) ?? readRecord(root.mcp_servers);
  const nestedMcpServers =
    readRecord(nestedMcpRoot?.servers) ??
    readRecord(nestedMcpRoot?.mcpServers) ??
    readRecord(nestedMcpRoot?.mcp_servers) ??
    (nestedMcpRoot && !("servers" in nestedMcpRoot)
      ? nestedMcpRoot
      : undefined);

  return {
    defaultsInput: {
      ...root,
      ...nestedDefaults,
    },
    modelsProxyInput: mergeRawRecords(nestedModelsProxy, aliasModelsProxy),
    serviceInput: mergeRawRecords(nestedService, aliasService),
    agentPresetsInput: root.agentPresets ?? root.agent_presets,
    mcpServersInput: mergeRawRecords(topLevelMcpServers, nestedMcpServers),
    tuiInput: mergeRawRecords(
      readRecord(nestedDefaults?.tui),
      readRecord(root.tui),
    ),
  };
}

function mergeRawRecords(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  return {
    ...base,
    ...override,
  };
}

function parseConfigContent(filePath: string, content: string): unknown {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return {};
  }

  const extension = path.extname(filePath).toLowerCase();
  try {
    if (extension === ".yaml" || extension === ".yml") {
      return parseYaml(trimmed);
    }
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `Failed to parse step-cli config at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readCanonicalConfig(
  root: Record<string, unknown>,
  basePath: string,
): ConfigFile {
  return compactConfigFile({
    model: readModelConfig(readRecord(root.model), `${basePath}.model`),
    agent: readAgentConfig(readRecord(root.agent), `${basePath}.agent`),
    tools: readToolsConfig(readRecord(root.tools), `${basePath}.tools`),
    storage: readStructuredStorageConfig(
      readRecord(root.storage),
      `${basePath}.storage`,
    ),
    workspace: readWorkspaceConfig(
      readRecord(root.workspace),
      `${basePath}.workspace`,
    ),
    session: readSessionConfig(readRecord(root.session), `${basePath}.session`),
    clients: readClientsConfig(readRecord(root.clients), `${basePath}.clients`),
    service: normalizeServiceConfig(
      readServiceConfig(readRecord(root.service), `${basePath}.service`),
    ),
    integrations: readIntegrationsConfig(
      readRecord(root.integrations),
      `${basePath}.integrations`,
    ),
    agents: readAgentsConfig(readRecord(root.agents), `${basePath}.agents`),
  });
}

function convertLegacyConfigToCanonical(input: {
  defaults: LegacyStepCliConfigDefaults;
  modelsProxy?: ModelsProxyConfig;
  service?: ServiceConfig;
  agentPresets?: AgentPresetConfig[];
  mcpServers?: Record<string, McpServerConfig>;
  tui?: StepCliTuiScrollConfig;
}): ConfigFile {
  const model = compactObject<ModelConfig>({
    model: input.defaults.model,
    provider: input.defaults.provider,
    baseUrl: input.defaults.baseUrl,
    apiKey: input.defaults.apiKey,
    timeoutMs: input.defaults.timeoutMs,
    reasoning: compactObject({
      anthropicThinkingBudgetTokens:
        input.defaults.anthropicThinkingBudgetTokens,
      openaiReasoningEffort: input.defaults.openaiReasoningEffort,
    }),
    tokens: compactObject({
      maxContext: input.defaults.maxContextTokens,
      maxOutput: input.defaults.maxOutputTokens,
      minOutput: input.defaults.minOutputTokens,
      outputSafetyMargin: input.defaults.outputTokenSafetyMargin,
    }),
  });
  const agent = compactObject<AgentConfig>({
    mode: input.defaults.mode,
    systemPromptProfile: input.defaults.systemPromptProfile,
    maxSteps: input.defaults.maxSteps,
    maxUserClarificationsPerTurn: input.defaults.maxUserClarificationsPerTurn,
    temperature: input.defaults.temperature,
    retries: compactObject({
      modelRequest: input.defaults.modelRequestRetries,
      toolExecution: input.defaults.toolExecutionRetries,
    }),
  });
  const tools = compactObject<ToolsConfig>({
    codeMode: input.defaults.codeMode,
    parallelCalls: input.defaults.parallelToolCalls,
    maxCallsPerStep: input.defaults.maxToolCallsPerStep,
    repeatedCallLimit: input.defaults.repeatedToolCallLimit,
    maxResultContextChars: input.defaults.maxToolResultContextChars,
    commandTimeoutMs: input.defaults.commandTimeoutMs,
    commandOutputLimit: input.defaults.commandOutputLimit,
    approval: compactObject({
      mode: input.defaults.approvalMode,
      nonInteractive: input.defaults.nonInteractiveApproval,
      overrides: input.defaults.toolOverride,
    }),
    presentation: compactObject({
      profile: input.defaults.toolPresentationProfile,
      aliasSeed: input.defaults.toolAliasSeed,
      descriptionStyle: input.defaults.toolDescriptionStyle,
      searchIndexProfile: input.defaults.toolSearchIndexProfile,
    }),
  });
  const workspace = compactObject<WorkspaceConfig>({
    pluginsDir: input.defaults.pluginsDir,
    skillsDirName: input.defaults.skillsDir,
  });
  const session = compactObject<SessionConfig>({
    autosave: input.defaults.sessionAutosave,
  });
  const clients = compactObject<ClientsConfig>({
    tui:
      input.defaults.altScreen !== undefined || input.tui
        ? compactObject({
            altScreen: input.defaults.altScreen,
            scroll: input.tui,
          })
        : undefined,
  });
  const integrations = compactObject<IntegrationsConfig>({
    modelsProxy: input.modelsProxy,
    mcp: compactObject(
      input.mcpServers !== undefined
        ? {
            servers: input.mcpServers,
          }
        : {},
    ),
  });
  const agents = compactObject<AgentsConfig>({
    presets: input.agentPresets,
  });

  return compactConfigFile({
    model,
    agent,
    tools,
    storage: input.defaults.storage,
    workspace,
    session,
    clients,
    service: input.service,
    integrations,
    agents,
  });
}

function compactConfigFile(config: ConfigFile): ConfigFile {
  return compactObject(config) ?? {};
}

function compactObject<T extends object>(value: T): T | undefined {
  const compact = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([, entry]) => entry !== undefined,
    ),
  ) as T;
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function readModelConfig(
  source: Record<string, unknown> | undefined,
  basePath: string,
): ModelConfig | undefined {
  if (!source) {
    return undefined;
  }

  const model = compactObject<ModelConfig>({
    model: readOptionalString(source.model ?? source.id),
    provider: readProvider(source.provider, `${basePath}.provider`),
    baseUrl: readOptionalString(source.baseUrl),
    apiKey: readOptionalString(source.apiKey),
    timeoutMs: readPositiveInt(source.timeoutMs, `${basePath}.timeoutMs`),
    reasoning: compactObject({
      anthropicThinkingBudgetTokens: readAnthropicThinkingBudgetTokens(
        readRecord(source.reasoning)?.anthropicThinkingBudgetTokens,
        `${basePath}.reasoning.anthropicThinkingBudgetTokens`,
      ),
      openaiReasoningEffort: readOpenAIReasoningEffort(
        readRecord(source.reasoning)?.openaiReasoningEffort,
        `${basePath}.reasoning.openaiReasoningEffort`,
      ),
    }),
    tokens: compactObject({
      maxContext: readPositiveInt(
        readRecord(source.tokens)?.maxContext,
        `${basePath}.tokens.maxContext`,
      ),
      maxOutput: readPositiveInt(
        readRecord(source.tokens)?.maxOutput,
        `${basePath}.tokens.maxOutput`,
      ),
      minOutput: readPositiveInt(
        readRecord(source.tokens)?.minOutput,
        `${basePath}.tokens.minOutput`,
      ),
      outputSafetyMargin: readPositiveInt(
        readRecord(source.tokens)?.outputSafetyMargin,
        `${basePath}.tokens.outputSafetyMargin`,
      ),
    }),
  });

  return model;
}

function readAgentConfig(
  source: Record<string, unknown> | undefined,
  basePath: string,
): AgentConfig | undefined {
  if (!source) {
    return undefined;
  }

  return compactObject<AgentConfig>({
    mode: readOperatingMode(source.mode, `${basePath}.mode`),
    systemPromptProfile: readSystemPromptProfile(
      source.systemPromptProfile,
      `${basePath}.systemPromptProfile`,
    ),
    maxSteps: readConfiguredMaxSteps(source.maxSteps, `${basePath}.maxSteps`),
    maxUserClarificationsPerTurn: readNonNegativeInt(
      source.maxUserClarificationsPerTurn,
      `${basePath}.maxUserClarificationsPerTurn`,
    ),
    temperature: readFiniteNumber(
      source.temperature,
      `${basePath}.temperature`,
    ),
    retries: compactObject({
      modelRequest: readNonNegativeInt(
        readRecord(source.retries)?.modelRequest,
        `${basePath}.retries.modelRequest`,
      ),
      toolExecution: readNonNegativeInt(
        readRecord(source.retries)?.toolExecution,
        `${basePath}.retries.toolExecution`,
      ),
    }),
  });
}

function readToolsConfig(
  source: Record<string, unknown> | undefined,
  basePath: string,
): ToolsConfig | undefined {
  if (!source) {
    return undefined;
  }

  return compactObject<ToolsConfig>({
    codeMode: readOptionalBoolean(source.codeMode, `${basePath}.codeMode`),
    parallelCalls: readOptionalBoolean(
      source.parallelCalls,
      `${basePath}.parallelCalls`,
    ),
    maxCallsPerStep: readPositiveInt(
      source.maxCallsPerStep,
      `${basePath}.maxCallsPerStep`,
    ),
    repeatedCallLimit: readPositiveInt(
      source.repeatedCallLimit,
      `${basePath}.repeatedCallLimit`,
    ),
    maxResultContextChars: readPositiveInt(
      source.maxResultContextChars,
      `${basePath}.maxResultContextChars`,
    ),
    commandTimeoutMs: readPositiveInt(
      source.commandTimeoutMs,
      `${basePath}.commandTimeoutMs`,
    ),
    commandOutputLimit: readPositiveInt(
      source.commandOutputLimit,
      `${basePath}.commandOutputLimit`,
    ),
    approval: readToolApprovalConfig(
      readRecord(source.approval),
      `${basePath}.approval`,
    ),
    presentation: readToolPresentationConfig(
      readRecord(source.presentation),
      `${basePath}.presentation`,
    ),
  });
}

function readToolApprovalConfig(
  source: Record<string, unknown> | undefined,
  basePath: string,
): ToolsConfig["approval"] | undefined {
  if (!source) {
    return undefined;
  }

  return compactObject({
    mode: readApprovalMode(source.mode, `${basePath}.mode`),
    nonInteractive: readNonInteractiveApproval(
      source.nonInteractive,
      `${basePath}.nonInteractive`,
    ),
    overrides: readToolOverrides(source.overrides, `${basePath}.overrides`),
  });
}

function readToolPresentationConfig(
  source: Record<string, unknown> | undefined,
  basePath: string,
): ToolsConfig["presentation"] | undefined {
  if (!source) {
    return undefined;
  }

  return compactObject({
    profile: readToolPresentationProfile(source.profile, `${basePath}.profile`),
    aliasSeed: readOptionalString(source.aliasSeed),
    descriptionStyle: readToolDescriptionStyle(
      source.descriptionStyle,
      `${basePath}.descriptionStyle`,
    ),
    searchIndexProfile: readToolSearchIndexProfile(
      source.searchIndexProfile,
      `${basePath}.searchIndexProfile`,
    ),
  });
}

function readStructuredStorageConfig(
  source: Record<string, unknown> | undefined,
  basePath: string,
): StorageConfig | undefined {
  if (!source) {
    return undefined;
  }

  return compactObject<StorageConfig>({
    rootDir: readStorageRootDir(source.rootDir ?? source.root_dir),
    layout: readStorageLayoutConfig(
      readRecord(source.layout),
      `${basePath}.layout`,
    ),
  });
}

function readStorageLayoutConfig(
  source: Record<string, unknown> | undefined,
  basePath: string,
): StorageLayoutConfig | undefined {
  if (!source) {
    return undefined;
  }

  if ("sessionsDir" in source || "sessions_dir" in source) {
    throw new Error(
      `Session events are always stored at {rootDir}/sessions/{sessionId}/events.jsonl; remove ${basePath}.sessionsDir`,
    );
  }
  if ("sessionEventsFile" in source || "session_events_file" in source) {
    throw new Error(
      `Session events are always stored at {rootDir}/sessions/{sessionId}/events.jsonl; remove ${basePath}.sessionEventsFile`,
    );
  }

  return compactObject<StorageLayoutConfig>({
    workspaceTrustFile: readRelativeStoragePath(
      source.workspaceTrustFile ?? source.workspace_trust_file,
      `${basePath}.workspaceTrustFile`,
    ),
    teamInboxDir: readRelativeStoragePath(
      source.teamInboxDir ?? source.team_inbox_dir,
      `${basePath}.teamInboxDir`,
    ),
    themesDir: readRelativeStoragePath(
      source.themesDir ?? source.themes_dir ?? source.themes,
      `${basePath}.themesDir`,
    ),
    sessionAssetsDir: readRelativeStoragePath(
      source.sessionAssetsDir ?? source.session_assets_dir,
      `${basePath}.sessionAssetsDir`,
    ),
    sessionProgressDir: readRelativeStoragePath(
      source.sessionProgressDir ?? source.session_progress_dir,
      `${basePath}.sessionProgressDir`,
    ),
    sessionProgressFile: readRelativeStoragePath(
      source.sessionProgressFile ?? source.session_progress_file,
      `${basePath}.sessionProgressFile`,
    ),
    sessionArtifactsDir: readRelativeStoragePath(
      source.sessionArtifactsDir ?? source.session_artifacts_dir,
      `${basePath}.sessionArtifactsDir`,
    ),
    sessionTranscriptsDir: readRelativeStoragePath(
      source.sessionTranscriptsDir ?? source.session_transcripts_dir,
      `${basePath}.sessionTranscriptsDir`,
    ),
    sessionTeamInboxDir: readRelativeStoragePath(
      source.sessionTeamInboxDir ?? source.session_team_inbox_dir,
      `${basePath}.sessionTeamInboxDir`,
    ),
    sessionTraceDir: readRelativeStoragePath(
      source.sessionTraceDir ?? source.session_trace_dir,
      `${basePath}.sessionTraceDir`,
    ),
  });
}

function readWorkspaceConfig(
  source: Record<string, unknown> | undefined,
  _basePath: string,
): WorkspaceConfig | undefined {
  if (!source) {
    return undefined;
  }

  return compactObject<WorkspaceConfig>({
    pluginsDir: readOptionalString(source.pluginsDir),
    skillsDirName: readOptionalString(
      source.skillsDirName ?? source.skills_dir_name,
    ),
  });
}

function readSessionConfig(
  source: Record<string, unknown> | undefined,
  basePath: string,
): SessionConfig | undefined {
  if (!source) {
    return undefined;
  }

  return compactObject<SessionConfig>({
    autosave: readOptionalBoolean(source.autosave, `${basePath}.autosave`),
    trace: compactObject({
      enabled: readOptionalBoolean(
        readRecord(source.trace)?.enabled,
        `${basePath}.trace.enabled`,
      ),
      keepLast: readPositiveInt(
        readRecord(source.trace)?.keepLast,
        `${basePath}.trace.keepLast`,
      ),
      maxBodyBytes: readPositiveInt(
        readRecord(source.trace)?.maxBodyBytes,
        `${basePath}.trace.maxBodyBytes`,
      ),
      headerInjectionBaseUrls: readStringArray(
        readRecord(source.trace)?.headerInjectionBaseUrls,
        `${basePath}.trace.headerInjectionBaseUrls`,
      ),
    }),
  });
}

function readClientsConfig(
  source: Record<string, unknown> | undefined,
  basePath: string,
): ClientsConfig | undefined {
  if (!source) {
    return undefined;
  }

  const tuiRecord = readRecord(source.tui);
  return compactObject<ClientsConfig>({
    tui: tuiRecord
      ? compactObject({
          altScreen: readOptionalBoolean(
            tuiRecord.altScreen,
            `${basePath}.tui.altScreen`,
          ),
          scroll: readTuiConfig(
            readRecord(tuiRecord.scroll) ?? tuiRecord,
            `${basePath}.tui.scroll`,
          ),
        })
      : undefined,
  });
}

function readIntegrationsConfig(
  source: Record<string, unknown> | undefined,
  basePath: string,
): IntegrationsConfig | undefined {
  if (!source) {
    return undefined;
  }

  const mcpSource = readRecord(source.mcp);
  const mcpServersSource =
    readRecord(mcpSource?.servers) ??
    (mcpSource && !("servers" in mcpSource) ? mcpSource : undefined);

  return compactObject<IntegrationsConfig>({
    modelsProxy: readModelsProxyConfig(
      readRecord(source.modelsProxy),
      `${basePath}.modelsProxy`,
    ),
    mcp: compactObject(
      mcpServersSource !== undefined
        ? {
            servers: readMcpServers(
              mcpServersSource,
              `${basePath}.mcp.servers`,
            ),
          }
        : {},
    ),
  });
}

function readAgentsConfig(
  source: Record<string, unknown> | undefined,
  basePath: string,
): AgentsConfig | undefined {
  if (!source) {
    return undefined;
  }

  return compactObject<AgentsConfig>({
    presets: readAgentPresets(source.presets, `${basePath}.presets`),
  });
}

function readLegacyConfigDefaults(
  source: Record<string, unknown> | undefined,
  basePath: string,
): LegacyStepCliConfigDefaults {
  if (!source) {
    return {};
  }

  if ("storageRootDir" in source || "storageRoot" in source) {
    throw new Error(
      `Use ${basePath}.storage.rootDir instead of ${basePath}.storageRootDir`,
    );
  }
  if ("storageLayout" in source || "storage_layout" in source) {
    throw new Error(
      `Use ${basePath}.storage instead of ${basePath}.storageLayout`,
    );
  }

  return {
    mode: readOperatingMode(source.mode, `${basePath}.mode`),
    systemPromptProfile: readSystemPromptProfile(
      source.systemPromptProfile,
      `${basePath}.systemPromptProfile`,
    ),
    codeMode: readOptionalBoolean(
      source.codeMode ?? source.code_mode,
      `${basePath}.codeMode`,
    ),
    toolPresentationProfile: readToolPresentationProfile(
      source.toolPresentationProfile,
      `${basePath}.toolPresentationProfile`,
    ),
    toolAliasSeed: readOptionalString(source.toolAliasSeed),
    toolDescriptionStyle: readToolDescriptionStyle(
      source.toolDescriptionStyle,
      `${basePath}.toolDescriptionStyle`,
    ),
    toolSearchIndexProfile: readToolSearchIndexProfile(
      source.toolSearchIndexProfile,
      `${basePath}.toolSearchIndexProfile`,
    ),
    model: readOptionalString(source.model),
    provider: readProvider(source.provider, `${basePath}.provider`),
    baseUrl: readOptionalString(source.baseUrl),
    apiKey: readOptionalString(source.apiKey),
    anthropicThinkingBudgetTokens: readAnthropicThinkingBudgetTokens(
      source.anthropicThinkingBudgetTokens,
      `${basePath}.anthropicThinkingBudgetTokens`,
    ),
    openaiReasoningEffort: readOpenAIReasoningEffort(
      source.openaiReasoningEffort,
      `${basePath}.openaiReasoningEffort`,
    ),
    maxUserClarificationsPerTurn: readNonNegativeInt(
      source.maxUserClarificationsPerTurn,
      `${basePath}.maxUserClarificationsPerTurn`,
    ),
    maxSteps: readConfiguredMaxSteps(source.maxSteps, `${basePath}.maxSteps`),
    maxToolCallsPerStep: readPositiveInt(
      source.maxToolCallsPerStep,
      `${basePath}.maxToolCallsPerStep`,
    ),
    maxContextTokens: readPositiveInt(
      source.maxContextTokens,
      `${basePath}.maxContextTokens`,
    ),
    maxOutputTokens: readPositiveInt(
      source.maxOutputTokens,
      `${basePath}.maxOutputTokens`,
    ),
    minOutputTokens: readPositiveInt(
      source.minOutputTokens,
      `${basePath}.minOutputTokens`,
    ),
    outputTokenSafetyMargin: readPositiveInt(
      source.outputTokenSafetyMargin,
      `${basePath}.outputTokenSafetyMargin`,
    ),
    parallelToolCalls: readOptionalBoolean(
      source.parallelToolCalls,
      `${basePath}.parallelToolCalls`,
    ),
    temperature: readFiniteNumber(
      source.temperature,
      `${basePath}.temperature`,
    ),
    timeoutMs: readPositiveInt(source.timeoutMs, `${basePath}.timeoutMs`),
    commandTimeoutMs: readPositiveInt(
      source.commandTimeoutMs,
      `${basePath}.commandTimeoutMs`,
    ),
    commandOutputLimit: readPositiveInt(
      source.commandOutputLimit,
      `${basePath}.commandOutputLimit`,
    ),
    repeatedToolCallLimit: readPositiveInt(
      source.repeatedToolCallLimit,
      `${basePath}.repeatedToolCallLimit`,
    ),
    modelRequestRetries: readNonNegativeInt(
      source.modelRequestRetries,
      `${basePath}.modelRequestRetries`,
    ),
    toolExecutionRetries: readNonNegativeInt(
      source.toolExecutionRetries,
      `${basePath}.toolExecutionRetries`,
    ),
    maxToolResultContextChars: readPositiveInt(
      source.maxToolResultContextChars,
      `${basePath}.maxToolResultContextChars`,
    ),
    approvalMode: readApprovalMode(
      source.approvalMode,
      `${basePath}.approvalMode`,
    ),
    nonInteractiveApproval: readNonInteractiveApproval(
      source.nonInteractiveApproval,
      `${basePath}.nonInteractiveApproval`,
    ),
    toolOverride:
      readToolOverrides(source.toolOverride, `${basePath}.toolOverride`) ??
      readToolOverrides(source.toolOverrides, `${basePath}.toolOverrides`) ??
      readToolOverrides(
        source.toolPermissionOverrides,
        `${basePath}.toolPermissionOverrides`,
      ),
    pluginsDir: readOptionalString(source.pluginsDir),
    skillsDir: readOptionalString(source.skillsDir),
    storage: readStorageConfig(
      readRecord(source.storage),
      `${basePath}.storage`,
    ),
    sessionFile: readOptionalString(source.sessionFile),
    sessionAutosave: readOptionalBoolean(
      source.sessionAutosave,
      `${basePath}.sessionAutosave`,
    ),
    altScreen: readOptionalBoolean(source.altScreen, `${basePath}.altScreen`),
  };
}

function readModelsProxyConfig(
  source: Record<string, unknown> | undefined,
  basePath: string,
): ModelsProxyConfig | undefined {
  if (!source) {
    return undefined;
  }

  const modelsProxy: ModelsProxyConfig = {
    baseUrl: readOptionalString(source.baseUrl),
    apiKey: readOptionalString(source.apiKey),
    api: readOptionalString(source.api),
    models: readModelIdArray(source.models, `${basePath}.models`),
  };

  return Object.values(modelsProxy).some((value) => value !== undefined)
    ? modelsProxy
    : undefined;
}

function readServiceConfig(
  source: Record<string, unknown> | undefined,
  basePath: string,
): ServiceConfig | undefined {
  if (!source) {
    return undefined;
  }

  if (
    "storageRootDir" in source ||
    "storageRoot" in source ||
    "sessionDir" in source ||
    "sessionsDir" in source
  ) {
    throw new Error(
      `Use config.defaults.storage.rootDir instead of ${basePath}.storageRootDir or ${basePath}.sessionDir`,
    );
  }

  const service: ServiceConfig = {
    host: readOptionalString(source.host),
    port: readPositiveInt(source.port, `${basePath}.port`),
    token: readOptionalString(source.token),
  };

  return Object.values(service).some((value) => value !== undefined)
    ? service
    : undefined;
}

function normalizeServiceConfig(
  service: ServiceConfig | undefined,
): ServiceConfig | undefined {
  if (!service) {
    return service;
  }

  const normalized: ServiceConfig = {
    host: service.host,
    port: service.port,
    token: service.token,
  };
  const compact = Object.fromEntries(
    Object.entries(normalized).filter(([, value]) => value !== undefined),
  ) as ServiceConfig;

  return Object.keys(compact).length > 0 ? compact : undefined;
}

function readMcpServers(
  source: Record<string, unknown> | undefined,
  basePath: string,
): Record<string, McpServerConfig> | undefined {
  if (!source) {
    return undefined;
  }

  const servers: Record<string, McpServerConfig> = {};

  for (const [serverName, rawConfig] of Object.entries(source)) {
    const entryPath = `${basePath}.${serverName}`;
    const record = readRecord(rawConfig);
    if (!record) {
      throw new Error(`Expected ${entryPath} to be an object`);
    }

    const type = readMcpTransportType(record.type, `${entryPath}.type`);
    const command = readOptionalString(record.command);
    if (!command) {
      throw new Error(`Expected ${entryPath}.command to be a non-empty string`);
    }

    servers[serverName] = {
      type: type ?? "stdio",
      command,
      args: readStringArray(record.args, `${entryPath}.args`),
      cwd: readOptionalString(record.cwd),
      env: readStringMap(record.env, `${entryPath}.env`),
      enabled: readOptionalBoolean(record.enabled, `${entryPath}.enabled`),
      timeoutMs: readPositiveInt(record.timeoutMs, `${entryPath}.timeoutMs`),
      toolPrefix: readOptionalString(record.toolPrefix),
      includeTools: readStringArray(
        record.includeTools,
        `${entryPath}.includeTools`,
      ),
      excludeTools: readStringArray(
        record.excludeTools,
        `${entryPath}.excludeTools`,
      ),
      risk: readToolRisk(record.risk, `${entryPath}.risk`),
      defaultMode: readToolPermissionMode(
        record.defaultMode,
        `${entryPath}.defaultMode`,
      ),
    };
  }

  return Object.keys(servers).length > 0 ? servers : undefined;
}

function mergeConfigFile(base: ConfigFile, override: ConfigFile): ConfigFile {
  return compactConfigFile({
    model: mergeModelConfig(base.model, override.model),
    agent: mergeAgentConfig(base.agent, override.agent),
    tools: mergeToolsConfig(base.tools, override.tools),
    storage: mergeStorageConfig(base.storage, override.storage),
    workspace: mergeWorkspaceConfig(base.workspace, override.workspace),
    session: mergeSessionConfig(base.session, override.session),
    clients: mergeClientsConfig(base.clients, override.clients),
    service: mergeServiceConfig(base.service, override.service),
    integrations: mergeIntegrationsConfig(
      base.integrations,
      override.integrations,
    ),
    agents: mergeAgentsConfig(base.agents, override.agents),
  });
}

function mergeModelConfig(
  base: ModelConfig | undefined,
  override: ModelConfig | undefined,
): ModelConfig | undefined {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  return compactObject({
    ...mergeDefinedFields(base, override),
    reasoning: compactObject(
      mergeDefinedFields(base.reasoning ?? {}, override.reasoning ?? {}),
    ),
    tokens: compactObject(
      mergeDefinedFields(base.tokens ?? {}, override.tokens ?? {}),
    ),
  });
}

function mergeAgentConfig(
  base: AgentConfig | undefined,
  override: AgentConfig | undefined,
): AgentConfig | undefined {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  return compactObject({
    ...mergeDefinedFields(base, override),
    retries: compactObject(
      mergeDefinedFields(base.retries ?? {}, override.retries ?? {}),
    ),
  });
}

function mergeToolsConfig(
  base: ToolsConfig | undefined,
  override: ToolsConfig | undefined,
): ToolsConfig | undefined {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  return compactObject({
    ...mergeDefinedFields(base, override),
    approval: compactObject({
      ...mergeDefinedFields(base.approval ?? {}, override.approval ?? {}),
      overrides: mergeToolOverrides(
        base.approval?.overrides,
        override.approval?.overrides,
      ),
    }),
    presentation: compactObject(
      mergeDefinedFields(base.presentation ?? {}, override.presentation ?? {}),
    ),
  });
}

function mergeTuiConfig(
  base: StepCliTuiScrollConfig | undefined,
  override: StepCliTuiScrollConfig | undefined,
): StepCliTuiScrollConfig | undefined {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  return {
    scrollSpeed: override.scrollSpeed ?? base.scrollSpeed,
    scrollAcceleration:
      base.scrollAcceleration || override.scrollAcceleration
        ? {
            enabled:
              override.scrollAcceleration?.enabled ??
              base.scrollAcceleration?.enabled,
          }
        : undefined,
  };
}

function mergeModelsProxy(
  base: ModelsProxyConfig | undefined,
  override: ModelsProxyConfig | undefined,
): ModelsProxyConfig | undefined {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  return mergeDefinedFields(base, override);
}

function mergeServiceConfig(
  base: ServiceConfig | undefined,
  override: ServiceConfig | undefined,
): ServiceConfig | undefined {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  return mergeDefinedFields(base, override);
}

function mergeWorkspaceConfig(
  base: WorkspaceConfig | undefined,
  override: WorkspaceConfig | undefined,
): WorkspaceConfig | undefined {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  return mergeDefinedFields(base, override);
}

function mergeSessionConfig(
  base: SessionConfig | undefined,
  override: SessionConfig | undefined,
): SessionConfig | undefined {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  return mergeDefinedFields(base, override);
}

function mergeClientsConfig(
  base: ClientsConfig | undefined,
  override: ClientsConfig | undefined,
): ClientsConfig | undefined {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  return compactObject({
    tui:
      base.tui || override.tui
        ? compactObject({
            altScreen: override.tui?.altScreen ?? base.tui?.altScreen,
            scroll: mergeTuiConfig(base.tui?.scroll, override.tui?.scroll),
          })
        : undefined,
  });
}

function mergeAgentsConfig(
  base: AgentsConfig | undefined,
  override: AgentsConfig | undefined,
): AgentsConfig | undefined {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  return compactObject({
    presets: mergeAgentPresets(base.presets, override.presets),
  });
}

function mergeAgentPresets(
  base: AgentPresetConfig[] | undefined,
  override: AgentPresetConfig[] | undefined,
): AgentPresetConfig[] | undefined {
  if (!base) {
    return override ? [...override] : undefined;
  }

  if (!override) {
    return [...base];
  }

  const merged = new Map<string, AgentPresetConfig>();
  for (const preset of base) {
    merged.set(
      `${preset.targetHarnessKind}:${preset.name}`,
      structuredClone(preset),
    );
  }
  for (const preset of override) {
    merged.set(`${preset.targetHarnessKind}:${preset.name}`, preset);
  }

  return [...merged.values()];
}

function mergeMcpServers(
  base: Record<string, McpServerConfig> | undefined,
  override: Record<string, McpServerConfig> | undefined,
): Record<string, McpServerConfig> | undefined {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  const merged: Record<string, McpServerConfig> = { ...base };

  for (const [serverName, config] of Object.entries(override)) {
    const current = merged[serverName];
    if (!current) {
      merged[serverName] = config;
      continue;
    }

    const next: McpServerConfig = { ...current };
    for (const [field, value] of Object.entries(config) as Array<
      [keyof McpServerConfig, McpServerConfig[keyof McpServerConfig]]
    >) {
      if (field === "env" || value === undefined) {
        continue;
      }
      Object.assign(next, {
        [field]: value,
      } as Partial<McpServerConfig>);
    }

    next.env =
      current.env || config.env
        ? {
            ...current.env,
            ...config.env,
          }
        : undefined;

    merged[serverName] = next;
  }

  return merged;
}

function mergeToolOverrides(
  base: Record<string, "allow" | "confirm" | "deny"> | undefined,
  override: Record<string, "allow" | "confirm" | "deny"> | undefined,
): Record<string, "allow" | "confirm" | "deny"> | undefined {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  return {
    ...base,
    ...override,
  };
}

function mergeStorageConfig(
  base: StorageConfig | undefined,
  override: StorageConfig | undefined,
): StorageConfig | undefined {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  return compactObject({
    rootDir: override.rootDir ?? base.rootDir,
    layout: compactObject(
      mergeDefinedFields(base.layout ?? {}, override.layout ?? {}),
    ),
  });
}

function mergeIntegrationsConfig(
  base: IntegrationsConfig | undefined,
  override: IntegrationsConfig | undefined,
): IntegrationsConfig | undefined {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  return compactObject({
    modelsProxy: mergeModelsProxy(base.modelsProxy, override.modelsProxy),
    mcp: compactObject(
      base.mcp || override.mcp
        ? {
            servers: mergeMcpServers(base.mcp?.servers, override.mcp?.servers),
          }
        : {},
    ),
  });
}

function mergeDefinedFields<T extends object>(
  base: T,
  override: Partial<T>,
): T {
  const merged: Record<string, unknown> = {
    ...(base as Record<string, unknown>),
  };

  for (const [key, value] of Object.entries(
    override as Record<string, unknown>,
  )) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  return merged as T;
}

function readStorageConfig(
  source: Record<string, unknown> | undefined,
  basePath: string,
): StorageConfig | undefined {
  if (!source) {
    return undefined;
  }

  if ("sessionsDir" in source || "sessions_dir" in source) {
    throw new Error(
      `Session events are always stored at {rootDir}/sessions/{sessionId}/events.jsonl; remove ${basePath}.sessionsDir`,
    );
  }
  if ("sessionEventsFile" in source || "session_events_file" in source) {
    throw new Error(
      `Session events are always stored at {rootDir}/sessions/{sessionId}/events.jsonl; remove ${basePath}.sessionEventsFile`,
    );
  }

  const storage: StorageConfig = {
    rootDir: readStorageRootDir(source.rootDir ?? source.root_dir),
    layout: compactObject<StorageLayoutConfig>({
      workspaceTrustFile: readRelativeStoragePath(
        source.workspaceTrustFile ?? source.workspace_trust_file,
        `${basePath}.workspaceTrustFile`,
      ),
      teamInboxDir: readRelativeStoragePath(
        source.teamInboxDir ?? source.team_inbox_dir,
        `${basePath}.teamInboxDir`,
      ),
      themesDir: readRelativeStoragePath(
        source.themesDir ?? source.themes_dir ?? source.themes,
        `${basePath}.themesDir`,
      ),
      sessionAssetsDir: readRelativeStoragePath(
        source.sessionAssetsDir ?? source.session_assets_dir,
        `${basePath}.sessionAssetsDir`,
      ),
      sessionProgressDir: readRelativeStoragePath(
        source.sessionProgressDir ?? source.session_progress_dir,
        `${basePath}.sessionProgressDir`,
      ),
      sessionProgressFile: readRelativeStoragePath(
        source.sessionProgressFile ?? source.session_progress_file,
        `${basePath}.sessionProgressFile`,
      ),
      sessionArtifactsDir: readRelativeStoragePath(
        source.sessionArtifactsDir ?? source.session_artifacts_dir,
        `${basePath}.sessionArtifactsDir`,
      ),
      sessionTranscriptsDir: readRelativeStoragePath(
        source.sessionTranscriptsDir ?? source.session_transcripts_dir,
        `${basePath}.sessionTranscriptsDir`,
      ),
      sessionTeamInboxDir: readRelativeStoragePath(
        source.sessionTeamInboxDir ?? source.session_team_inbox_dir,
        `${basePath}.sessionTeamInboxDir`,
      ),
      sessionTraceDir: readRelativeStoragePath(
        source.sessionTraceDir ?? source.session_trace_dir,
        `${basePath}.sessionTraceDir`,
      ),
    }),
  };
  return compactObject(storage);
}

function readStorageRootDir(value: unknown): string | undefined {
  return readOptionalString(value);
}

function readProvider(
  value: unknown,
  fieldPath: string,
): "openai" | "response" | "anthropic" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "openai" || value === "response" || value === "anthropic") {
    return value;
  }
  throw new Error(
    `Unsupported provider at ${fieldPath}: ${String(value)}. Expected openai, response, or anthropic.`,
  );
}

function readRelativeStoragePath(
  value: unknown,
  fieldPath: string,
): string | undefined {
  const targetPath = readOptionalString(value);
  if (!targetPath) {
    return undefined;
  }

  if (
    targetPath === "~" ||
    targetPath.startsWith("~/") ||
    targetPath.startsWith("~\\") ||
    path.isAbsolute(targetPath) ||
    path.win32.isAbsolute(targetPath)
  ) {
    throw new Error(
      `Expected ${fieldPath} to be a relative path under storageRootDir`,
    );
  }

  const normalized = path.normalize(targetPath);
  const slashNormalized = normalized.replace(/\\/g, "/");
  if (
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    slashNormalized === ".." ||
    slashNormalized.startsWith("../")
  ) {
    throw new Error(
      `Expected ${fieldPath} to stay within storageRootDir: ${targetPath}`,
    );
  }

  return normalized;
}

function readOperatingMode(
  value: unknown,
  fieldPath: string,
): "normal" | "plan" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "normal" || value === "plan") {
    return value;
  }
  throw new Error(
    `Unsupported operating mode at ${fieldPath}: ${String(value)}. Expected normal or plan.`,
  );
}

function readSystemPromptProfile(
  value: unknown,
  fieldPath: string,
): "default" | "minimal" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "default" || value === "minimal") {
    return value;
  }
  throw new Error(
    `Unsupported systemPromptProfile at ${fieldPath}: ${String(value)}. Expected default or minimal.`,
  );
}

function readToolPresentationProfile(
  value: unknown,
  fieldPath: string,
): "grouped" | "raw" | "obfuscated" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "string") {
    const parsed = parseToolPresentationProfile(value);
    if (parsed) {
      return parsed;
    }
  }
  throw new Error(
    `Unsupported toolPresentationProfile at ${fieldPath}: ${String(value)}. Expected ${describeToolPresentationProfileOptions()}. Legacy aliases compact and canonical are also accepted.`,
  );
}

function readToolDescriptionStyle(
  value: unknown,
  fieldPath: string,
): "canonical" | "simple" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "canonical" || value === "simple") {
    return value;
  }
  throw new Error(
    `Unsupported toolDescriptionStyle at ${fieldPath}: ${String(value)}. Expected canonical or simple.`,
  );
}

function readToolSearchIndexProfile(
  value: unknown,
  fieldPath: string,
): "presented" | "canonical" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "presented" || value === "canonical") {
    return value;
  }
  throw new Error(
    `Unsupported toolSearchIndexProfile at ${fieldPath}: ${String(value)}. Expected presented or canonical.`,
  );
}

function readApprovalMode(
  value: unknown,
  fieldPath: string,
): "confirm" | "auto" | "strict" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "confirm" || value === "auto" || value === "strict") {
    return value;
  }
  throw new Error(
    `Unsupported approval mode at ${fieldPath}: ${String(value)}. Expected confirm, auto, or strict.`,
  );
}

function readNonInteractiveApproval(
  value: unknown,
  fieldPath: string,
): "allow" | "deny" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "allow" || value === "deny") {
    return value;
  }
  throw new Error(
    `Unsupported nonInteractiveApproval at ${fieldPath}: ${String(value)}. Expected allow or deny.`,
  );
}

function readMcpTransportType(
  value: unknown,
  fieldPath: string,
): "stdio" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "stdio") {
    return value;
  }
  throw new Error(
    `Unsupported MCP transport at ${fieldPath}: ${String(value)}. Expected stdio.`,
  );
}

function readToolRisk(
  value: unknown,
  fieldPath: string,
): "meta" | "read" | "write" | "execute" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (
    value === "meta" ||
    value === "read" ||
    value === "write" ||
    value === "execute"
  ) {
    return value;
  }
  throw new Error(
    `Unsupported tool risk at ${fieldPath}: ${String(value)}. Expected meta, read, write, or execute.`,
  );
}

function readToolPermissionMode(
  value: unknown,
  fieldPath: string,
): "allow" | "confirm" | "deny" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "allow" || value === "confirm" || value === "deny") {
    return value;
  }
  throw new Error(
    `Unsupported tool permission mode at ${fieldPath}: ${String(value)}. Expected allow, confirm, or deny.`,
  );
}

function readToolOverrides(
  value: unknown,
  fieldPath: string,
): Record<string, "allow" | "confirm" | "deny"> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const record = readRecord(value);
  if (!record) {
    throw new Error(
      `Expected ${fieldPath} to be an object mapping tool names to allow|confirm|deny`,
    );
  }

  const overrides: Record<string, "allow" | "confirm" | "deny"> = {};
  for (const [toolName, mode] of Object.entries(record)) {
    if (mode !== "allow" && mode !== "confirm" && mode !== "deny") {
      throw new Error(
        `Unsupported tool override at ${fieldPath}.${toolName}: ${String(mode)}`,
      );
    }
    overrides[toolName] = mode;
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function readAgentPresets(
  value: unknown,
  fieldPath: string,
): AgentPresetConfig[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Expected ${fieldPath} to be an array`);
  }

  const presets = value.map((entry, index) =>
    readAgentPreset(entry, `${fieldPath}[${index}]`),
  );
  return presets.length > 0 ? presets : undefined;
}

function readAgentPreset(value: unknown, fieldPath: string): AgentPresetConfig {
  const record = readRecord(value);
  if (!record) {
    throw new Error(`Expected ${fieldPath} to be an object`);
  }

  const name = readOptionalString(record.name);
  if (!name) {
    throw new Error(`Expected ${fieldPath}.name to be a non-empty string`);
  }

  const targetHarnessKind = readAgentPresetTargetHarnessKind(
    record.targetHarnessKind ?? record.target_harness_kind,
    `${fieldPath}.targetHarnessKind`,
  );
  if (!targetHarnessKind) {
    throw new Error(
      `Expected ${fieldPath}.targetHarnessKind to be 'subagent' or 'teammate'`,
    );
  }

  return {
    name,
    description: readOptionalString(record.description),
    targetHarnessKind,
    promptAppendix: readOptionalString(
      record.promptAppendix ?? record.prompt_appendix,
    ),
    allowedTools: readStringArray(
      record.allowedTools ?? record.allowed_tools,
      `${fieldPath}.allowedTools`,
    ),
    executionProfileOverride: readAgentExecutionProfileOverride(
      readRecord(record.executionProfileOverride) ??
        readRecord(record.execution_profile_override),
      `${fieldPath}.executionProfileOverride`,
    ),
    hidden: readOptionalBoolean(record.hidden, `${fieldPath}.hidden`),
    defaultRole: readOptionalString(record.defaultRole ?? record.default_role),
  };
}

function readAgentPresetTargetHarnessKind(
  value: unknown,
  fieldPath: string,
): AgentPresetConfig["targetHarnessKind"] | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (value === "subagent" || value === "teammate") {
    return value;
  }

  throw new Error(
    `Unsupported agent preset target at ${fieldPath}: ${String(value)}. Expected subagent or teammate.`,
  );
}

function readAgentExecutionProfileOverride(
  value: Record<string, unknown> | undefined,
  fieldPath: string,
): AgentPresetConfig["executionProfileOverride"] | undefined {
  if (!value) {
    return undefined;
  }

  const workspaceMode = readAgentWorkspaceMode(
    value.workspaceMode ?? value.workspace_mode,
    `${fieldPath}.workspaceMode`,
  );
  const memoryMode = readAgentMemoryMode(
    value.memoryMode ?? value.memory_mode,
    `${fieldPath}.memoryMode`,
  );
  const priority = readAgentPriority(value.priority, `${fieldPath}.priority`);

  if (
    workspaceMode === undefined &&
    memoryMode === undefined &&
    priority === undefined
  ) {
    return undefined;
  }

  return {
    workspaceMode,
    memoryMode,
    priority,
  };
}

function readAgentWorkspaceMode(
  value: unknown,
  fieldPath: string,
): "shared" | "isolated" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (value === "shared" || value === "isolated") {
    return value;
  }

  throw new Error(
    `Unsupported workspaceMode at ${fieldPath}: ${String(value)}. Expected shared or isolated.`,
  );
}

function readAgentMemoryMode(
  value: unknown,
  fieldPath: string,
): "session" | "fresh" | "persistent" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (value === "session" || value === "fresh" || value === "persistent") {
    return value;
  }

  throw new Error(
    `Unsupported memoryMode at ${fieldPath}: ${String(value)}. Expected session, fresh, or persistent.`,
  );
}

function readAgentPriority(
  value: unknown,
  fieldPath: string,
): "interactive" | "delegated" | "background" | "maintenance" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (
    value === "interactive" ||
    value === "delegated" ||
    value === "background" ||
    value === "maintenance"
  ) {
    return value;
  }

  throw new Error(
    `Unsupported priority at ${fieldPath}: ${String(value)}. Expected interactive, delegated, background, or maintenance.`,
  );
}

function readPositiveInt(
  value: unknown,
  fieldPath: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  throw new Error(`Expected ${fieldPath} to be a positive integer`);
}

function readAnthropicThinkingBudgetTokens(
  value: unknown,
  fieldPath: string,
): number | undefined {
  const parsed = readPositiveInt(value, fieldPath);
  if (parsed !== undefined && parsed < MIN_ANTHROPIC_THINKING_BUDGET_TOKENS) {
    throw new Error(
      `Expected ${fieldPath} to be >= ${MIN_ANTHROPIC_THINKING_BUDGET_TOKENS}`,
    );
  }
  return parsed;
}

function readOpenAIReasoningEffort(
  value: unknown,
  fieldPath: string,
): "minimal" | "low" | "medium" | "high" | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
  ) {
    return value;
  }
  throw new Error(
    `Expected ${fieldPath} to be one of: minimal, low, medium, high`,
  );
}

function readNonNegativeInt(
  value: unknown,
  fieldPath: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  throw new Error(`Expected ${fieldPath} to be a non-negative integer`);
}

function readFiniteNumber(
  value: unknown,
  fieldPath: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new Error(`Expected ${fieldPath} to be a finite number`);
}

function readOptionalBoolean(
  value: unknown,
  fieldPath: string,
): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  throw new Error(`Expected ${fieldPath} to be a boolean`);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readTuiConfig(
  source: Record<string, unknown> | undefined,
  basePath: string,
): StepCliTuiScrollConfig | undefined {
  if (!source) {
    return undefined;
  }

  const scrollAcceleration = readTuiScrollAccelerationConfig(
    readRecord(source.scrollAcceleration) ??
      readRecord(source.scroll_acceleration),
    `${basePath}.scrollAcceleration`,
  );
  const scrollSpeed = readPositiveFiniteNumber(
    source.scrollSpeed ?? source.scroll_speed,
    `${basePath}.scrollSpeed`,
  );
  if (scrollAcceleration === undefined && scrollSpeed === undefined) {
    return undefined;
  }

  return {
    scrollSpeed,
    scrollAcceleration,
  };
}

function readTuiScrollAccelerationConfig(
  source: Record<string, unknown> | undefined,
  basePath: string,
): StepCliTuiScrollConfig["scrollAcceleration"] | undefined {
  if (!source) {
    return undefined;
  }

  const enabled = readOptionalBoolean(source.enabled, `${basePath}.enabled`);
  if (enabled === undefined) {
    return undefined;
  }

  return { enabled };
}

function readPositiveFiniteNumber(
  value: unknown,
  fieldPath: string,
): number | undefined {
  const parsed = readFiniteNumber(value, fieldPath);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed <= 0) {
    throw new Error(`Expected ${fieldPath} to be a positive number`);
  }
  return parsed;
}

function readModelIdArray(
  value: unknown,
  fieldPath: string,
): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${fieldPath} to be an array`);
  }

  const result = value
    .map((entry) => {
      const direct = readOptionalString(entry);
      if (direct) {
        return direct;
      }

      const record = readRecord(entry);
      if (!record) {
        return undefined;
      }

      return (
        readOptionalString(record.id) ??
        readOptionalString(record.model) ??
        readOptionalString(record.name)
      );
    })
    .filter((entry): entry is string => Boolean(entry));

  return result.length > 0 ? result : undefined;
}

function readStringArray(
  value: unknown,
  fieldPath: string,
): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${fieldPath} to be an array of strings`);
  }

  const result = value.map((entry) => {
    const normalized = readOptionalString(entry);
    if (!normalized) {
      throw new Error(
        `Expected ${fieldPath} to contain only non-empty strings`,
      );
    }
    return normalized;
  });

  return result.length > 0 ? result : undefined;
}

function readStringMap(
  value: unknown,
  fieldPath: string,
): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const record = readRecord(value);
  if (!record) {
    throw new Error(
      `Expected ${fieldPath} to be an object mapping strings to strings`,
    );
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    const normalized = readOptionalString(entry);
    if (!normalized) {
      throw new Error(`Expected ${fieldPath}.${key} to be a non-empty string`);
    }
    result[key] = normalized;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error !== null && typeof error === "object" && "code" in error;
}
