import type {
  AgentOperatingMode,
  OpenAIReasoningEffort,
  SystemPromptProfile,
  StepCliTuiScrollConfig,
  ToolPermissionMode,
  ToolDescriptionStyle,
  ToolRiskLevel,
  ToolPresentationProfile,
  ToolSearchIndexProfile,
} from "@step-cli/protocol";

export type ModelProvider = "openai" | "response" | "anthropic";
export type ApprovalMode = "confirm" | "auto" | "strict";
export type NonInteractiveApproval = "allow" | "deny";
export type AgentPresetTargetHarnessKind = "subagent" | "teammate";
export type AgentWorkspaceMode = "shared" | "isolated";
export type AgentMemoryMode = "session" | "fresh" | "persistent";
export type AgentPriority =
  | "interactive"
  | "delegated"
  | "background"
  | "maintenance";

export interface AgentExecutionProfileOverrides {
  workspaceMode?: AgentWorkspaceMode;
  memoryMode?: AgentMemoryMode;
  priority?: AgentPriority;
}

export type McpTransportType = "stdio";

export interface McpServerConfig {
  type?: McpTransportType;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled?: boolean;
  timeoutMs?: number;
  toolPrefix?: string;
  includeTools?: string[];
  excludeTools?: string[];
  risk?: ToolRiskLevel;
  defaultMode?: ToolPermissionMode;
}

export interface ModelsProxyConfig {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  models?: string[];
}

export interface ModelReasoningConfig {
  anthropicThinkingBudgetTokens?: number;
  openaiReasoningEffort?: OpenAIReasoningEffort;
}

export interface ModelTokensConfig {
  maxContext?: number;
  maxOutput?: number;
  minOutput?: number;
  outputSafetyMargin?: number;
}

export interface ModelConfig {
  model?: string;
  provider?: ModelProvider;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  reasoning?: ModelReasoningConfig;
  tokens?: ModelTokensConfig;
}

export interface AgentRetriesConfig {
  modelRequest?: number;
  toolExecution?: number;
}

export interface AgentConfig {
  mode?: AgentOperatingMode;
  systemPromptProfile?: SystemPromptProfile;
  maxSteps?: number;
  maxUserClarificationsPerTurn?: number;
  temperature?: number;
  retries?: AgentRetriesConfig;
}

export interface ToolApprovalConfig {
  mode?: ApprovalMode;
  nonInteractive?: NonInteractiveApproval;
  overrides?: Record<string, ToolPermissionMode>;
}

export interface ToolPresentationConfig {
  profile?: ToolPresentationProfile;
  aliasSeed?: string;
  descriptionStyle?: ToolDescriptionStyle;
  searchIndexProfile?: ToolSearchIndexProfile;
}

export interface ToolsConfig {
  codeMode?: boolean;
  parallelCalls?: boolean;
  maxCallsPerStep?: number;
  repeatedCallLimit?: number;
  maxResultContextChars?: number;
  commandTimeoutMs?: number;
  commandOutputLimit?: number;
  approval?: ToolApprovalConfig;
  presentation?: ToolPresentationConfig;
}

export interface StorageLayoutConfig {
  workspaceTrustFile?: string;
  teamInboxDir?: string;
  themesDir?: string;
  sessionAssetsDir?: string;
  sessionProgressDir?: string;
  sessionProgressFile?: string;
  sessionArtifactsDir?: string;
  sessionTranscriptsDir?: string;
  sessionTeamInboxDir?: string;
  sessionTraceDir?: string;
}

export interface StorageConfig {
  rootDir?: string;
  layout?: StorageLayoutConfig;
}

export interface WorkspaceConfig {
  pluginsDir?: string;
  skillsDirName?: string;
}

export interface SessionConfig {
  autosave?: boolean;
  trace?: {
    enabled?: boolean;
    keepLast?: number;
    maxBodyBytes?: number;
    headerInjectionBaseUrls?: string[];
  };
}

export interface TuiConfig {
  altScreen?: boolean;
  scroll?: StepCliTuiScrollConfig;
}

export interface ClientsConfig {
  tui?: TuiConfig;
}

export interface IntegrationsConfig {
  modelsProxy?: ModelsProxyConfig;
  mcp?: {
    servers?: Record<string, McpServerConfig>;
  };
}

export interface AgentsConfig {
  presets?: AgentPresetConfig[];
}

export interface ConfigFile {
  model?: ModelConfig;
  agent?: AgentConfig;
  tools?: ToolsConfig;
  storage?: StorageConfig;
  workspace?: WorkspaceConfig;
  session?: SessionConfig;
  clients?: ClientsConfig;
  service?: ServiceConfig;
  integrations?: IntegrationsConfig;
  agents?: AgentsConfig;
}

export interface ServiceConfig {
  host?: string;
  port?: number;
  token?: string;
}

export interface AgentPresetConfig {
  name: string;
  description?: string;
  targetHarnessKind: AgentPresetTargetHarnessKind;
  promptAppendix?: string;
  allowedTools?: string[];
  executionProfileOverride?: AgentExecutionProfileOverrides;
  hidden?: boolean;
  defaultRole?: string;
}

export interface ConfigPaths {
  userConfigPath: string;
  workspaceConfigPath: string;
  explicitConfigPath?: string;
}

export interface LoadedConfig extends ConfigPaths {
  loadedPaths: string[];
  model?: ModelConfig;
  agent?: AgentConfig;
  tools?: ToolsConfig;
  storage?: StorageConfig;
  workspace?: WorkspaceConfig;
  session?: SessionConfig;
  clients?: ClientsConfig;
  service?: ServiceConfig;
  integrations?: IntegrationsConfig;
  agents?: AgentsConfig;
}
