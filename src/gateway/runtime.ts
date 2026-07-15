import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type {
  AgentTeam,
  AgentTeamState,
  TeamTeammateInfo,
} from "@step-cli/core/agent/agent-team.js";
import type {
  AgentLoopAction,
  AgentRunResult,
} from "@step-cli/core/agent/agent-loop.js";
import { createAgentPresetRegistry } from "@step-cli/core/agent/agent-presets.js";
import type {
  ContextUsage,
  MemoryStats,
} from "@step-cli/core/agent/conversation-memory.js";
import {
  buildDefaultMemoryConfig,
  buildDefaultRunConfig,
} from "@step-cli/core/agent/default-configs.js";
import {
  AgentHarness,
  AgentHarnessFactory,
  filterToolSpecsForOperatingMode,
  type AgentHarnessOptions,
} from "@step-cli/core/agent/harness.js";
import {
  formatExecutionProfile,
  getHarnessContext,
  resolveExecutionProfile,
} from "@step-cli/core/agent/harness-context.js";
import { compileMainHarness } from "@step-cli/core/agent/scaffolding.js";
import type { AgentStateSnapshot } from "@step-cli/core/agent/state-machine.js";
import {
  buildDelegationViews,
  buildTeammatesOverlaySnapshot,
  type DelegationActionAffordances,
  type DelegationView,
  type TeammatesOverlaySnapshot,
} from "@step-cli/core/agent/delegation-view.js";
import type { WorktreeManager } from "@step-cli/core/agent/worktree-manager.js";
import { AnthropicMessagesClient, OpenAICompatibleClient } from "@step-cli/llm";
import type { StepCliAgentPresetConfig } from "@step-cli/core/agent-preset-config.js";
import { StepCliMcpManager, type StepCliMcpServerConfig } from "@step-cli/mcp";
import { createMcpToolsPlugin } from "@step-cli/mcp/tool-plugin.js";
import { clarificationPlugin } from "@step-cli/skills-builtin/clarification-plugin.js";
import { createCodeModePlugin } from "@step-cli/skills-builtin/code-mode-plugin.js";
import { coreToolsPlugin } from "@step-cli/skills-builtin/core-tools-plugin.js";
import { buildSystemPrompt } from "@step-cli/core/prompt/system-prompt.js";
import {
  createPlanPlugin,
  formatPlanSummary,
  renderPlanSnapshotLines,
  PlanManager,
  type PlanSnapshot,
} from "@step-cli/skills-builtin/plan-plugin.js";
import type {
  BackgroundCommandView,
  BackgroundTasksToolPlugin,
} from "@step-cli/core/plugins/background-tasks-types.js";
import { createBackgroundTasksPlugin } from "@step-cli/skills-builtin/background-tasks-plugin.js";
import {
  createAgentTeamPlugin,
  type AgentTeamToolPlugin,
} from "@step-cli/skills-builtin/agent-team-plugin.js";
import { createSkillPlugin } from "@step-cli/skills-builtin/skill-plugin.js";
import {
  createSubagentPlugin,
  type BackgroundSubtaskView,
  type SubagentToolPlugin,
} from "@step-cli/skills-builtin/subagent-plugin.js";
import { createSwarmPlugin } from "@step-cli/skills-builtin/swarm-plugin.js";
import { PluginManager } from "@step-cli/core/plugins/manager.js";
import type { ToolPluginContext } from "@step-cli/core/plugins/types.js";
import {
  ToolPolicy,
  type ApprovalMode,
  type NonInteractiveApproval,
  type ToolPolicyConfig,
} from "@step-cli/core/policy/tool-policy.js";
import {
  buildSessionSnapshotV4,
  type SessionSnapshot,
  type SessionSnapshotV4,
} from "./session/session-store.js";
import { SessionEventStore } from "./session/session-event-store.js";
import { SessionTraceStore } from "./session/session-trace-store.js";
import { createSessionObserverProjector } from "./service/session-observer-projector.js";
import {
  buildSessionRestorePlan,
  buildInitialClarificationState,
  formatExternalRestoreWarning,
  formatRestoreWorkspaceNotice,
} from "./session/session-restore.js";
import { WorkspaceTrustStore } from "./session/workspace-trust-store.js";
import { FetchHttpTransport } from "@step-cli/llm";
import { LatestTurnRestoreStore } from "./restore/turn-restore.js";
import {
  createAgentActionLogRecord,
  createAgentStepLogRecord,
  createAgentStateLogRecord,
} from "./agent-stage-log.js";
import { createDevLogSink } from "./logging/dev-log-sink.js";
import { createLogger } from "@step-cli/core/logging/logger.js";
import { getToolSecurityIssue } from "@step-cli/core/tools/security.js";
import { ToolRuntime } from "@step-cli/core/tools/runtime.js";
import { SkillRegistryManager } from "@step-cli/skills-builtin/skill-tool.js";
import {
  truncateInlineText as truncateInlineByWidth,
  visibleLength as displayVisibleLength,
} from "@step-cli/utils/display-width.js";
import {
  type StepCliInteractiveUi,
  type StepCliInteractiveUiFactory,
  type StepCliInteractiveUiTone,
} from "./interactive-ui.js";
import { createFilesystemAgentRunArtifactStore } from "./artifacts/run-artifact-store.js";
import { FilesystemConversationTranscriptStore } from "./memory/filesystem-conversation-transcript-store.js";
import { FilesystemFreshAttemptProgressStore } from "./memory/filesystem-fresh-attempt-progress-store.js";
import { loadToolPlugins } from "./plugins/loader.js";
import { FilesystemAgentTeamInboxStore } from "./team/filesystem-agent-team-inbox-store.js";
import { GitWorktreeManager } from "./worktree/git-worktree-manager.js";
import {
  getSessionAssetsDirectory,
  getSessionsRootDirectory,
  type StepCliResolvedStorageLayout,
} from "./storage/layout.js";
import {
  applyVerifierCompletionGate,
  cloneStepCliVerifierVerdict,
} from "./verifier.js";
import type {
  AgentOperatingMode,
  OpenAIReasoningEffort,
  StepCliContextAssembly,
  StepCliSessionHookEventPayload,
  StepCliSessionObserverEventPayload,
  SystemPromptProfile,
  StepCliTuiScrollConfig,
  UserAttachment,
  UserTurnInput,
  ToolApprovalDecision,
  ToolDescriptionStyle,
  ToolApprovalRequest,
  ToolCallInspection,
  ToolPermissionMode,
  ToolPresentationProfile,
  ToolSearchIndexProfile,
  ToolSpec,
  StepCliInteractionProfile,
  StepCliSlashCommandResult,
  StepCliVerifierVerdict,
  UserClarificationRuntimeState,
  UserClarificationRequest,
  UserClarificationResponse,
  UserClarificationHandler,
} from "@step-cli/protocol";
import { getBrandMarkRows } from "@step-cli/utils/brand-mark.js";
import {
  buildClarificationHelpLines,
  cloneUserClarificationResponse,
  cloneUserClarificationRuntimeState,
  clarificationAllowsFreeform,
  formatClarificationOption,
  normalizeUserClarificationRequest,
  parseClarificationAnswer,
} from "@step-cli/utils/clarification.js";
import {
  ensureReadableImageFile,
  extractInlineImageAttachmentsFromUserTurn,
  parseImageAttachmentInput,
  resolveImageAttachmentFilePath,
} from "@step-cli/utils/image-attachments.js";
import { extractInlineDelegationPresetFromUserTurn } from "@step-cli/utils/inline-preset-selector.js";
import { shouldUseInteractiveTerminalPrompts } from "@step-cli/utils/interaction-surface.js";
import {
  createMutableRef,
  type MutableRef,
} from "@step-cli/utils/mutable-ref.js";
import { toErrorMessage } from "@step-cli/utils/error.js";
import {
  isUserTurnEmpty,
  normalizeUserTurnInput,
  userMessagePreviewText,
} from "@step-cli/utils/user-message.js";

const REPL_COMMANDS = [
  { command: "/help", description: "Show the interactive command reference" },
  {
    command: "/attach <path-or-url>",
    description: "Queue an image attachment for the next turn",
  },
  { command: "/attachments", description: "Inspect queued image attachments" },
  {
    command: "/detach [index]",
    description: "Remove one queued image, or all when omitted",
  },
  {
    command: "/status",
    description: "Show workspace, model, session, and plugin state",
  },
  {
    command: "/approvals [mode] [allow|deny]",
    description: "Inspect or update approval mode for this session",
    aliases: ["/approval", "/permission", "/permissions"],
    executeImmediately: true,
  },
  {
    command: "/main",
    description: "Return to the main Step lane",
    executeImmediately: true,
  },
  {
    command: "/chat <name>",
    description: "Switch to a teammate lane, for example /chat reviewer",
  },
  { command: "/plan", description: "Inspect the current session plan" },
  {
    command: "/teammates",
    description: "Inspect persistent teammate state and pending requests",
  },
  {
    command: "/swarm [on|off|task]",
    description: "Toggle swarm mode or run a swarm task",
  },
  { command: "/clear", description: "Clear in-memory conversation history" },
  { command: "/history", description: "Inspect memory and token usage" },
  {
    command: "/compact [reason]",
    description: "Force older context into summary memory",
  },
  {
    command: "/policy",
    description: "Inspect approval mode, overrides, and cache state",
  },
  {
    command: "/policy-clear <tool>",
    description: "Clear a single tool-level override",
  },
  {
    command: "/policy-clear-all",
    description: "Clear all tool-level overrides",
  },
  {
    command: "/save <file>",
    description: "Export the current conversation as JSON",
  },
  {
    command: "/save-session",
    description: "Persist the current session snapshot now",
  },
  {
    command: "/restore",
    description:
      "Undo the latest main user turn and revert tracked file writes",
  },
  {
    command: "/resume",
    description: "Pick or reload a saved session snapshot from disk",
  },
  { command: "/exit", description: "Exit the interactive shell" },
] as const;

const MAX_TUI_RESUME_OPTIONS = 9;

const TUI_APPROVAL_PRESET_OPTIONS = [
  {
    value: "read-only",
    label: "Read Only",
    description:
      "Inspect files and answer questions. Changes and commands stay blocked by default.",
    tone: "accent",
  },
  {
    value: "auto-preset",
    label: "Auto",
    description:
      "Closest to Codex Auto. Step can work in the workspace, but still asks before riskier actions.",
    tone: "brand",
  },
  {
    value: "full-access",
    label: "Full Access",
    description:
      "Apply the most permissive preset: auto / allow. Use only when you want no approval prompts.",
    tone: "warning",
  },
] as const;

export type StepCliProvider = "openai" | "response" | "anthropic";

export interface StepCliRuntimeHooks {
  clarificationHandler?: UserClarificationHandler;
  onSessionHook?: (payload: StepCliSessionHookEventPayload) => void;
  onSessionObserver?: (payload: StepCliSessionObserverEventPayload) => void;
}

export interface StepCliConfig {
  mode: AgentOperatingMode;
  model: string;
  provider?: StepCliProvider;
  baseUrl: string;
  apiKey: string;
  anthropicThinkingBudgetTokens?: number;
  openaiReasoningEffort?: OpenAIReasoningEffort;
  maxUserClarificationsPerTurn: number;
  systemPrompt?: string;
  instructionPrompt?: string;
  systemPromptProfile: SystemPromptProfile;
  codeMode?: boolean;
  toolPresentationProfile: ToolPresentationProfile;
  toolAliasSeed?: string;
  toolDescriptionStyle: ToolDescriptionStyle;
  toolSearchIndexProfile: ToolSearchIndexProfile;
  agentPresets?: StepCliAgentPresetConfig[];
  mcpServers?: Record<string, StepCliMcpServerConfig>;
  workspaceRoot: string;
  maxSteps: number;
  maxToolCallsPerStep: number;
  maxContextTokens: number;
  maxOutputTokens: number;
  minOutputTokens: number;
  outputTokenSafetyMargin: number;
  parallelToolCalls: boolean;
  temperature: number;
  timeoutMs: number;
  commandTimeoutMs: number;
  commandOutputLimit: number;
  repeatedToolCallLimit: number;
  maxToolResultCharsInContext: number;
  modelRequestRetries: number;
  toolExecutionRetries: number;
  approvalMode: ApprovalMode;
  nonInteractiveApproval: NonInteractiveApproval;
  toolPermissionOverrides?: Record<string, ToolPermissionMode>;
  pluginsDir?: string;
  skillsDirectoryName: string;
  storageRootDir: string;
  storageLayout: StepCliResolvedStorageLayout;
  interactionProfile: StepCliInteractionProfile;
  sessionId?: string;
  sessionFile?: string;
  sessionEventsFile?: string;
  resumeSession: boolean;
  autoSaveSession: boolean;
  sessionTraceEnabled?: boolean;
  sessionTraceKeepLast?: number;
  sessionTraceMaxBodyBytes?: number;
  sessionTraceHeaderInjectionBaseUrls?: string[];
  useAlternateScreen: boolean;
  tuiScroll?: StepCliTuiScrollConfig;
  interactiveUiFactory?: StepCliInteractiveUiFactory;
  verbose: boolean;
}

export interface StepCliRunInput {
  prompt?: string;
  attachments?: UserAttachment[];
  json: boolean;
}

export interface StepCliTurnResult extends AgentRunResult {
  memory: MemoryStats;
  context: ContextUsage;
  contextAssembly?: StepCliContextAssembly;
  verifier?: StepCliVerifierVerdict;
}

export interface StepCliRuntimeSummary {
  workspaceRoot: string;
  mode: AgentOperatingMode;
  model: string;
  provider: StepCliProvider;
  pluginIds: string[];
  approvalMode: ApprovalMode;
  nonInteractiveApproval: NonInteractiveApproval;
  sessionFile: string | null;
  sessionAutoSave: boolean;
  plan: PlanSnapshot;
  clarification: UserClarificationRuntimeState;
  contextAssembly?: StepCliContextAssembly;
  runtime: ReturnType<AgentHarness["getContext"]>;
  verifier?: StepCliVerifierVerdict;
}

interface StepCliMutableRuntimeState {
  mainHarness: AgentHarness | null;
  memory: ReturnType<AgentHarness["getMemory"]> | null;
  tools: ToolRuntime | null;
  systemPrompt: string;
  verifier?: StepCliVerifierVerdict;
}

interface ForegroundTurnQueueItem {
  run: () => Promise<void>;
}

interface ResumableSessionCandidate {
  value: string;
  sessionFile: string;
  sessionId: string | null;
  savedAt: string;
  label: string;
  description: string;
  current: boolean;
}

interface ParsedSlashCommand {
  command: string;
  normalizedCommand: string;
  rest: string[];
}

type SlashCommandSurfaceInput =
  | {
      kind: "tui";
      tui: StepCliInteractiveUi;
    }
  | {
      kind: "repl";
      json: boolean;
    };

export class StepCli {
  private readonly config: StepCliConfig;
  private readonly provider: StepCliProvider;
  private readonly runtimeState: StepCliMutableRuntimeState;
  private readonly sessionStore?: SessionEventStore;
  private readonly mcpManager?: StepCliMcpManager;
  private readonly pluginManager: PluginManager;
  private readonly pluginIds: string[];
  private readonly startupNotices: string[];
  private readonly policy: ToolPolicy;
  private readonly harnessFactoryRef: MutableRef<AgentHarnessFactory>;
  private readonly createHarnessFactory: (
    systemPrompt: string,
  ) => AgentHarnessFactory;
  private readonly agentHooks?: NonNullable<
    Parameters<AgentHarnessFactory["createHarness"]>[0]["hooks"]
  >;
  private readonly inlineDelegationPresetNames: ReadonlySet<string>;
  private readonly planManager: PlanManager;
  private readonly turnRestore: LatestTurnRestoreStore;
  private readonly clarificationState: UserClarificationRuntimeState;
  private readonly uiState: {
    streamEvents: boolean;
    tui: StepCliInteractiveUi | null;
    activeRunAbortController: AbortController | null;
    currentAssistantStreamActive: boolean;
    currentAssistantLineOpen: boolean;
    responseStreamUsed: boolean;
  };
  private replPendingAttachments: UserAttachment[] = [];
  private activeTeammateName: string | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly foregroundTurnQueue: ForegroundTurnQueueItem[] = [];
  private foregroundTurnDrainPromise: Promise<void> | null = null;

  private constructor(input: {
    config: StepCliConfig;
    provider: StepCliProvider;
    runtimeState: StepCliMutableRuntimeState;
    sessionStore?: SessionEventStore;
    mcpManager?: StepCliMcpManager;
    pluginManager: PluginManager;
    pluginIds: string[];
    startupNotices: string[];
    policy: ToolPolicy;
    harnessFactoryRef: MutableRef<AgentHarnessFactory>;
    createHarnessFactory: (systemPrompt: string) => AgentHarnessFactory;
    agentHooks?: NonNullable<
      Parameters<AgentHarnessFactory["createHarness"]>[0]["hooks"]
    >;
    inlineDelegationPresetNames: ReadonlySet<string>;
    planManager: PlanManager;
    turnRestore: LatestTurnRestoreStore;
    clarificationState: UserClarificationRuntimeState;
    uiState: {
      streamEvents: boolean;
      tui: StepCliInteractiveUi | null;
      activeRunAbortController: AbortController | null;
      currentAssistantStreamActive: boolean;
      currentAssistantLineOpen: boolean;
      responseStreamUsed: boolean;
    };
  }) {
    this.config = input.config;
    this.provider = input.provider;
    this.runtimeState = input.runtimeState;
    this.sessionStore = input.sessionStore;
    this.mcpManager = input.mcpManager;
    this.pluginManager = input.pluginManager;
    this.pluginIds = input.pluginIds;
    this.startupNotices = input.startupNotices;
    this.policy = input.policy;
    this.harnessFactoryRef = input.harnessFactoryRef;
    this.createHarnessFactory = input.createHarnessFactory;
    this.agentHooks = input.agentHooks;
    this.inlineDelegationPresetNames = input.inlineDelegationPresetNames;
    this.planManager = input.planManager;
    this.turnRestore = input.turnRestore;
    this.clarificationState = input.clarificationState;
    this.uiState = input.uiState;
  }

  private get mainHarness(): AgentHarness {
    if (!this.runtimeState.mainHarness) {
      throw new Error("Main harness is not initialized");
    }
    return this.runtimeState.mainHarness;
  }

  private get memory(): ReturnType<AgentHarness["getMemory"]> {
    if (!this.runtimeState.memory) {
      throw new Error("Conversation memory is not initialized");
    }
    return this.runtimeState.memory;
  }

  private get tools(): ToolRuntime {
    if (!this.runtimeState.tools) {
      throw new Error("Tool runtime is not initialized");
    }
    return this.runtimeState.tools;
  }

  private get systemPrompt(): string {
    return this.runtimeState.systemPrompt;
  }

  static async create(
    config: StepCliConfig,
    runtimeHooks: StepCliRuntimeHooks = {},
  ): Promise<StepCli> {
    type HarnessHooks = NonNullable<
      Parameters<AgentHarnessFactory["createHarness"]>[0]["hooks"]
    >;

    const traceStore = config.sessionTraceEnabled
      ? new SessionTraceStore(config.storageLayout, {
          keepLast: config.sessionTraceKeepLast,
        })
      : null;
    const transport = new FetchHttpTransport({
      traceRecorder: traceStore ?? undefined,
      maxTraceBodyBytes: config.sessionTraceMaxBodyBytes,
      traceHeaderInjectionBaseUrls: config.sessionTraceHeaderInjectionBaseUrls,
    });
    const provider = resolveProvider(config.provider, config.baseUrl);
    const client =
      provider === "anthropic"
        ? new AnthropicMessagesClient(
            {
              baseUrl: config.baseUrl,
              apiKey: config.apiKey,
              anthropicThinkingBudgetTokens:
                config.anthropicThinkingBudgetTokens,
              timeoutMs: config.timeoutMs,
            },
            transport,
          )
        : new OpenAICompatibleClient(
            {
              baseUrl: config.baseUrl,
              apiKey: config.apiKey,
              endpointKind:
                provider === "response" ? "responses" : "chat-completions",
              reasoningEffort: config.openaiReasoningEffort,
              timeoutMs: config.timeoutMs,
            },
            transport,
          );

    const runConfig = buildDefaultRunConfig({
      maxSteps: config.maxSteps,
      temperature: config.temperature,
      maxContextTokens: config.maxContextTokens,
      maxOutputTokens: config.maxOutputTokens,
      minOutputTokens: config.minOutputTokens,
      outputTokenSafetyMargin: config.outputTokenSafetyMargin,
      parallelToolCalls: config.parallelToolCalls,
      maxToolCallsPerStep: config.maxToolCallsPerStep,
      repeatedToolCallLimit: config.repeatedToolCallLimit,
      maxToolResultCharsInContext: config.maxToolResultCharsInContext,
      modelRequestRetries: config.modelRequestRetries,
      toolExecutionRetries: config.toolExecutionRetries,
    });
    const memoryConfig = buildDefaultMemoryConfig(runConfig);

    const notices: string[] = [];
    const storageLayout = config.storageLayout;
    const uiState: {
      streamEvents: boolean;
      tui: StepCliInteractiveUi | null;
      activeRunAbortController: AbortController | null;
      currentAssistantStreamActive: boolean;
      currentAssistantLineOpen: boolean;
      responseStreamUsed: boolean;
    } = {
      streamEvents: false,
      tui: null,
      activeRunAbortController: null,
      currentAssistantStreamActive: false,
      currentAssistantLineOpen: false,
      responseStreamUsed: false,
    };
    const skillRegistryManager = new SkillRegistryManager(
      config.skillsDirectoryName,
    );
    const skills = skillRegistryManager
      .refresh(config.workspaceRoot)
      .listMetadata();
    const presetRegistry = createAgentPresetRegistry(config.agentPresets);
    const harnessFactoryRef = createMutableRef<AgentHarnessFactory>(
      "AgentHarnessFactory",
    );
    let teammateHooksFactory:
      | ((name: string) => HarnessHooks | undefined)
      | undefined;
    let subtaskHooksFactory:
      | ((name: string) => HarnessHooks | undefined)
      | undefined;
    const planManager = new PlanManager();
    const turnRestore = new LatestTurnRestoreStore();
    const worktreeManager: WorktreeManager = new GitWorktreeManager({
      workspaceRoot: config.workspaceRoot,
    });
    const agentRunArtifactStore =
      createFilesystemAgentRunArtifactStore(storageLayout);
    const transcriptStore = new FilesystemConversationTranscriptStore(
      storageLayout,
    );
    const progressStore = new FilesystemFreshAttemptProgressStore(
      storageLayout,
    );
    const teamInboxStore = new FilesystemAgentTeamInboxStore(storageLayout);
    let app: StepCli | null = null;
    const mcpManagerResult = await StepCliMcpManager.create({
      workspaceRoot: config.workspaceRoot,
      servers: config.mcpServers,
    });
    notices.push(...mcpManagerResult.warnings);

    if (
      mcpManagerResult.manager &&
      mcpManagerResult.manager.getToolCount() > 0
    ) {
      notices.push(
        `Loaded ${mcpManagerResult.manager.getToolCount()} MCP tool(s) from ${mcpManagerResult.manager.getServerCount()} server(s): ${mcpManagerResult.manager.listServerNames().join(", ")}`,
      );
    }

    const observerProjector = createSessionObserverProjector();
    const emitSessionHookPayload = (
      payload: StepCliSessionHookEventPayload,
    ): void => {
      runtimeHooks.onSessionHook?.(payload);
      const observer = observerProjector.consume(payload);
      if (observer) {
        runtimeHooks.onSessionObserver?.(observer);
      }
    };

    const pluginsDir = resolveOptionalPath(
      config.workspaceRoot,
      config.pluginsDir,
    );
    const pluginResult = await loadToolPlugins({
      builtins: [
        coreToolsPlugin,
        clarificationPlugin,
        ...(config.codeMode !== false ? [createCodeModePlugin()] : []),
        ...(mcpManagerResult.manager &&
        mcpManagerResult.manager.getToolCount() > 0
          ? [createMcpToolsPlugin(mcpManagerResult.manager)]
          : []),
        createBackgroundTasksPlugin(),
        createPlanPlugin(planManager),
        createSkillPlugin(skillRegistryManager),
        createSubagentPlugin(
          harnessFactoryRef,
          worktreeManager,
          agentRunArtifactStore,
          presetRegistry,
          (name) => subtaskHooksFactory?.(name),
          emitSessionHookPayload,
        ),
        createAgentTeamPlugin(
          harnessFactoryRef,
          teamInboxStore,
          worktreeManager,
          agentRunArtifactStore,
          presetRegistry,
          (name) => teammateHooksFactory?.(name),
        ),
        createSwarmPlugin(),
      ],
      pluginsDir,
    });

    notices.push(...pluginResult.warnings);

    const pluginValidationContext: ToolPluginContext = {
      workspaceRoot: config.workspaceRoot,
      interactionProfile: config.interactionProfile,
      harness: {
        kind: "main",
        name: "main",
        depth: 0,
        sessionId: "bootstrap:main",
        goalId: "main:root",
        executionProfile: resolveExecutionProfile("main"),
      },
    };

    const activePlugins: typeof pluginResult.plugins = [];
    const validatedToolSpecs: ToolSpec[] = [];
    for (const loaded of pluginResult.plugins) {
      try {
        const registered = loaded.plugin.register(pluginValidationContext);
        for (const spec of registered) {
          const issue = getToolSecurityIssue(spec);
          if (!issue) {
            validatedToolSpecs.push(spec);
          }
        }
        activePlugins.push(loaded);
      } catch (error) {
        notices.push(
          `Failed to register plugin '${loaded.plugin.id}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const pluginManager = new PluginManager(activePlugins);
    const pluginIds = pluginManager.listPluginIds();
    const pluginDependencies = pluginManager.listDependencies();
    const promptToolSpecs = filterToolSpecsForOperatingMode(
      validatedToolSpecs,
      config.mode,
    ).specs;
    let systemPrompt = buildSystemPrompt({
      basePrompt: config.systemPrompt,
      instructionPrompt: config.instructionPrompt,
      mode: config.mode,
      profile: config.systemPromptProfile,
      toolPresentationProfile: config.toolPresentationProfile,
      toolSpecs: promptToolSpecs,
      skills,
      pluginIds,
      pluginDependencies,
    });

    const policy = new ToolPolicy({
      mode: config.approvalMode,
      nonInteractiveApproval: config.nonInteractiveApproval,
      overrides: config.toolPermissionOverrides,
    });

    const sessionStore = config.sessionFile
      ? new SessionEventStore({
          snapshotFile: resolveSessionPath(
            config.workspaceRoot,
            config.sessionFile,
          ),
          eventsFile: config.sessionEventsFile
            ? resolveSessionPath(config.workspaceRoot, config.sessionEventsFile)
            : undefined,
        })
      : undefined;

    const sessionSnapshot =
      sessionStore && config.resumeSession ? await sessionStore.load() : null;
    const sessionRestorePlan =
      sessionSnapshot && sessionStore
        ? buildSessionRestorePlan({
            snapshot: sessionSnapshot,
            sourceLabel: sessionStore.getFilePath(),
            actionLabel: "Resumed",
            currentSystemPrompt: systemPrompt,
            provider,
            model: config.model,
            mode: config.mode,
            pluginIds,
            maxPerTurn: config.maxUserClarificationsPerTurn,
            currentApprovalMode: config.approvalMode,
            currentNonInteractiveApproval: config.nonInteractiveApproval,
            baseToolPermissionOverrides: config.toolPermissionOverrides,
          })
        : null;
    if (sessionStore && config.resumeSession) {
      if (sessionRestorePlan) {
        notices.push(...sessionRestorePlan.notices);
        systemPrompt = sessionRestorePlan.systemPrompt;
        config.approvalMode = sessionRestorePlan.toolPolicy.mode;
        config.nonInteractiveApproval =
          sessionRestorePlan.toolPolicy.nonInteractiveApproval;
        replaceToolPolicyConfig(policy, sessionRestorePlan.toolPolicy);
      } else {
        notices.push(
          `No session state found at ${sessionStore.getFilePath()}; starting fresh`,
        );
      }
    }

    const clarificationState =
      sessionRestorePlan?.clarificationState ??
      buildInitialClarificationState({
        maxPerTurn: config.maxUserClarificationsPerTurn,
        snapshot: null,
        notices,
      });

    const canUseInteractiveTerminalPrompts =
      shouldUseInteractiveTerminalPrompts(config.interactionProfile);
    const runtimeState: StepCliMutableRuntimeState = {
      mainHarness: null,
      memory: null,
      tools: null,
      systemPrompt,
      verifier: cloneStepCliVerifierVerdict(
        sessionRestorePlan?.runtime?.verifier,
      ),
    };
    const createSessionHookEnvelope = (input: {
      hookKind: StepCliSessionHookEventPayload["hookKind"];
      recordedAt: string;
      importance: StepCliSessionHookEventPayload["importance"];
      title: string;
      summary: string;
      detail?: string;
      lane?: string | null;
      harnessName?: string | null;
      state?: string | null;
      actionKind?: StepCliSessionHookEventPayload["actionKind"];
      toolName?: string | null;
      dedupeKey?: string | null;
      data?: Record<string, unknown>;
      fallbackSource?: StepCliSessionHookEventPayload["source"] | null;
      fallbackHarnessType?:
        | StepCliSessionHookEventPayload["harnessType"]
        | null;
      fallbackHarnessName?: string | null;
      fallbackHarnessId?: string | null;
      fallbackParentHarnessId?: string | null;
      fallbackGoalId?: string | null;
      fallbackAttemptId?: string | null;
    }): StepCliSessionHookEventPayload => {
      const harness = getHarnessContext();
      const source =
        normalizeHookSource(harness?.kind) ??
        normalizeHookSource(input.fallbackSource) ??
        normalizeHookSource(input.fallbackHarnessType) ??
        "main";
      const harnessType =
        normalizeHookHarnessType(harness?.kind) ??
        normalizeHookHarnessType(input.fallbackHarnessType) ??
        (source === "system" ? "unknown" : "main");
      const harnessName =
        normalizeHookLane(harness?.name) ??
        normalizeHookLane(input.harnessName) ??
        normalizeHookLane(input.fallbackHarnessName);
      const lane =
        normalizeHookLane(input.lane) ??
        harnessName ??
        (source === "main" ? "main" : null);
      const harnessId =
        harness?.id ??
        normalizeHookIdentifier(input.fallbackHarnessId) ??
        harnessName ??
        source;
      const depth =
        harness?.depth ??
        (harnessType === "main"
          ? 0
          : typeof input.data?.depth === "number"
            ? input.data.depth
            : 1);

      return {
        hookId: randomUUID(),
        hookKind: input.hookKind,
        recordedAt: input.recordedAt,
        importance: input.importance,
        title: input.title,
        summary: input.summary,
        detail: input.detail,
        lane,
        source,
        harnessType,
        harnessName,
        harnessId,
        parentHarnessId:
          harness?.parentId ??
          normalizeHookIdentifier(input.fallbackParentHarnessId) ??
          null,
        goalId: harness?.goalId ?? input.fallbackGoalId ?? null,
        attemptId: harness?.attemptId ?? input.fallbackAttemptId ?? null,
        depth,
        state: input.state ?? null,
        actionKind: input.actionKind ?? null,
        toolName: input.toolName ?? null,
        dedupeKey: input.dedupeKey ?? null,
        data: input.data,
      };
    };
    const buildStateChangeHookPayload = (
      snapshot: AgentStateSnapshot,
      lane?: string | null,
    ): StepCliSessionHookEventPayload =>
      createSessionHookEnvelope({
        hookKind: "agent.state.changed",
        recordedAt: snapshot.at,
        importance: classifyStateHookImportance(snapshot.state),
        title: `Entered ${snapshot.state}`,
        summary:
          snapshot.note?.trim() ||
          `${lane ?? snapshot.harnessName ?? snapshot.harnessType ?? "main"} entered ${snapshot.state} at step ${snapshot.step}`,
        detail: snapshot.note ?? undefined,
        lane: lane ?? snapshot.harnessName ?? null,
        state: snapshot.state,
        fallbackSource:
          snapshot.harnessType === "main"
            ? "main"
            : snapshot.harnessType === "subagent"
              ? "subagent"
              : snapshot.harnessType === "teammate"
                ? "teammate"
                : undefined,
        fallbackHarnessType: snapshot.harnessType ?? null,
        fallbackHarnessName: snapshot.harnessName ?? null,
        fallbackHarnessId: snapshot.harnessId ?? null,
        fallbackGoalId: snapshot.goalId ?? null,
        fallbackAttemptId: snapshot.attemptId ?? null,
        data: {
          step: snapshot.step,
          toolCalls: snapshot.toolCalls,
          note: snapshot.note ?? null,
          sessionId: snapshot.sessionId ?? null,
          workspaceMode: snapshot.workspaceMode ?? null,
          memoryMode: snapshot.memoryMode ?? null,
          priority: snapshot.priority ?? null,
        },
      });
    const buildActionHookPayload = (
      action: AgentLoopAction,
      lane?: string | null,
    ): StepCliSessionHookEventPayload =>
      createSessionHookEnvelope({
        hookKind: "agent.action",
        recordedAt: action.at,
        importance: classifyActionHookImportance(action.kind),
        title: describeActionTitle(action),
        summary: action.summary,
        lane: lane ?? action.harnessName ?? null,
        harnessName: action.harnessName ?? null,
        actionKind: action.kind,
        fallbackSource:
          action.harnessType === "main"
            ? "main"
            : action.harnessType === "subagent"
              ? "subagent"
              : action.harnessType === "teammate"
                ? "teammate"
                : undefined,
        fallbackHarnessType: action.harnessType ?? null,
        fallbackHarnessName: action.harnessName ?? null,
        fallbackHarnessId: action.harnessId ?? null,
        fallbackGoalId: action.goalId ?? null,
        fallbackAttemptId: action.attemptId ?? null,
        data: {
          step: action.step,
          toolCalls: action.toolCalls,
          success: action.success ?? null,
          sessionId: action.sessionId ?? null,
          compaction: action.compaction ?? null,
          restart: action.restart ?? null,
        },
      });
    let agentHooks: HarnessHooks | undefined;

    const createHarnessFactory = (
      defaultSystemPrompt: string,
    ): AgentHarnessFactory =>
      new AgentHarnessFactory({
        model: config.model,
        client,
        defaultSystemPrompt,
        operatingMode: config.mode,
        toolPresentation: {
          profile: config.toolPresentationProfile,
          aliasSeed: config.toolAliasSeed,
          descriptionStyle: config.toolDescriptionStyle,
          searchIndex: config.toolSearchIndexProfile,
        },
        memoryConfig,
        runConfig,
        commandTimeoutMs: config.commandTimeoutMs,
        commandOutputLimit: config.commandOutputLimit,
        interactionProfile: config.interactionProfile,
        progressStore,
        transcriptStore,
        baseHooks: {
          beforeToolExecution: async (info) => {
            await turnRestore.recordToolStart(info);
          },
          onAction: (action) => {
            emitSessionHookPayload(buildActionHookPayload(action));
          },
          onStateChange: (snapshot) => {
            emitSessionHookPayload(buildStateChangeHookPayload(snapshot));
          },
        },
        permissionPolicy: policy,
        approvalHandler: async (request) => {
          if (uiState.tui) {
            const answer = await uiState.tui.requestApproval(request);
            if (answer === "trust-tool") {
              policy.setOverride(request.toolName, "allow");
              uiState.tui.addEvent(
                "policy",
                `tool override set: ${request.toolName}=allow`,
                "success",
              );
              return "allow-once";
            }
            if (answer === "deny-tool") {
              policy.setOverride(request.toolName, "deny");
              uiState.tui.addEvent(
                "policy",
                `tool override set: ${request.toolName}=deny`,
                "warning",
              );
              return "deny";
            }
            return answer;
          }

          if (!canUseInteractiveTerminalPrompts) {
            return policy.getNonInteractiveBehavior() === "allow"
              ? "allow-once"
              : "deny";
          }

          return promptForToolApproval(request, policy);
        },
        clarificationHandler: async (request) => {
          if (!config.interactionProfile.canAskUser) {
            return {
              cancelled: true,
              reason: `User clarification is unavailable for ${config.interactionProfile.surface} sessions.`,
            };
          }

          if (
            clarificationState.usedThisTurn >= clarificationState.maxPerTurn
          ) {
            return {
              cancelled: true,
              reason: `User clarification limit reached (${clarificationState.maxPerTurn} per turn).`,
            };
          }

          const pendingId = randomUUID();
          const requestedAt = new Date().toISOString();
          const normalizedRequest = normalizeUserClarificationRequest(request);

          clarificationState.usedThisTurn += 1;
          clarificationState.remainingThisTurn = Math.max(
            0,
            clarificationState.maxPerTurn - clarificationState.usedThisTurn,
          );
          clarificationState.pending = {
            id: pendingId,
            requestedAt,
            request: normalizedRequest,
          };

          try {
            let response: UserClarificationResponse;
            if (runtimeHooks.clarificationHandler) {
              response = await runtimeHooks.clarificationHandler(request);
            } else if (uiState.tui) {
              response = await uiState.tui.requestClarification(request);
            } else if (canUseInteractiveTerminalPrompts) {
              response = await promptForUserClarification(request);
            } else {
              response = {
                cancelled: true,
                reason:
                  "User clarification is unavailable because interactive terminal prompts are not available.",
              };
            }

            const finalizedResponse = cloneUserClarificationResponse(response);
            clarificationState.totalRequests += 1;
            clarificationState.history.push({
              id: pendingId,
              requestedAt,
              completedAt: new Date().toISOString(),
              request: normalizedRequest,
              response: finalizedResponse,
            });
            return finalizedResponse;
          } finally {
            if (clarificationState.pending?.id === pendingId) {
              clarificationState.pending = null;
            }
          }
        },
        plugins: activePlugins,
        userPromptSubmit: (context) =>
          pluginManager.runUserPromptSubmit(context),
        beforeModelRequest: (context) =>
          pluginManager.runBeforeModelRequest(context),
      });
    const harnessFactory = createHarnessFactory(systemPrompt);
    harnessFactoryRef.set(harnessFactory);

    if (sessionStore && config.resumeSession) {
      // Snapshot warnings already handled above; plugin state loads after the main harness exists.
    }

    const checkpointSave = async (): Promise<void> => {
      if (!sessionStore || !config.autoSaveSession || !app) {
        return;
      }

      await app.saveSessionSnapshot();
    };

    const supportsLiveAssistantStreaming = provider === "anthropic";
    const resetConsoleAssistantStream = (): void => {
      if (uiState.currentAssistantLineOpen) {
        output.write("\n");
      }
      uiState.currentAssistantStreamActive = false;
      uiState.currentAssistantLineOpen = false;
    };
    const emitConsoleStreamLine = (line: string): void => {
      resetConsoleAssistantStream();
      output.write(`${line}\n`);
    };
    const emitConsoleAssistantDelta = (text: string): void => {
      if (
        !uiState.streamEvents ||
        uiState.tui ||
        !supportsLiveAssistantStreaming ||
        text.length === 0
      ) {
        return;
      }

      if (!uiState.currentAssistantLineOpen) {
        output.write(`${formatResponseLabel()}\n`);
      }

      output.write(text);
      uiState.currentAssistantStreamActive = true;
      uiState.currentAssistantLineOpen = true;
      uiState.responseStreamUsed = true;
    };
    const buildTuiHarnessHooks = (
      lane?: string | null,
    ): NonNullable<AgentHarnessOptions["hooks"]> => ({
      onStep: (info) => {
        uiState.tui?.onStep(info, lane);
        void runtimeLogger.emit(createAgentStepLogRecord(info));
      },
      onAction: (action) => {
        uiState.tui?.onAction(action, lane);
        void runtimeLogger.emit(createAgentActionLogRecord(action));
      },
      onStateChange: (snapshot) => {
        uiState.tui?.onStateChange(snapshot, lane);
        void runtimeLogger.emit(createAgentStateLogRecord(snapshot));
      },
      onModelStreamReset: (_info) => {
        uiState.tui?.onModelStreamReset(lane);
      },
      onModelTextDelta: (info) => {
        uiState.tui?.onModelTextDelta({ text: info.text }, lane);
      },
      onModelToolCall: (info) => {
        uiState.tui?.onModelToolCall(
          {
            toolName: info.toolCall.function.name,
            rawArgs: info.toolCall.function.arguments,
          },
          lane,
        );
      },
      onAssistantMessage: (info) => {
        uiState.tui?.onAssistantMessage(
          {
            text: info.message.content,
            usage: info.usage,
          },
          lane,
        );
      },
      onToolStart: (info) => {
        uiState.tui?.onToolStart(info, lane);
      },
      onToolResult: (info) => {
        uiState.tui?.onToolResult(info, lane);
      },
      ...(sessionStore && config.autoSaveSession
        ? {
            onCheckpoint: async () => {
              await checkpointSave();
            },
          }
        : {}),
    });
    const runtimeLogger = createLogger({
      sinks: [createDevLogSink()],
      baseFields: {
        component: "runtime",
      },
      dynamicFields: () => {
        const harness = getHarnessContext();
        if (!harness) {
          return undefined;
        }

        return {
          sessionId: harness.sessionId,
          goalId: harness.goalId,
          attemptId: harness.attemptId,
          harnessId: harness.id,
          harnessType: harness.kind,
          harnessName: harness.name,
        };
      },
    });

    if (
      config.verbose ||
      (sessionStore && config.autoSaveSession) ||
      process.stdout.isTTY
    ) {
      agentHooks = {};

      if (config.verbose) {
        agentHooks.onStep = (info) => {
          void runtimeLogger.emit(createAgentStepLogRecord(info));
          const usage = runtimeState.memory?.getLastContextUsage() ?? {
            budgetTokens: 0,
            baseTokens: 0,
            selectedTokens: 0,
            selectedMessages: 0,
          };
          output.write(
            `\n[step ${info.step}] prompt≈${info.promptTokens} tokens | context_messages=${info.contextMessages} | window=${usage.selectedMessages} msgs | completion_max=${info.maxTokens}\n`,
          );
        };

        agentHooks.onStateChange = (snapshot) => {
          resetConsoleAssistantStream();
          void runtimeLogger.emit(createAgentStateLogRecord(snapshot));
          output.write(
            `[state] step=${snapshot.step} state=${snapshot.state} tool_calls=${snapshot.toolCalls}${snapshot.note ? ` note=${snapshot.note}` : ""}\n`,
          );
        };

        agentHooks.onAction = (action) => {
          resetConsoleAssistantStream();
          void runtimeLogger.emit(createAgentActionLogRecord(action));
          if (action.kind === "goal_start") {
            output.write(
              `[goal] start session=${action.sessionId ?? "unknown"} goal=${action.goalId ?? "unknown"} attempt=${action.attemptId ?? "unknown"} profile=${formatExecutionProfile(action)}\n`,
            );
            return;
          }

          if (action.kind === "context_compaction") {
            const result = action.compaction;
            const range =
              typeof result?.fromIndex === "number" &&
              typeof result.toIndex === "number"
                ? ` range=${result.fromIndex}:${result.toIndex}`
                : "";
            const transcript = result?.transcriptPath
              ? ` transcript=${result.transcriptPath}`
              : "";
            output.write(
              `[compact] step=${action.step} mode=${result?.mode ?? "unknown"} messages=${result?.summarizedMessages ?? 0}${range}${transcript}\n`,
            );
            return;
          }

          if (action.kind === "fresh_attempt_restart") {
            const progress = action.restart?.progressPath
              ? ` progress=${action.restart.progressPath}`
              : "";
            output.write(
              `[goal] restart session=${action.sessionId ?? "unknown"} goal=${action.goalId ?? "unknown"} attempt=${action.attemptId ?? "unknown"} next_attempt=${action.restart?.nextAttemptNumber ?? "unknown"}${progress} reason=${action.restart?.reason ?? action.summary}\n`,
            );
            return;
          }

          output.write(
            `[goal] complete status=${action.success ? "success" : "failed"} session=${action.sessionId ?? "unknown"} goal=${action.goalId ?? "unknown"} attempt=${action.attemptId ?? "unknown"}\n`,
          );
        };

        agentHooks.onModelStreamReset = () => {
          resetConsoleAssistantStream();
        };

        agentHooks.onModelTextDelta = (info) => {
          emitConsoleAssistantDelta(info.text);
        };

        agentHooks.onModelToolCall = (info) => {
          resetConsoleAssistantStream();
          output.write(
            `[model-tool] ${formatToolStreamPreview(info.toolCall.function.name, info.toolCall.function.arguments)}\n`,
          );
        };

        agentHooks.onAssistantMessage = (info) => {
          if (
            info.message.content.trim().length === 0 ||
            uiState.currentAssistantStreamActive
          ) {
            return;
          }

          resetConsoleAssistantStream();
          output.write(`${formatResponseLabel()}\n${info.message.content}\n`);
          uiState.responseStreamUsed = true;
        };

        agentHooks.onToolStart = (info) => {
          resetConsoleAssistantStream();
          output.write(
            `[tool] ${formatToolStreamPreview(
              info.toolName,
              info.rawArgs,
              info.inspection,
            )}\n`,
          );
        };

        agentHooks.onToolResult = (info) => {
          resetConsoleAssistantStream();
          output.write(
            `[tool-result] ${info.toolName}: ${info.result.summary}\n`,
          );
        };
      } else {
        const mainTuiHooks = buildTuiHarnessHooks();
        agentHooks.onStep = (info) => {
          if (uiState.tui) {
            mainTuiHooks.onStep?.(info);
            return;
          }

          void runtimeLogger.emit(createAgentStepLogRecord(info));
          if (!uiState.streamEvents) {
            return;
          }

          emitConsoleStreamLine(
            formatStreamEvent(
              "thinking",
              `step ${info.step} · ${config.model}`,
              "accent",
            ),
          );
        };

        agentHooks.onAction = (action) => {
          if (uiState.tui) {
            mainTuiHooks.onAction?.(action);
            return;
          }

          void runtimeLogger.emit(createAgentActionLogRecord(action));
          if (!uiState.streamEvents) {
            return;
          }

          if (action.kind === "context_compaction") {
            const result = action.compaction;
            emitConsoleStreamLine(
              formatStreamEvent(
                "compact",
                `${result?.summarizedMessages ?? 0} messages -> ${result?.mode ?? "summary"}`,
                "warning",
              ),
            );
            return;
          }

          if (action.kind === "fresh_attempt_restart") {
            emitConsoleStreamLine(
              formatStreamEvent(
                "restart",
                truncateInlineText(action.summary, 120),
                "warning",
              ),
            );
            return;
          }

          if (action.kind === "goal_complete") {
            const tone = action.success ? "success" : "danger";
            const message = action.success ? "response ready" : "run failed";
            emitConsoleStreamLine(formatStreamEvent("done", message, tone));
          }
        };

        agentHooks.onStateChange = (snapshot) => {
          void runtimeLogger.emit(createAgentStateLogRecord(snapshot));
          if (uiState.tui) {
            mainTuiHooks.onStateChange?.(snapshot);
          }
        };

        agentHooks.onModelStreamReset = (info) => {
          if (uiState.tui) {
            mainTuiHooks.onModelStreamReset?.(info);
            return;
          }

          resetConsoleAssistantStream();
        };

        agentHooks.onModelTextDelta = (info) => {
          if (uiState.tui) {
            mainTuiHooks.onModelTextDelta?.(info);
            return;
          }

          emitConsoleAssistantDelta(info.text);
        };

        agentHooks.onModelToolCall = (info) => {
          if (uiState.tui) {
            mainTuiHooks.onModelToolCall?.(info);
            return;
          }

          if (!uiState.streamEvents) {
            return;
          }

          emitConsoleStreamLine(
            formatStreamEvent(
              "plan",
              formatToolStreamPreview(
                info.toolCall.function.name,
                info.toolCall.function.arguments,
              ),
              "warning",
            ),
          );
        };

        agentHooks.onAssistantMessage = (info) => {
          if (uiState.tui) {
            mainTuiHooks.onAssistantMessage?.(info);
            return;
          }

          if (!uiState.streamEvents || !supportsLiveAssistantStreaming) {
            return;
          }

          if (
            info.message.content.trim().length === 0 ||
            uiState.currentAssistantStreamActive
          ) {
            return;
          }

          emitConsoleStreamLine(formatResponseLabel());
          output.write(`${info.message.content}\n`);
          uiState.responseStreamUsed = true;
        };

        agentHooks.onToolStart = (info) => {
          if (uiState.tui) {
            mainTuiHooks.onToolStart?.(info);
            return;
          }

          if (!uiState.streamEvents) {
            return;
          }

          emitConsoleStreamLine(
            formatStreamEvent(
              "tool",
              formatToolStreamPreview(
                info.toolName,
                info.rawArgs,
                info.inspection,
              ),
              "muted",
            ),
          );
        };

        agentHooks.onToolResult = (info) => {
          if (uiState.tui) {
            mainTuiHooks.onToolResult?.(info);
            return;
          }

          if (!uiState.streamEvents) {
            return;
          }

          emitConsoleStreamLine(
            formatStreamEvent(
              info.result.ok ? "result" : "error",
              `${info.toolName} · ${truncateInlineText(info.result.summary, 96)}`,
              info.result.ok ? "muted" : "danger",
            ),
          );
        };
      }

      if (sessionStore && config.autoSaveSession) {
        agentHooks.onCheckpoint = async () => {
          await checkpointSave();
        };
      }

      teammateHooksFactory = (name) => buildTuiHarnessHooks(name);
      subtaskHooksFactory = (name) => buildTuiHarnessHooks(name);
    }

    const mainHarnessCreation = compileMainHarness(harnessFactory, {
      id: "main",
      name: "main",
      depth: 0,
      workspaceRoot: config.workspaceRoot,
      sessionId: sessionRestorePlan?.runtime?.sessionId ?? config.sessionId,
      goalId: sessionRestorePlan?.runtime?.goalId,
      executionProfile: sessionRestorePlan?.runtime?.executionProfile,
      systemPrompt,
      memoryState: sessionRestorePlan?.memoryState,
      toolRuntimeState: sessionRestorePlan?.toolRuntimeState,
      hooks: agentHooks,
    });
    notices.push(...mainHarnessCreation.warnings);

    const mainHarness = mainHarnessCreation.harness;
    const memory = mainHarness.getMemory();
    const runtime = mainHarness.getTools();
    runtimeState.mainHarness = mainHarness;
    runtimeState.memory = memory;
    runtimeState.tools = runtime;
    runtimeState.systemPrompt = systemPrompt;
    runtimeState.verifier = cloneStepCliVerifierVerdict(
      sessionRestorePlan?.runtime?.verifier,
    );

    if (sessionRestorePlan?.pluginStates) {
      notices.push(...pluginManager.loadState(sessionRestorePlan.pluginStates));
    }

    app = new StepCli({
      config,
      provider,
      runtimeState,
      sessionStore,
      mcpManager: mcpManagerResult.manager,
      pluginManager,
      pluginIds,
      startupNotices: notices,
      policy,
      harnessFactoryRef,
      createHarnessFactory,
      agentHooks,
      inlineDelegationPresetNames: new Set(
        presetRegistry.presets.map((preset) => preset.name),
      ),
      planManager,
      turnRestore,
      clarificationState,
      uiState,
    });

    return app;
  }

  async run(inputData: StepCliRunInput): Promise<void> {
    if (
      (inputData.prompt && inputData.prompt.trim().length > 0) ||
      (inputData.attachments?.length ?? 0) > 0
    ) {
      this.emitStartupNotices(inputData.json);
      await this.runSinglePrompt(
        {
          content: inputData.prompt ?? "",
          attachments: inputData.attachments,
        },
        inputData.json,
      );
      return;
    }

    await this.runRepl(inputData.json);
  }

  getStartupNotices(): string[] {
    return [...this.startupNotices];
  }

  async close(
    options: {
      abortActiveRun?: boolean;
      reason?: string;
    } = {},
  ): Promise<void> {
    if (this.closePromise) {
      await this.closePromise;
      return;
    }

    const reason = options.reason?.trim() || "Step CLI runtime shutting down.";
    this.closePromise = (async () => {
      if (options.abortActiveRun) {
        const controller = this.uiState.activeRunAbortController;
        if (controller && !controller.signal.aborted) {
          controller.abort(reason);
        }
      }

      try {
        this.uiState.tui?.cancelPendingClarification(
          "Session closed before clarification was answered.",
        );
      } catch {
        // Best-effort only; cleanup should continue even if the UI is already gone.
      }
      this.clarificationState.pending = null;

      try {
        await this.pluginManager.close(reason);
      } catch {
        // Best-effort only; cleanup should continue across independent runtime owners.
      }

      try {
        await this.mcpManager?.close();
      } catch {
        // Best-effort only; the process is already shutting down.
      }

      try {
        finalizeHarnessIfInactive(this.mainHarness);
      } catch {
        // Best-effort only; inactive harness finalization should not block shutdown.
      }
    })();

    await this.closePromise;
  }

  getSummary(): StepCliRuntimeSummary {
    return {
      workspaceRoot: this.config.workspaceRoot,
      mode: this.config.mode,
      model: this.config.model,
      provider: this.provider,
      pluginIds: [...this.pluginIds],
      approvalMode: this.config.approvalMode,
      nonInteractiveApproval: this.policy.getNonInteractiveBehavior(),
      sessionFile: this.sessionStore?.getFilePath() ?? null,
      sessionAutoSave: this.config.autoSaveSession,
      plan: this.planManager.getSnapshot(),
      clarification: this.getClarificationState(),
      contextAssembly: getMemoryContextAssembly(this.memory),
      runtime: this.mainHarness.getContext(),
      verifier: cloneStepCliVerifierVerdict(this.runtimeState.verifier),
    };
  }

  exportSessionSnapshot(): SessionSnapshotV4 {
    return this.buildSessionSnapshot();
  }

  async attachInteractiveUi(
    createInteractiveUi = this.config.interactiveUiFactory,
  ): Promise<StepCliInteractiveUi> {
    if (this.uiState.tui) {
      return this.uiState.tui;
    }

    if (!createInteractiveUi) {
      throw new Error("Interactive UI factory is not configured.");
    }

    const tui = await this.createInteractiveUiInstance(createInteractiveUi);
    this.attachInteractiveUiInstance(tui);
    return tui;
  }

  detachInteractiveUi(tui?: StepCliInteractiveUi): void {
    if (!this.uiState.tui) {
      return;
    }

    if (tui && this.uiState.tui !== tui) {
      return;
    }

    this.uiState.tui = null;
  }

  /**
   * Execute a slash command from an external caller (e.g. the OpenTUI client).
   *
   * This wraps the private executeSlashCommand so that the TUI — which
   * intercepts all "/" input locally — can forward gateway-level commands
   * (such as /swarm, /clear, /history) to the runtime. For /swarm <task>,
   * the task text is returned instead of starting a turn directly, so the
   * caller can submit it through the session service's turn queue.
   */
  async executeSlashCommandExternal(
    commandLine: string,
  ): Promise<StepCliSlashCommandResult> {
    const parsed = parseSlashCommandLine(commandLine);
    if (!parsed) {
      return { handled: false, message: null, taskText: null };
    }

    // For /swarm, handle specially to capture taskText without starting a
    // turn directly. The caller (TUI) submits the task via sdk.runPrompt
    // to ensure proper queueing through the session service.
    if (parsed.normalizedCommand === "/swarm") {
      const swarmResult = this.handleSwarmCommand(parsed.rest);
      const tui = this.uiState.tui;
      if (tui && swarmResult.tuiMessage) {
        tui.addEvent(
          "swarm",
          swarmResult.tuiMessage,
          (swarmResult.tuiTone ?? "accent") as StepCliInteractiveUiTone,
        );
      }
      return {
        handled: true,
        message: swarmResult.message,
        taskText: swarmResult.taskText ?? null,
      };
    }

    // For all other commands, delegate to the existing executeSlashCommand.
    const tui = this.uiState.tui;
    const surface: SlashCommandSurfaceInput = tui
      ? { kind: "tui", tui }
      : { kind: "repl", json: false };
    const result = await this.executeSlashCommand(parsed, surface);
    return {
      handled: result === "handled",
      message: null,
      taskText: null,
    };
  }

  async runTurn(
    prompt: string | UserTurnInput,
    signal?: AbortSignal,
  ): Promise<StepCliTurnResult> {
    const tui = this.uiState.tui;
    const normalizedPrompt = normalizeUserTurnInput(prompt);
    return await this.enqueueForegroundTurn({
      prompt,
      signal,
      onStart: () => {
        tui?.beginRun(normalizedPrompt);
        this.uiState.currentAssistantStreamActive = false;
        this.uiState.currentAssistantLineOpen = false;
        this.uiState.responseStreamUsed = false;
      },
      runNow: async (queuedPrompt, queuedSignal) =>
        await this.runMainTurnNow(queuedPrompt, queuedSignal),
    });
  }

  private async runMainTurnNow(
    prompt: string | UserTurnInput,
    signal?: AbortSignal,
  ): Promise<StepCliTurnResult> {
    this.resetClarificationBudget();
    const preparedInput = await this.prepareUserTurnInput(prompt);
    if (this.mainHarness.getContext().lifecycleState === "active") {
      throw new Error(
        "Cannot start a new main turn while the current run is still active.",
      );
    }

    this.turnRestore.beginTurn(this.buildSessionSnapshot());
    this.runtimeState.verifier = undefined;

    try {
      const result = await this.mainHarness.run(preparedInput, signal);
      const verifier = applyVerifierCompletionGate({
        result,
        sessionId: this.mainHarness.getContext().sessionId,
        storageLayout: this.config.storageLayout,
        sessionTraceEnabled: this.config.sessionTraceEnabled ?? false,
        verifier: this.runtimeState.verifier,
      });
      if (verifier) {
        this.runtimeState.verifier = cloneStepCliVerifierVerdict(verifier);
      }
      await this.persistSessionIfEnabled();

      return {
        ...result,
        memory: this.memory.getStats(),
        context: this.memory.getLastContextUsage(),
        contextAssembly: getMemoryContextAssembly(this.memory),
        verifier,
      };
    } finally {
      // Auto-exit swarm mode for task/tool triggers after the turn completes.
      const swarmMode = this.getSwarmModeState();
      if (swarmMode?.isActive && swarmMode.trigger !== "manual") {
        swarmMode.exit();
      }
      await this.turnRestore.finishTurn();
    }
  }

  private async runForegroundTeammateTurnNow(
    name: string,
    prompt: string | UserTurnInput,
    signal?: AbortSignal,
  ): Promise<AgentRunResult> {
    const teammate = this.getTeammate(name);
    if (!teammate || teammate.status === "shutdown") {
      if (this.activeTeammateName === name) {
        this.activeTeammateName = null;
        this.syncTuiSessionMeta();
      }
      throw new Error(`@${name} is not available`);
    }

    const team = this.getAgentTeam();
    if (!team) {
      throw new Error("Teammates are unavailable in this session");
    }

    this.resetClarificationBudget();
    const preparedInput = await this.prepareUserTurnInput(
      prompt,
      teammate.workspaceRoot,
    );
    try {
      const result = await team.runTeammateTurn(
        teammate.name,
        preparedInput,
        signal,
      );
      await this.persistSessionIfEnabled();
      return result;
    } catch (error) {
      const message = toErrorMessage(error);
      if (message.includes("already running")) {
        throw new Error(this.buildBusyTeammateMessage(teammate.name));
      }
      throw error;
    }
  }

  private enqueueForegroundTurn<Result extends AgentRunResult>(options: {
    prompt: string | UserTurnInput;
    signal?: AbortSignal;
    runNow: (
      prompt: string | UserTurnInput,
      signal?: AbortSignal,
    ) => Promise<Result>;
    onQueued?: () => void;
    onStart?: () => void;
    onSuccess?: (result: Result) => Promise<void> | void;
    onError?: (error: unknown, started: boolean) => Promise<void> | void;
    onSettled?: (started: boolean) => Promise<void> | void;
  }): Promise<Result> {
    const queued = this.isForegroundTurnQueueBusy();

    return new Promise<Result>((resolve, reject) => {
      this.foregroundTurnQueue.push({
        run: async () => {
          let started = false;
          try {
            throwIfAbortRequested(options.signal);
            options.onStart?.();
            started = true;
            throwIfAbortRequested(options.signal);
            const result = await options.runNow(options.prompt, options.signal);
            await options.onSuccess?.(result);
            resolve(result);
          } catch (error) {
            try {
              await options.onError?.(error, started);
            } catch {
              // Queue lifecycle hooks must not wedge the foreground drain loop.
            }
            reject(error);
          } finally {
            try {
              await options.onSettled?.(started);
            } catch {
              // Best-effort only; queue cleanup must continue.
            }
          }
        },
      });

      if (queued) {
        options.onQueued?.();
      }

      this.ensureForegroundTurnDrain();
    });
  }

  private ensureForegroundTurnDrain(): void {
    if (this.foregroundTurnDrainPromise) {
      return;
    }

    this.foregroundTurnDrainPromise = (async () => {
      while (this.foregroundTurnQueue.length > 0) {
        const next = this.foregroundTurnQueue.shift();
        if (!next) {
          continue;
        }
        await next.run();
      }
    })().finally(() => {
      this.foregroundTurnDrainPromise = null;
      if (this.foregroundTurnQueue.length > 0) {
        this.ensureForegroundTurnDrain();
      }
    });
  }

  private isForegroundTurnQueueBusy(): boolean {
    return (
      this.foregroundTurnDrainPromise !== null ||
      this.foregroundTurnQueue.length > 0
    );
  }

  private switchToMainLane(): boolean {
    if (this.getActiveTeammateName() === null) {
      return false;
    }

    this.activeTeammateName = null;
    this.syncTuiSessionMeta();
    this.hydrateTuiMainLane();
    return true;
  }

  private switchToTeammateLane(rawName: string): {
    changed: boolean;
    error?: string;
    name?: string;
  } {
    const requestedName = rawName.trim().replace(/^@+/, "");
    if (requestedName.length === 0) {
      return {
        changed: false,
        error: "Usage: /chat <teammate>",
      };
    }

    const teammate = this.getTeammate(requestedName);
    if (!teammate || teammate.status === "shutdown") {
      return {
        changed: false,
        error: `@${requestedName} is not available`,
      };
    }

    const changed = this.getActiveTeammateName() !== teammate.name;
    if (changed) {
      this.activeTeammateName = teammate.name;
      this.syncTuiSessionMeta();
    }

    this.hydrateTuiTeammateLane(teammate.name);

    return {
      changed,
      name: teammate.name,
    };
  }

  private buildBusyTeammateMessage(name: string): string {
    return `@${name} is still working on its current assignment. Wait for its update, press Ctrl+Y then I to interrupt it, or use /main to return to the main lane.`;
  }

  private emitStartupNotices(json: boolean): void {
    if (this.startupNotices.length === 0) {
      return;
    }

    for (const notice of this.startupNotices) {
      if (json) {
        process.stderr.write(`[step-cli] ${notice}\n`);
      } else {
        output.write(`${formatNoticeLine(notice)}\n`);
      }
    }
  }

  private async runSinglePrompt(
    prompt: string | UserTurnInput,
    json: boolean,
  ): Promise<void> {
    this.uiState.streamEvents = !json && process.stdout.isTTY;
    this.uiState.currentAssistantStreamActive = false;
    this.uiState.currentAssistantLineOpen = false;
    this.uiState.responseStreamUsed = false;

    try {
      const result = await this.runTurn(prompt);

      if (json) {
        output.write(
          `${JSON.stringify(
            {
              output: result.output,
              steps: result.steps,
              toolCalls: result.toolCalls,
              run: result.run,
              actions: result.actions,
              stateTimeline: result.stateTimeline,
              memory: result.memory,
              context: result.context,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      if (this.uiState.currentAssistantLineOpen) {
        output.write("\n");
      }

      if (!this.uiState.responseStreamUsed) {
        output.write(`${result.output}\n`);
      }
    } finally {
      this.uiState.streamEvents = false;
      this.uiState.currentAssistantStreamActive = false;
      this.uiState.currentAssistantLineOpen = false;
      this.uiState.responseStreamUsed = false;
    }
  }

  private async prepareUserTurnInput(
    input: string | UserTurnInput,
    baseDir = this.config.workspaceRoot,
  ): Promise<UserTurnInput> {
    const normalized = extractInlineDelegationPresetFromUserTurn(
      await extractInlineImageAttachmentsFromUserTurn(
        normalizeUserTurnInput(input),
        {
          baseDir,
        },
      ),
      {
        knownPresets: this.inlineDelegationPresetNames,
      },
    );
    if (isUserTurnEmpty(normalized)) {
      throw new Error(
        "Turn input must include prompt text or at least one attachment",
      );
    }

    const preparedAttachments = normalized.attachments
      ? await Promise.all(
          normalized.attachments.map(
            async (attachment) =>
              await this.prepareUserAttachment(attachment, baseDir),
          ),
        )
      : undefined;

    return {
      content: normalized.content,
      ...(preparedAttachments && preparedAttachments.length > 0
        ? { attachments: preparedAttachments }
        : undefined),
      ...(normalized.systemPromptAppendix
        ? { systemPromptAppendix: normalized.systemPromptAppendix }
        : undefined),
    };
  }

  private async prepareUserAttachment(
    attachment: UserAttachment,
    baseDir = this.config.workspaceRoot,
  ): Promise<UserAttachment> {
    if (attachment.kind !== "image") {
      return attachment;
    }

    if (attachment.source.type === "url") {
      return {
        kind: "image",
        source: {
          type: "url",
          url: attachment.source.url,
        },
      };
    }

    const resolvedPath = resolveImageAttachmentFilePath(
      attachment.source.path,
      baseDir,
    );
    const source = await ensureReadableImageFile(resolvedPath);

    if (!this.sessionStore) {
      return {
        kind: "image",
        source: {
          type: "file",
          path: source.path,
        },
      };
    }

    const copiedPath = await this.copyAttachmentIntoSessionAssets(source.path, {
      size: source.stats.size,
      mtimeMs: source.stats.mtimeMs,
    });

    return {
      kind: "image",
      source: {
        type: "file",
        path: copiedPath,
      },
    };
  }

  private async copyAttachmentIntoSessionAssets(
    sourcePath: string,
    stats: {
      size: number;
      mtimeMs: number;
    },
  ): Promise<string> {
    const sessionFile = this.sessionStore?.getFilePath();
    if (!sessionFile) {
      return sourcePath;
    }

    const runtimeSessionId = this.mainHarness.getContext().sessionId;
    const assetDir = getSessionAssetsDirectory(
      this.config.storageLayout,
      runtimeSessionId,
    );
    await fs.mkdir(assetDir, { recursive: true });

    const extension = path.extname(sourcePath).toLowerCase();
    const basename = sanitizeSessionAssetBasename(
      path.basename(sourcePath, extension),
    );
    const digest = createHash("sha1")
      .update(sourcePath)
      .update(String(stats.size))
      .update(String(stats.mtimeMs))
      .digest("hex")
      .slice(0, 12);
    const targetPath = path.join(assetDir, `${basename}-${digest}${extension}`);

    if (!(await pathExists(targetPath))) {
      await fs.copyFile(sourcePath, targetPath);
    }

    return targetPath;
  }

  private async runRepl(json: boolean): Promise<void> {
    if (
      !json &&
      !this.config.verbose &&
      process.stdin.isTTY &&
      process.stdout.isTTY &&
      this.config.interactiveUiFactory
    ) {
      await this.runTuiRepl();
      return;
    }

    const rl = readline.createInterface({
      input,
      output,
      terminal: true,
    });

    this.uiState.streamEvents = !json && process.stdout.isTTY;
    output.write(this.buildWelcomeText());
    this.emitStartupNotices(json);

    try {
      while (true) {
        output.write(buildComposerDivider());
        const rawLine = await rl.question(
          buildPrompt(this.config.workspaceRoot),
        );
        const line = rawLine.trim();
        if (!line && this.replPendingAttachments.length === 0) {
          continue;
        }

        if (line) {
          const commandHandled = await this.handleSlashCommand(line, json);
          if (commandHandled === "exit") {
            break;
          }
          if (commandHandled === "handled") {
            continue;
          }
        }

        const attachments = cloneInteractiveAttachments(
          this.replPendingAttachments,
        );
        const turnInput: UserTurnInput = {
          content: line,
          ...(attachments.length > 0 ? { attachments } : undefined),
        };
        this.uiState.currentAssistantStreamActive = false;
        this.uiState.currentAssistantLineOpen = false;
        this.uiState.responseStreamUsed = false;
        const turn = await this.runTurn(turnInput);
        this.replPendingAttachments = [];

        if (json) {
          output.write(
            `${JSON.stringify({
              output: turn.output,
              steps: turn.steps,
              toolCalls: turn.toolCalls,
              run: turn.run,
              actions: turn.actions,
              stateTimeline: turn.stateTimeline,
              memory: turn.memory,
              context: turn.context,
            })}\n`,
          );
        } else {
          if (this.uiState.currentAssistantLineOpen) {
            output.write("\n");
          }

          if (!this.uiState.responseStreamUsed) {
            output.write(`\n${formatResponseLabel()}\n${turn.output}\n`);
          }
        }

        this.uiState.currentAssistantStreamActive = false;
        this.uiState.currentAssistantLineOpen = false;
        this.uiState.responseStreamUsed = false;
      }
    } finally {
      this.uiState.streamEvents = false;
      this.uiState.currentAssistantStreamActive = false;
      this.uiState.currentAssistantLineOpen = false;
      this.uiState.responseStreamUsed = false;
      rl.close();
    }
  }

  private async runTuiRepl(): Promise<void> {
    const createInteractiveUi = this.config.interactiveUiFactory;
    if (!createInteractiveUi) {
      throw new Error("Interactive UI factory is not configured.");
    }

    const tui = await this.attachInteractiveUi(createInteractiveUi);

    try {
      await tui.run();
      // Print brand mark on exit
      output.write(`\n${renderExitBrandMark()}\n\n`);
      const shellExitMarker = tui.consumeShellExitMarker();
      if (shellExitMarker) {
        output.write(`${shellExitMarker}\n`);
      }
    } finally {
      this.detachInteractiveUi(tui);
    }
  }

  private async createInteractiveUiInstance(
    createInteractiveUi: StepCliInteractiveUiFactory,
  ): Promise<StepCliInteractiveUi> {
    const workspaceTrustStore = new WorkspaceTrustStore(
      this.config.storageLayout,
    );
    const workspaceTrusted = await workspaceTrustStore.isTrusted();
    let tui!: StepCliInteractiveUi;
    tui = createInteractiveUi({
      workspaceRoot: formatDisplayPath(this.config.workspaceRoot),
      model: this.config.model,
      provider: this.provider,
      approvalMode: this.config.approvalMode,
      nonInteractiveApproval: this.policy.getNonInteractiveBehavior(),
      maxContextTokens: this.config.maxContextTokens,
      sessionSummary: this.describeSession(),
      pluginIds: this.pluginIds,
      commands: REPL_COMMANDS,
      delegationPresetNames: [...this.inlineDelegationPresetNames],
      useAlternateScreen: this.config.useAlternateScreen,
      scroll: this.config.tuiScroll,
      workspaceTrusted,
      activeTeammateName: this.getActiveTeammateName(),
      getTeammateSnapshot: () => this.getMultiAgentSnapshot().overlay,
      getTeammateSummary: () =>
        buildCompactTeammateSummary(this.getMultiAgentSnapshot()),
      onInterrupt: async () => {
        let interrupted = false;
        const controller = this.uiState.activeRunAbortController;
        if (controller && !controller.signal.aborted) {
          controller.abort("Run interrupted by user.");
          interrupted = true;
        }

        const activeTeammateName = this.getActiveTeammateName();
        if (!interrupted && activeTeammateName) {
          interrupted =
            this.getAgentTeam()?.interruptTeammate(activeTeammateName) ?? false;
        }

        if (await this.pluginManager.runUserInterrupt()) {
          interrupted = true;
        }

        return interrupted;
      },
      onOpenTeammate: async (name: string | null) => {
        if (name === null) {
          if (this.switchToMainLane()) {
            tui.addEvent("lane", "Back to main lane", "accent", "main");
          }
          return true;
        }

        const result = this.switchToTeammateLane(name);
        if (result.error) {
          tui.addEvent("warning", result.error, "warning");
          return false;
        }

        if (result.changed) {
          tui.addEvent(
            "lane",
            `Now chatting with @${result.name}`,
            "accent",
            result.name,
          );
        }

        return true;
      },
      onInterruptTeammate: async (name: string) => {
        if (this.activeTeammateName === name) {
          const controller = this.uiState.activeRunAbortController;
          if (controller && !controller.signal.aborted) {
            controller.abort("Run interrupted by user.");
            return true;
          }
        }

        return this.getAgentTeam()?.interruptTeammate(name) ?? false;
      },
      onTrustWorkspace: async () => {
        await workspaceTrustStore.markTrusted();
      },
      onSubmit: async (input: { content: string }) => {
        const line = input.content.trim();
        const commandHandled = line
          ? await this.handleSlashCommandTui(line, tui)
          : "skip";
        if (commandHandled === "exit") {
          return "exit";
        }
        if (commandHandled === "handled") {
          return "continue";
        }

        const activeTeammateName = this.getActiveTeammateName();
        const existingController = this.uiState.activeRunAbortController;
        const controller =
          existingController && !existingController.signal.aborted
            ? existingController
            : new AbortController();
        this.uiState.activeRunAbortController = controller;
        const completion = this.enqueueForegroundTurn({
          prompt: input,
          signal: controller.signal,
          runNow: async (queuedInput, queuedSignal) =>
            activeTeammateName === null
              ? await this.runMainTurnNow(queuedInput, queuedSignal)
              : await this.runForegroundTeammateTurnNow(
                  activeTeammateName,
                  queuedInput,
                  queuedSignal,
                ),
          onQueued: () => {
            tui.addEvent(
              "queue",
              "Queued for the next turn",
              "muted",
              activeTeammateName,
            );
          },
          onStart: () => {
            tui.beginRun(input, activeTeammateName);
            this.uiState.currentAssistantStreamActive = false;
            this.uiState.currentAssistantLineOpen = false;
            this.uiState.responseStreamUsed = false;
          },
          onSuccess: async (result) => {
            if (!didTurnSucceed(result)) {
              const failureMessage = describeRunFailure(result);
              tui.addEvent("error", failureMessage, "danger");
              tui.endRun(false, failureMessage, activeTeammateName);
              return;
            }

            if (this.provider !== "anthropic") {
              await tui.revealAssistantMessage(
                result.output,
                activeTeammateName,
              );
            }
            tui.endRun(true, undefined, activeTeammateName);
          },
          onError: async (error, started) => {
            const message = toErrorMessage(error);
            if (!started && isInterruptErrorMessage(message)) {
              return;
            }

            if (isInterruptErrorMessage(message)) {
              tui.addEvent("interrupt", message, "warning");
              if (started) {
                tui.endRun(true, message, activeTeammateName);
              }
              return;
            }

            tui.addEvent("error", message, "danger");
            if (started) {
              tui.endRun(false, message, activeTeammateName);
            }
          },
          onSettled: () => {
            if (
              this.uiState.activeRunAbortController === controller &&
              this.foregroundTurnQueue.length === 0
            ) {
              this.uiState.activeRunAbortController = null;
            }
            this.uiState.currentAssistantStreamActive = false;
            this.uiState.currentAssistantLineOpen = false;
            this.uiState.responseStreamUsed = false;
          },
        });
        void completion.catch(() => {});
        return "continue";
      },
    });

    return tui;
  }

  private attachInteractiveUiInstance(tui: StepCliInteractiveUi): void {
    this.uiState.tui = tui;
    this.hydrateActiveTuiLane();
    for (const notice of this.startupNotices) {
      tui.addNotice(notice, classifyNoticeTone(notice));
    }
  }

  private buildWelcomeText(): string {
    const runtime = this.mainHarness.getContext();
    const commandSummary = REPL_COMMANDS.slice(0, 5)
      .map((entry) => entry.command)
      .join("  ");
    const heroWidth = Math.min(76, Math.max(48, getTerminalWidth() - 2));

    return [
      "",
      renderWelcomeBrandMark(heroWidth),
      "",
      buildHeroCard([
        "Step CLI",
        `mode: ${this.config.mode}`,
        `model: ${this.config.model}`,
        `directory: ${formatDisplayPath(this.config.workspaceRoot)}`,
        `provider: ${this.provider}    session: ${this.describeSession()}    sid: ${shortId(runtime.sessionId)}`,
      ]),
      "",
      formatCallout(
        "Tip",
        "Describe a repo task, paste an error, or press Tab for commands.",
        "success",
      ),
      formatCallout("Use", commandSummary, "muted"),
      "",
    ].join("\n");
  }

  private async executeSlashCommand(
    parsed: ParsedSlashCommand,
    surface: SlashCommandSurfaceInput,
  ): Promise<"handled" | "exit"> {
    const getAttachments = (): UserAttachment[] =>
      surface.kind === "tui"
        ? surface.tui.getComposerAttachments()
        : this.replPendingAttachments;
    const setAttachments = (attachments: UserAttachment[]): void => {
      if (surface.kind === "tui") {
        surface.tui.setComposerAttachments(attachments);
        return;
      }
      this.replPendingAttachments = attachments;
    };

    switch (parsed.normalizedCommand) {
      case "/help":
        if (surface.kind === "tui") {
          surface.tui.addSection(
            "commands",
            [
              ...REPL_COMMANDS.map(
                (entry) => `${entry.command.padEnd(22)} ${entry.description}`,
              ),
              "",
              "hint                  Use /status for overview, /plan for the current plan, /teammates for the team snapshot.",
            ],
            "accent",
          );
        } else {
          output.write(this.buildHelpText());
        }
        return "handled";

      case "/approvals": {
        if (parsed.rest.length === 0) {
          if (surface.kind === "tui") {
            await this.promptApprovalsTui(surface.tui);
          } else {
            output.write(`${this.buildApprovalsText()}\n`);
          }
          return "handled";
        }

        const result = await this.updateApprovals(parsed.rest);
        if (result.error) {
          if (surface.kind === "tui") {
            surface.tui.addEvent("usage", result.error, "warning");
            surface.tui.addEvent("usage", APPROVALS_USAGE, "warning");
          } else {
            output.write(`${result.error}\n${APPROVALS_USAGE}\n`);
          }
          return "handled";
        }

        if (surface.kind === "tui") {
          surface.tui.addEvent(
            "approvals",
            result.message,
            result.changed ? "success" : "muted",
          );
        } else {
          output.write(`${result.message}\n`);
        }
        return "handled";
      }

      case "/main": {
        const changed = this.switchToMainLane();
        if (surface.kind === "tui") {
          surface.tui.addEvent(
            "lane",
            changed ? "Back to main lane" : "Already in the main lane",
            changed ? "accent" : "muted",
            "main",
          );
        } else {
          output.write(
            changed ? "Back to main lane.\n" : "Already in the main lane.\n",
          );
        }
        return "handled";
      }

      case "/chat": {
        const result = this.switchToTeammateLane(parsed.rest.join(" ").trim());
        if (result.error) {
          if (surface.kind === "tui") {
            surface.tui.addEvent(
              result.error.startsWith("Usage:") ? "usage" : "warning",
              result.error,
              "warning",
            );
          } else {
            output.write(`${result.error}\n`);
          }
          return "handled";
        }

        if (surface.kind === "tui") {
          surface.tui.addEvent(
            "lane",
            result.changed
              ? `Now chatting with @${result.name}`
              : `Already chatting with @${result.name}`,
            result.changed ? "accent" : "muted",
            result.name,
          );
        } else {
          output.write(
            result.changed
              ? `Now chatting with @${result.name}.\n`
              : `Already chatting with @${result.name}.\n`,
          );
        }
        return "handled";
      }

      case "/attach": {
        const attachmentArg = parsed.rest.join(" ").trim();
        if (!attachmentArg) {
          if (surface.kind === "tui") {
            surface.tui.addEvent("usage", "/attach <path-or-url>", "warning");
          } else {
            output.write("Usage: /attach <path-or-url>\n");
          }
          return "handled";
        }

        const attachment =
          await this.parseInteractiveImageAttachment(attachmentArg);
        const next = [...getAttachments(), attachment];
        setAttachments(next);
        const message = `${surface.kind === "tui" ? "queued" : "Queued"} ${formatInteractiveAttachmentReference(next.length - 1)} ${describeInteractiveAttachment(attachment)}`;
        if (surface.kind === "tui") {
          surface.tui.addEvent("attach", message, "success");
        } else {
          output.write(`${message}.\n`);
        }
        return "handled";
      }

      case "/attachments":
        if (surface.kind === "tui") {
          surface.tui.addSection(
            "attachments",
            buildInteractiveAttachmentLines(getAttachments()),
            "accent",
          );
        } else {
          output.write(
            `${buildInteractiveAttachmentLines(getAttachments()).join("\n")}\n`,
          );
        }
        return "handled";

      case "/detach": {
        const result = removeInteractiveAttachment(
          getAttachments(),
          parsed.rest[0]?.trim(),
        );
        if (result.error) {
          if (surface.kind === "tui") {
            surface.tui.addEvent("usage", result.error, "warning");
          } else {
            output.write(`${result.error}\n`);
          }
          return "handled";
        }

        setAttachments(result.next);
        const removed = result.removed
          .map(
            (entry) =>
              `${formatInteractiveAttachmentReference(entry.index)} ${describeInteractiveAttachment(entry.attachment)}`,
          )
          .join(", ");
        if (surface.kind === "tui") {
          surface.tui.addEvent("attach", `removed ${removed}`, "success");
        } else {
          output.write(`Removed ${removed}.\n`);
        }
        return "handled";
      }

      case "/status":
        if (surface.kind === "tui") {
          const runtime = this.mainHarness.getContext();
          const multiAgentSnapshot = this.getMultiAgentSnapshot();
          const planSnapshot = this.planManager.getSnapshot();
          surface.tui.addSection(
            "status",
            [
              `workspace        ${formatDisplayPath(this.config.workspaceRoot)}`,
              `mode             ${this.config.mode}`,
              `model            ${this.config.model}`,
              `provider         ${this.provider}`,
              `approval         ${this.config.approvalMode} / ${this.policy.getNonInteractiveBehavior()}`,
              `session          ${this.describeSession()}`,
              `runtime          sid ${shortId(runtime.sessionId)}  goal ${runtime.goalId}`,
              `profile          ${formatExecutionProfile(runtime.executionProfile)}`,
              `plan             ${formatPlanSummary(planSnapshot)}`,
              `teammates        ${formatTeammateSummary(multiAgentSnapshot)}`,
              `plugins          ${this.pluginIds.join(", ") || "none"}`,
            ],
            "accent",
          );
        } else if (surface.json) {
          const multiAgentSnapshot = this.getMultiAgentSnapshot();
          output.write(
            `${JSON.stringify({
              workspace: this.config.workspaceRoot,
              mode: this.config.mode,
              model: this.config.model,
              provider: this.provider,
              plugins: this.pluginIds,
              approvalMode: this.config.approvalMode,
              nonInteractiveApproval: this.policy.getNonInteractiveBehavior(),
              session: this.sessionStore?.getFilePath() ?? null,
              sessionAutoSave: this.config.autoSaveSession,
              runtime: this.mainHarness.getContext(),
              plan: this.planManager.getSnapshot(),
              clarification: this.getClarificationState(),
              teammates: multiAgentSnapshot.team,
              backgroundSubtasks: multiAgentSnapshot.subtasks,
            })}\n`,
          );
        } else {
          output.write(`${this.buildStatusText()}\n`);
        }
        return "handled";

      case "/plan":
        if (surface.kind === "tui") {
          surface.tui.addSection("plan", this.buildPlanLines(), "accent");
        } else if (surface.json) {
          output.write(
            `${JSON.stringify(this.planManager.getSnapshot(), null, 2)}\n`,
          );
        } else {
          output.write(`${this.buildPlanText()}\n`);
        }
        return "handled";

      case "/teammates":
        if (surface.kind === "tui") {
          surface.tui.addSection(
            "teammates",
            this.buildTeammatesLines(),
            "accent",
          );
        } else if (surface.json) {
          output.write(
            `${JSON.stringify(this.getAgentTeamState(), null, 2)}\n`,
          );
        } else {
          output.write(`${this.buildTeammatesText()}\n`);
        }
        return "handled";

      case "/swarm": {
        const swarmResult = this.handleSwarmCommand(parsed.rest);
        if (surface.kind === "tui") {
          if (swarmResult.tuiMessage) {
            surface.tui.addEvent(
              "swarm",
              swarmResult.tuiMessage,
              (swarmResult.tuiTone ?? "accent") as StepCliInteractiveUiTone,
            );
          }
        } else {
          output.write(`${swarmResult.message}\n`);
        }

        // For /swarm <task>, submit the task as a prompt after entering task mode.
        if (swarmResult.taskText) {
          const taskInput: UserTurnInput = {
            content: swarmResult.taskText,
          };
          if (surface.kind === "tui" && surface.tui) {
            const activeTeammateName = this.getActiveTeammateName();
            const controller =
              this.uiState.activeRunAbortController &&
              !this.uiState.activeRunAbortController.signal.aborted
                ? this.uiState.activeRunAbortController
                : new AbortController();
            this.uiState.activeRunAbortController = controller;
            surface.tui.beginRun(taskInput, activeTeammateName);
            this.uiState.currentAssistantStreamActive = false;
            this.uiState.currentAssistantLineOpen = false;
            this.uiState.responseStreamUsed = false;
            try {
              const result = await this.runMainTurnNow(
                taskInput,
                controller.signal,
              );
              if (didTurnSucceed(result)) {
                if (this.provider !== "anthropic") {
                  await surface.tui.revealAssistantMessage(
                    result.output,
                    activeTeammateName,
                  );
                }
                surface.tui.endRun(true, undefined, activeTeammateName);
              } else {
                const failureMessage = describeRunFailure(result);
                surface.tui.endRun(false, failureMessage, activeTeammateName);
              }
            } catch (error) {
              const message = toErrorMessage(error);
              if (!isInterruptErrorMessage(message)) {
                surface.tui.addEvent("error", message, "danger");
              }
              surface.tui.endRun(
                isInterruptErrorMessage(message),
                isInterruptErrorMessage(message) ? message : undefined,
                activeTeammateName,
              );
            } finally {
              if (
                this.uiState.activeRunAbortController === controller &&
                this.foregroundTurnQueue.length === 0
              ) {
                this.uiState.activeRunAbortController = null;
              }
              this.uiState.currentAssistantStreamActive = false;
              this.uiState.currentAssistantLineOpen = false;
              this.uiState.responseStreamUsed = false;
            }
          } else {
            try {
              await this.runMainTurnNow(taskInput);
            } catch {
              // Non-fatal; swarm mode state is already set.
            }
          }
        }

        return "handled";
      }

      case "/clear":
        this.memory.clear();
        await this.persistSessionIfEnabled();
        if (surface.kind === "tui") {
          surface.tui.addEvent(
            "memory",
            "conversation memory cleared",
            "success",
          );
        } else {
          output.write("Conversation memory cleared.\n");
        }
        return "handled";

      case "/history": {
        const stats = this.memory.getStats();
        const usage = this.memory.getLastContextUsage();
        if (surface.kind === "tui") {
          surface.tui.addSection(
            "memory",
            [
              `messages         ${stats.totalMessages}`,
              `tokens           ~${stats.estimatedTokens}`,
              `summary          ~${stats.summaryTokens}`,
              `decisions        ~${stats.decisionTokens}`,
              `summarized       ${stats.summarizedMessages}`,
              `compacted tools  ${stats.compactedToolMessages}`,
              "",
              `context budget   ${usage.budgetTokens}`,
              `base tokens      ${usage.baseTokens}`,
              `selected tokens  ${usage.selectedTokens}`,
              `selected msgs    ${usage.selectedMessages}`,
            ],
            "accent",
          );
        } else if (surface.json) {
          output.write(`${JSON.stringify({ stats, usage })}\n`);
        } else {
          output.write(
            [
              formatHeading("Conversation Memory"),
              formatInfoLine("messages", String(stats.totalMessages)),
              formatInfoLine("tokens", `~${stats.estimatedTokens}`),
              formatInfoLine("summary", `~${stats.summaryTokens}`),
              formatInfoLine("decisions", `~${stats.decisionTokens}`),
              formatInfoLine("summarized", String(stats.summarizedMessages)),
              formatInfoLine(
                "compacted tools",
                String(stats.compactedToolMessages),
              ),
              "",
              formatInfoLine("context budget", String(usage.budgetTokens)),
              formatInfoLine("base tokens", String(usage.baseTokens)),
              formatInfoLine("selected tokens", String(usage.selectedTokens)),
              formatInfoLine("selected msgs", String(usage.selectedMessages)),
              "",
            ].join("\n"),
          );
        }
        return "handled";
      }

      case "/compact": {
        const reason = parsed.rest.join(" ").trim() || "repl";
        const compacted = this.memory.forceCompact(reason);
        await this.persistSessionIfEnabled();
        if (surface.kind === "tui") {
          surface.tui.addEvent(
            "compact",
            `${compacted.compactedMessages} messages -> summary (${compacted.summaryChars} chars)`,
            "warning",
          );
        } else {
          output.write(
            `Compacted ${compacted.compactedMessages} messages into summary (summary_chars=${compacted.summaryChars}).\n`,
          );
        }
        return "handled";
      }

      case "/policy": {
        const overrides = this.policy.getOverrides();
        const approvedCount =
          this.tools.exportState().approvedFingerprints.length;

        if (surface.kind === "tui") {
          const overrideLines = Object.entries(overrides)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([tool, mode]) => `${tool.padEnd(22)} ${mode}`);

          surface.tui.addSection(
            "policy",
            [
              `mode             ${this.policy.getMode()}`,
              `non-interactive  ${this.policy.getNonInteractiveBehavior()}`,
              `overrides        ${Object.keys(overrides).length}`,
              `approved calls   ${approvedCount}`,
              "",
              ...(overrideLines.length > 0
                ? overrideLines
                : [
                    "(none)                 no tool-level overrides are active",
                  ]),
            ],
            "accent",
          );
          return "handled";
        }

        if (surface.json) {
          output.write(
            `${JSON.stringify({
              mode: this.policy.getMode(),
              nonInteractive: this.policy.getNonInteractiveBehavior(),
              overrides,
              approvedFingerprints: approvedCount,
            })}\n`,
          );
          return "handled";
        }

        const overrideLines = Object.entries(overrides)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([tool, mode]) => formatCommandLine(tool, mode));

        output.write(
          [
            formatHeading("Tool Policy"),
            formatInfoLine("mode", this.policy.getMode()),
            formatInfoLine(
              "non-interactive",
              this.policy.getNonInteractiveBehavior(),
            ),
            formatInfoLine("overrides", String(Object.keys(overrides).length)),
            formatInfoLine("approved calls", String(approvedCount)),
            "",
            styleText("tool overrides", "muted", "bold"),
            ...(overrideLines.length > 0
              ? overrideLines
              : [
                  formatCommandLine(
                    "(none)",
                    "No tool-level overrides are active",
                  ),
                ]),
            "",
          ].join("\n"),
        );
        return "handled";
      }

      case "/policy-clear": {
        const toolName = parsed.rest[0]?.trim() ?? "";
        if (!toolName) {
          if (surface.kind === "tui") {
            surface.tui.addEvent("usage", "/policy-clear <tool>", "warning");
          } else {
            output.write("Usage: /policy-clear <tool>\n");
          }
          return "handled";
        }

        this.policy.clearOverride(toolName);
        await this.persistSessionIfEnabled();
        if (surface.kind === "tui") {
          surface.tui.addEvent(
            "policy",
            `cleared tool override for ${toolName}`,
            "success",
          );
        } else {
          output.write(`Cleared tool override for ${toolName}.\n`);
        }
        return "handled";
      }

      case "/policy-clear-all": {
        const existing = Object.keys(this.policy.getOverrides());
        for (const toolName of existing) {
          this.policy.clearOverride(toolName);
        }

        await this.persistSessionIfEnabled();
        if (surface.kind === "tui") {
          surface.tui.addEvent(
            "policy",
            `cleared ${existing.length} tool override(s)`,
            "success",
          );
        } else {
          output.write(`Cleared ${existing.length} tool override(s).\n`);
        }
        return "handled";
      }

      case "/save": {
        const fileArg = parsed.rest[0];
        if (!fileArg) {
          if (surface.kind === "tui") {
            surface.tui.addEvent("usage", "/save <file>", "warning");
          } else {
            output.write("Usage: /save <file>\n");
          }
          return "handled";
        }
        await this.saveHistory(fileArg);
        if (surface.kind === "tui") {
          surface.tui.addEvent(
            "save",
            `saved conversation to ${fileArg}`,
            "success",
          );
        } else {
          output.write(`Saved conversation to ${fileArg}\n`);
        }
        return "handled";
      }

      case "/save-session": {
        if (!this.sessionStore) {
          if (surface.kind === "tui") {
            surface.tui.addEvent(
              "session",
              "session store is not configured (--session-file)",
              "warning",
            );
          } else {
            output.write("Session store is not configured (--session-file).\n");
          }
          return "handled";
        }
        await this.saveSessionSnapshot();
        if (surface.kind === "tui") {
          surface.tui.addEvent(
            "session",
            `saved session to ${this.sessionStore.getFilePath()}`,
            "success",
          );
        } else {
          output.write(`Saved session to ${this.sessionStore.getFilePath()}\n`);
        }
        return "handled";
      }

      case "/restore": {
        const notices = await this.restoreLatestTurn();
        if (surface.kind === "tui") {
          for (const notice of notices) {
            surface.tui.addEvent("session", notice, classifyNoticeTone(notice));
          }
        } else {
          for (const notice of notices) {
            output.write(`${notice}\n`);
          }
        }
        return "handled";
      }

      case "/resume": {
        if (!this.sessionStore) {
          if (surface.kind === "tui") {
            surface.tui.addEvent(
              "session",
              "session store is not configured (--session-file)",
              "warning",
            );
          } else {
            output.write("Session store is not configured (--session-file).\n");
          }
          return "handled";
        }

        if (surface.kind === "tui") {
          await this.promptResumeTui(surface.tui);
        } else {
          const notices = await this.resumeSessionFromStore();
          for (const notice of notices) {
            output.write(`${notice}\n`);
          }
        }
        return "handled";
      }

      case "/exit":
        return "exit";

      default:
        if (surface.kind === "tui") {
          surface.tui.addEvent(
            "error",
            `Unknown command: ${parsed.command}. Try /help.`,
            "danger",
          );
        } else {
          output.write(`Unknown command: ${parsed.command}. Try /help.\n`);
        }
        return "handled";
    }
  }

  private async handleSlashCommandTui(
    line: string,
    tui: StepCliInteractiveUi,
  ): Promise<"handled" | "exit" | "skip"> {
    const parsed = parseSlashCommandLine(line);
    if (!parsed) {
      return "skip";
    }
    return this.executeSlashCommand(parsed, {
      kind: "tui",
      tui,
    });
  }

  private async handleSlashCommand(
    line: string,
    json: boolean,
  ): Promise<"handled" | "exit" | "skip"> {
    const parsed = parseSlashCommandLine(line);
    if (!parsed) {
      return "skip";
    }
    return this.executeSlashCommand(parsed, {
      kind: "repl",
      json,
    });
  }

  private describeSession(): string {
    if (!this.sessionStore) {
      return "disabled";
    }

    const sessionPath = this.sessionStore.getFilePath();
    const relativePath = path.relative(this.config.workspaceRoot, sessionPath);
    const displayPath =
      relativePath &&
      !relativePath.startsWith("..") &&
      !path.isAbsolute(relativePath)
        ? relativePath
        : formatDisplayPath(sessionPath);
    const persistence = this.config.autoSaveSession
      ? "autosave"
      : "manual save";
    return `${displayPath} (${persistence})`;
  }

  private async parseInteractiveImageAttachment(
    value: string,
  ): Promise<UserAttachment> {
    const attachment = parseImageAttachmentInput(
      value,
      this.config.workspaceRoot,
    );
    if (attachment.source.type === "file") {
      await ensureReadableImageFile(attachment.source.path);
    }
    return attachment;
  }

  private buildStatusText(): string {
    const runtime = this.mainHarness.getContext();
    const multiAgentSnapshot = this.getMultiAgentSnapshot();
    const planSnapshot = this.planManager.getSnapshot();
    return [
      formatHeading("Step CLI"),
      formatInfoLine("workspace", formatDisplayPath(this.config.workspaceRoot)),
      formatInfoLine("mode", this.config.mode),
      formatInfoLine("model", this.config.model),
      formatInfoLine("provider", this.provider),
      formatInfoLine(
        "approval",
        `${this.config.approvalMode} / ${this.policy.getNonInteractiveBehavior()}`,
      ),
      formatInfoLine("session", this.describeSession()),
      formatInfoLine(
        "runtime",
        `sid ${shortId(runtime.sessionId)}  goal ${runtime.goalId}`,
      ),
      formatInfoLine(
        "profile",
        formatExecutionProfile(runtime.executionProfile),
      ),
      formatInfoLine("plan", formatPlanSummary(planSnapshot)),
      formatInfoLine("teammates", formatTeammateSummary(multiAgentSnapshot)),
      formatInfoLine("plugins", this.pluginIds.join(", ") || "none"),
    ].join("\n");
  }

  private buildApprovalsText(): string {
    return [formatHeading("Approvals"), ...this.buildApprovalsLines(), ""].join(
      "\n",
    );
  }

  private buildApprovalsLines(): string[] {
    return [
      formatInfoLine(
        "current",
        `${this.config.approvalMode} / ${this.policy.getNonInteractiveBehavior()}`,
      ),
      "",
      styleText("step-cli modes", "muted", "bold"),
      formatCommandLine(
        "confirm",
        "ask before write/execute tools; read/meta tools stay auto-approved",
      ),
      formatCommandLine(
        "auto",
        "allow tools without per-call approval; dangerous shell patterns still blocked",
      ),
      formatCommandLine(
        "strict",
        "block write/execute tools outright; keep read/meta available",
      ),
      "",
      styleText("preset picker", "muted", "bold"),
      formatCommandLine(
        "/approvals",
        "TUI picker presets: read-only -> strict / deny, auto -> confirm / deny, full-access -> auto / allow",
      ),
      "",
      styleText("manual aliases", "muted", "bold"),
      formatCommandLine("read-only", "maps to strict / deny"),
      formatCommandLine("workspace-write", "maps to confirm / deny"),
      formatCommandLine("full-access", "maps to auto / allow"),
      formatCommandLine("default", "maps to confirm / deny"),
      "",
      formatInfoLine("usage", APPROVALS_USAGE),
      formatInfoLine(
        "tip",
        "/policy still shows tool overrides and approval cache",
      ),
    ];
  }

  private async promptApprovalsTui(tui: StepCliInteractiveUi): Promise<void> {
    const currentApprovalMode = `${this.config.approvalMode} / ${this.policy.getNonInteractiveBehavior()}`;
    const presetResponse = (await tui.requestSelection({
      title: "Select Approval Mode",
      detail: `Current: ${currentApprovalMode}. Presets apply immediately.`,
      hint: "Enter confirms the selected preset. Esc goes back.",
      currentValue: mapCurrentApprovalPreset(
        this.config.approvalMode,
        this.policy.getNonInteractiveBehavior(),
      ),
      options: TUI_APPROVAL_PRESET_OPTIONS,
    })) as {
      cancelled?: boolean;
      value?: string | null;
    };

    if (presetResponse.cancelled) {
      tui.addEvent("approvals", "approval update cancelled", "muted");
      return;
    }

    const selectedPreset = presetResponse.value?.trim().toLowerCase();
    if (!selectedPreset) {
      tui.addEvent("approvals", "approval update cancelled", "muted");
      return;
    }

    const result = await this.updateApprovals([selectedPreset]);
    if (result.error) {
      tui.addEvent("usage", result.error, "warning");
      tui.addEvent("usage", APPROVALS_USAGE, "warning");
      return;
    }

    tui.addEvent(
      "approvals",
      result.message,
      result.changed ? "success" : "muted",
    );
  }

  private async updateApprovals(rest: string[]): Promise<{
    changed: boolean;
    error?: string;
    message: string;
  }> {
    const parsed = parseApprovalsCommandArgs(rest, {
      mode: this.config.approvalMode,
      nonInteractiveApproval: this.policy.getNonInteractiveBehavior(),
    });

    if ("error" in parsed) {
      return {
        changed: false,
        error: parsed.error,
        message: parsed.error,
      };
    }

    const previousMode = this.config.approvalMode;
    const previousNonInteractive = this.policy.getNonInteractiveBehavior();
    const changed =
      parsed.mode !== previousMode ||
      parsed.nonInteractiveApproval !== previousNonInteractive;

    if (!changed) {
      return {
        changed: false,
        message: `approval mode unchanged: ${parsed.mode} / ${parsed.nonInteractiveApproval}`,
      };
    }

    this.config.approvalMode = parsed.mode;
    this.config.nonInteractiveApproval = parsed.nonInteractiveApproval;
    this.policy.setMode(parsed.mode);
    this.policy.setNonInteractiveBehavior(parsed.nonInteractiveApproval);
    this.syncTuiSessionMeta();
    await this.persistSessionIfEnabled();

    const presetSuffix = parsed.preset ? ` (from ${parsed.preset} preset)` : "";
    return {
      changed: true,
      message: `approval mode set to ${parsed.mode} / ${parsed.nonInteractiveApproval}${presetSuffix}`,
    };
  }

  private syncTuiSessionMeta(): void {
    const activeTeammateName = this.getActiveTeammateName();
    this.uiState.tui?.updateSessionMeta({
      model: this.config.model,
      approvalMode: this.config.approvalMode,
      nonInteractiveApproval: this.policy.getNonInteractiveBehavior(),
      sessionSummary: this.describeSession(),
      activeTeammateName,
    });
  }

  private hydrateActiveTuiLane(): void {
    const activeTeammateName = this.getActiveTeammateName();
    if (activeTeammateName) {
      this.hydrateTuiTeammateLane(activeTeammateName);
      return;
    }

    this.hydrateTuiMainLane();
  }

  private hydrateTuiMainLane(): void {
    const tui = this.uiState?.tui;
    if (!tui) {
      return;
    }

    tui.hydrateTranscriptLaneFromMessages(
      "main",
      this.memory.exportMessages(),
      {
        replaceExisting: true,
      },
    );
  }

  private hydrateTuiTeammateLane(name: string): void {
    const tui = this.uiState?.tui;
    if (!tui) {
      return;
    }

    const messages =
      this.getAgentTeam()?.getTeammateConversationState(name)?.messages;
    if (!messages || messages.length === 0) {
      return;
    }

    tui.hydrateTranscriptLaneFromMessages(name, messages, {
      replaceExisting: true,
    });
  }

  private buildPlanText(): string {
    return [formatHeading("Plan"), ...this.buildPlanLines()].join("\n");
  }

  private buildPlanLines(): string[] {
    return renderPlanSnapshotLines(this.planManager.getSnapshot());
  }

  private buildTeammatesText(): string {
    return [formatHeading("Teammates"), ...this.buildTeammatesLines()].join(
      "\n",
    );
  }

  private buildTeammatesLines(): string[] {
    return buildTeammateSnapshotLines(this.getMultiAgentSnapshot());
  }

  private getMultiAgentSnapshot(): MultiAgentSnapshot {
    const team = this.getAgentTeamState();
    const subtasks = this.getBackgroundSubtaskViews();
    const backgroundCommands = this.getBackgroundCommandViews();
    const delegations = buildDelegationViews({
      team,
      subtasks,
      backgroundCommands,
    });
    return {
      team,
      subtasks,
      backgroundCommands,
      delegations,
      overlay: buildTeammatesOverlaySnapshot({
        team,
        delegations,
      }),
    };
  }

  private getAgentTeamState(): AgentTeamState | null {
    const snapshot =
      this.getAgentTeam()?.exportState() ??
      this.pluginManager.exportState()["agent-team-plugin"];
    return isAgentTeamState(snapshot) ? snapshot : null;
  }

  private getAgentTeam(): AgentTeam | null {
    for (const loaded of this.pluginManager.getPlugins()) {
      const plugin = loaded.plugin as Partial<AgentTeamToolPlugin>;
      if (
        plugin.id === "agent-team-plugin" &&
        typeof plugin.getTeam === "function"
      ) {
        return plugin.getTeam();
      }
    }
    return null;
  }

  private getSwarmModeState(): {
    isActive: boolean;
    trigger: string | null;
    enter(trigger: string, prompt?: string): void;
    exit(): void;
  } | null {
    for (const loaded of this.pluginManager.getPlugins()) {
      const plugin = loaded.plugin as Partial<{
        id: string;
        getSwarmMode: () =>
          | {
              isActive: boolean;
              trigger: string | null;
              enter(trigger: string, prompt?: string): void;
              exit(): void;
            }
          | undefined;
      }>;
      if (
        plugin.id === "swarm-plugin" &&
        typeof plugin.getSwarmMode === "function"
      ) {
        const mode = plugin.getSwarmMode();
        if (mode) {
          return mode;
        }
      }
    }
    return null;
  }

  private handleSwarmCommand(rest: string[]): {
    message: string;
    tuiMessage?: string;
    tuiTone?: string;
    taskText?: string;
  } {
    const mode = this.getSwarmModeState();
    if (!mode) {
      return {
        message: "Swarm mode is unavailable in this session.",
        tuiMessage: "Swarm mode unavailable",
        tuiTone: "warning",
      };
    }

    const raw = rest.join(" ").trim();
    const arg = raw.toLowerCase();

    if (arg === "" || arg === "on") {
      if (mode.isActive) {
        const trigger = mode.trigger ?? "unknown";
        return {
          message: `Swarm mode is already active (trigger: ${trigger}). Use /swarm off to deactivate.`,
          tuiMessage: `Swarm active (${trigger}). Use /swarm off.`,
          tuiTone: "muted",
        };
      }
      mode.enter("manual");
      return {
        message:
          "Swarm mode activated. Use /swarm off to deactivate, or let an AgentSwarm task complete to auto-deactivate.",
        tuiMessage: "Swarm mode on",
        tuiTone: "success",
      };
    }

    if (arg === "off") {
      if (!mode.isActive) {
        return {
          message: "Swarm mode is not active.",
          tuiMessage: "Swarm mode already off",
          tuiTone: "muted",
        };
      }
      mode.exit();
      return {
        message: "Swarm mode deactivated.",
        tuiMessage: "Swarm mode off",
        tuiTone: "accent",
      };
    }

    // Treat everything else as a task: /swarm <task description>
    if (mode.isActive && mode.trigger === "manual") {
      return {
        message: `Swarm mode is already manually active. Use /swarm off first, or just type the task directly.`,
        tuiMessage: "Already in manual swarm mode",
        tuiTone: "warning",
      };
    }

    mode.enter("task", raw);
    return {
      message: `Swarm task submitted: "${raw}". Swarm mode will auto-deactivate after the turn.`,
      tuiMessage: `Swarm task: ${raw.slice(0, 60)}${raw.length > 60 ? "..." : ""}`,
      tuiTone: "success",
      taskText: raw,
    };
  }

  private getBackgroundSubtaskViews(): BackgroundSubtaskView[] {
    for (const loaded of this.pluginManager.getPlugins()) {
      const plugin = loaded.plugin as Partial<SubagentToolPlugin>;
      if (
        plugin.id === "subagent-plugin" &&
        typeof plugin.getBackgroundViews === "function"
      ) {
        return plugin.getBackgroundViews();
      }
    }

    return [];
  }

  private getBackgroundCommandViews(): BackgroundCommandView[] {
    for (const loaded of this.pluginManager.getPlugins()) {
      const plugin = loaded.plugin as Partial<BackgroundTasksToolPlugin>;
      if (
        plugin.id === "background-tasks" &&
        typeof plugin.getViews === "function"
      ) {
        return plugin.getViews();
      }
    }

    return [];
  }

  private getTeammate(name: string): TeamTeammateInfo | null {
    return this.getAgentTeam()?.getTeammate(name) ?? null;
  }

  private getActiveTeammateName(): string | null {
    if (!this.activeTeammateName) {
      return null;
    }

    const teammate = this.getTeammate(this.activeTeammateName);
    if (!teammate || teammate.status === "shutdown") {
      this.activeTeammateName = null;
      return null;
    }

    return teammate.name;
  }

  private buildHelpText(): string {
    return [
      formatHeading("Commands"),
      ...REPL_COMMANDS.map((entry) =>
        formatCommandLine(entry.command, entry.description),
      ),
      "",
      formatInfoLine(
        "hint",
        "Use /status for overview, /plan for the current plan, /teammates for the team snapshot.",
      ),
      "",
    ].join("\n");
  }

  private async saveHistory(filePath: string): Promise<void> {
    const absolute = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.config.workspaceRoot, filePath);
    const payload = {
      workspaceRoot: this.config.workspaceRoot,
      model: this.config.model,
      provider: this.provider,
      exportedAt: new Date().toISOString(),
      runtime: this.mainHarness.getContext(),
      messages: this.memory.exportMessages(),
      memory: this.memory.getStats(),
      pluginIds: this.pluginIds,
      clarification: this.getClarificationState(),
    };

    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, JSON.stringify(payload, null, 2), "utf8");
  }

  private async persistSessionIfEnabled(): Promise<void> {
    if (!this.sessionStore || !this.config.autoSaveSession) {
      return;
    }

    await this.saveSessionSnapshot();
  }

  private async promptResumeTui(tui: StepCliInteractiveUi): Promise<void> {
    if (!this.sessionStore) {
      tui.addEvent(
        "session",
        "session store is not configured (--session-file)",
        "warning",
      );
      return;
    }

    const candidates = await this.listResumableSessionCandidates();
    if (candidates.length === 0) {
      tui.addEvent(
        "session",
        `No saved sessions found under ${this.describeSession()}`,
        "warning",
      );
      return;
    }

    const currentCandidate = candidates.find((candidate) => candidate.current);
    const selection = (await tui.requestSelection({
      title: "Resume Session",
      detail: `Current slot: ${this.describeSession()}. Pick a saved session to load into this shell.`,
      hint:
        candidates.length < MAX_TUI_RESUME_OPTIONS
          ? "Enter reloads the selected session. Esc goes back."
          : `Showing the ${MAX_TUI_RESUME_OPTIONS} most recent sessions. Enter reloads the selected session.`,
      currentValue: currentCandidate?.value ?? null,
      options: candidates.map((candidate) => ({
        value: candidate.value,
        label: candidate.label,
        description: candidate.description,
        tone: candidate.current ? "brand" : "accent",
      })),
    })) as {
      cancelled?: boolean;
      value?: string | null;
    };

    if (selection.cancelled) {
      tui.addEvent("session", "resume cancelled", "muted");
      return;
    }

    const selectedCandidate =
      candidates.find((candidate) => candidate.value === selection.value) ??
      currentCandidate ??
      candidates[0];
    if (!selectedCandidate) {
      tui.addEvent("session", "No saved session was selected.", "warning");
      return;
    }

    const notices = await this.resumeSessionFromFile(
      selectedCandidate.sessionFile,
      {
        persistCurrentSlot: !selectedCandidate.current,
      },
    );
    for (const notice of notices) {
      tui.addEvent("session", notice, classifyNoticeTone(notice));
    }
  }

  private async listResumableSessionCandidates(): Promise<
    ResumableSessionCandidate[]
  > {
    if (!this.sessionStore) {
      return [];
    }

    const currentSessionFile = this.sessionStore.getFilePath();
    const candidateFiles = new Set<string>([currentSessionFile]);
    for (const entry of await listStoredSessionSnapshotFiles(
      getSessionsRootDirectory(this.config.storageLayout),
    )) {
      candidateFiles.add(entry);
    }

    const candidates: ResumableSessionCandidate[] = [];
    for (const sessionFile of candidateFiles) {
      const candidate = await this.loadResumableSessionCandidate(
        sessionFile,
        currentSessionFile,
      );
      if (candidate) {
        candidates.push(candidate);
      }
    }

    const deduped = new Map<string, ResumableSessionCandidate>();
    for (const candidate of candidates) {
      const key = candidate.sessionId ?? `file:${candidate.sessionFile}`;
      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, candidate);
        continue;
      }

      const existingScore = Date.parse(existing.savedAt) || 0;
      const candidateScore = Date.parse(candidate.savedAt) || 0;
      if (
        candidate.current ||
        (!existing.current &&
          (candidateScore > existingScore ||
            (candidateScore === existingScore &&
              candidate.sessionFile < existing.sessionFile)))
      ) {
        deduped.set(key, candidate);
      }
    }

    return [...deduped.values()]
      .sort((left, right) => {
        const leftTime = Date.parse(left.savedAt) || 0;
        const rightTime = Date.parse(right.savedAt) || 0;
        return (
          rightTime - leftTime ||
          Number(right.current) - Number(left.current) ||
          left.label.localeCompare(right.label)
        );
      })
      .slice(0, MAX_TUI_RESUME_OPTIONS);
  }

  private async loadResumableSessionCandidate(
    sessionFile: string,
    currentSessionFile: string,
  ): Promise<ResumableSessionCandidate | null> {
    const snapshot = await loadStoredSessionSnapshot(sessionFile);
    if (!snapshot) {
      return null;
    }

    const current = sessionFile === currentSessionFile;
    const sessionId = readSnapshotSessionId(snapshot);
    const labelPrefix = current
      ? "Current"
      : sessionId
        ? shortId(sessionId)
        : path.basename(path.dirname(sessionFile));
    const preview = formatResumePreview(snapshot);
    return {
      value: sessionId ?? sessionFile,
      sessionFile,
      sessionId,
      savedAt: snapshot.savedAt,
      label: `${labelPrefix}: ${preview}`,
      description: `${formatSavedAtForDisplay(snapshot.savedAt)}  ${formatSessionFileForDisplay(this.config.workspaceRoot, sessionFile)}`,
      current,
    };
  }

  private async resumeSessionFromStore(): Promise<string[]> {
    if (!this.sessionStore) {
      return ["Session store is not configured (--session-file)."];
    }

    return this.resumeSessionFromFile(this.sessionStore.getFilePath());
  }

  private async resumeSessionFromFile(
    sessionFile: string,
    options: {
      persistCurrentSlot?: boolean;
    } = {},
  ): Promise<string[]> {
    const snapshot = await loadStoredSessionSnapshot(sessionFile);
    if (!snapshot) {
      return [`No session state found at ${sessionFile}; session unchanged`];
    }

    const notices = await this.restoreSessionFromSnapshot(snapshot, {
      sourceLabel: sessionFile,
      actionLabel: "Reloaded",
    });
    if (options.persistCurrentSlot && this.sessionStore) {
      await this.saveSessionSnapshot();
    }
    await this.turnRestore.clearLatest();
    return notices;
  }

  private async restoreLatestTurn(): Promise<string[]> {
    const restorePoint = this.turnRestore.getLatestPoint();
    const snapshot = this.turnRestore.getLatestSnapshot();
    if (!restorePoint || !snapshot) {
      return [
        "Nothing to restore. `/restore` only rewinds the most recent completed main user turn.",
      ];
    }

    const notices: string[] = [];
    const workspaceResult = await this.turnRestore.restoreLatestWorkspace();
    const workspaceNotice = formatRestoreWorkspaceNotice(workspaceResult);
    if (workspaceNotice) {
      notices.push(workspaceNotice);
    }

    notices.push(
      ...(await this.restoreSessionFromSnapshot(snapshot, {
        sourceLabel: "latest turn restore point",
        actionLabel: "Restored",
      })),
    );

    if (restorePoint.externalEffects.length > 0) {
      notices.push(formatExternalRestoreWarning(restorePoint.externalEffects));
    }

    await this.persistSessionIfEnabled();
    await this.turnRestore.clearLatest();
    return notices;
  }

  private async restoreSessionFromSnapshot(
    snapshot: SessionSnapshot,
    options: {
      sourceLabel: string;
      actionLabel: "Resumed" | "Reloaded" | "Restored";
    },
  ): Promise<string[]> {
    const previousHarness = this.mainHarness;
    const previousLifecycleState = previousHarness.getContext().lifecycleState;
    if (previousLifecycleState === "active") {
      throw new Error(
        "Cannot restore a session while the current run is still active.",
      );
    }

    const plan = buildSessionRestorePlan({
      snapshot,
      sourceLabel: options.sourceLabel,
      actionLabel: options.actionLabel,
      currentSystemPrompt: this.systemPrompt,
      provider: this.provider,
      model: this.config.model,
      mode: this.config.mode,
      pluginIds: this.pluginIds,
      maxPerTurn: this.config.maxUserClarificationsPerTurn,
      currentApprovalMode: this.config.approvalMode,
      currentNonInteractiveApproval: this.config.nonInteractiveApproval,
      baseToolPermissionOverrides: this.config.toolPermissionOverrides,
    });

    const nextFactory = this.createHarnessFactory(plan.systemPrompt);
    const created = compileMainHarness(nextFactory, {
      id: "main",
      name: "main",
      depth: 0,
      workspaceRoot: this.config.workspaceRoot,
      sessionId: plan.runtime?.sessionId,
      goalId: plan.runtime?.goalId,
      executionProfile: plan.runtime?.executionProfile,
      systemPrompt: plan.systemPrompt,
      memoryState: plan.memoryState,
      toolRuntimeState: plan.toolRuntimeState,
      hooks: this.agentHooks,
    });
    const notices = [...plan.notices, ...created.warnings];

    this.harnessFactoryRef.set(nextFactory);
    this.config.approvalMode = plan.toolPolicy.mode;
    this.config.nonInteractiveApproval = plan.toolPolicy.nonInteractiveApproval;
    replaceToolPolicyConfig(this.policy, plan.toolPolicy);
    notices.push(...this.pluginManager.resetState());
    if (plan.pluginStates) {
      notices.push(...this.pluginManager.loadState(plan.pluginStates));
    }
    overwriteClarificationState(
      this.clarificationState,
      plan.clarificationState,
    );

    const nextHarness = created.harness;
    this.runtimeState.mainHarness = nextHarness;
    this.runtimeState.memory = nextHarness.getMemory();
    this.runtimeState.tools = nextHarness.getTools();
    this.runtimeState.systemPrompt = plan.systemPrompt;
    this.runtimeState.verifier = cloneStepCliVerifierVerdict(
      plan.runtime?.verifier,
    );
    this.syncTuiSessionMeta();
    this.hydrateActiveTuiLane();

    const finalizeWarning = finalizeHarnessIfInactive(previousHarness);
    if (finalizeWarning) {
      notices.push(finalizeWarning);
    }

    return notices;
  }

  private async saveSessionSnapshot(): Promise<void> {
    if (!this.sessionStore) {
      return;
    }

    const snapshot = this.buildSessionSnapshot();
    await this.sessionStore.save(snapshot);
  }

  private buildSessionSnapshot(): SessionSnapshotV4 {
    const runtime = this.mainHarness.getContext();
    return buildSessionSnapshotV4({
      savedAt: new Date().toISOString(),
      workspaceRoot: this.config.workspaceRoot,
      provider: this.provider,
      model: this.config.model,
      mode: this.config.mode,
      systemPrompt: this.systemPrompt,
      pluginIds: this.pluginIds,
      memory: this.memory.exportState(),
      runtime: {
        sessionId: runtime.sessionId,
        goalId: runtime.goalId,
        executionProfile: runtime.executionProfile,
        contextAssembly: getMemoryContextAssembly(this.memory),
        verifier: this.runtimeState.verifier,
      },
      tools: this.tools.getDefinitions(),
      clarification: this.getClarificationState(),
      toolPolicy: this.policy.exportConfig(),
      toolRuntime: this.tools.exportState(),
      pluginStates: this.pluginManager.exportState(),
    });
  }

  private resetClarificationBudget(): void {
    this.clarificationState.usedThisTurn = 0;
    this.clarificationState.remainingThisTurn = Math.max(
      0,
      this.clarificationState.maxPerTurn,
    );
    this.clarificationState.pending = null;
  }

  private getClarificationState(): UserClarificationRuntimeState {
    return cloneUserClarificationRuntimeState(this.clarificationState);
  }
}

function getMemoryContextAssembly(
  memory: ReturnType<AgentHarness["getMemory"]>,
): StepCliContextAssembly | undefined {
  const carrier = memory as {
    getLastCompletedContextAssembly?: () => StepCliContextAssembly | null;
    getLastContextAssembly?: () => StepCliContextAssembly | null;
  };
  return (
    carrier.getLastContextAssembly?.() ??
    carrier.getLastCompletedContextAssembly?.() ??
    undefined
  );
}

function replaceToolPolicyConfig(
  policy: ToolPolicy,
  next: ToolPolicyConfig,
): void {
  policy.setMode(next.mode);
  policy.setNonInteractiveBehavior(next.nonInteractiveApproval);

  const current = policy.getOverrides();
  const nextOverrides = next.overrides ?? {};

  for (const toolName of Object.keys(current)) {
    if (!(toolName in nextOverrides)) {
      policy.clearOverride(toolName);
    }
  }

  for (const [toolName, mode] of Object.entries(nextOverrides)) {
    if (current[toolName] !== mode) {
      policy.setOverride(toolName, mode);
    }
  }
}

function overwriteClarificationState(
  target: UserClarificationRuntimeState,
  nextState: UserClarificationRuntimeState,
): void {
  const cloned = cloneUserClarificationRuntimeState(nextState);
  target.maxPerTurn = cloned.maxPerTurn;
  target.usedThisTurn = cloned.usedThisTurn;
  target.remainingThisTurn = cloned.remainingThisTurn;
  target.totalRequests = cloned.totalRequests;
  target.pending = cloned.pending;
  target.history = cloned.history;
}

function finalizeHarnessIfInactive(harness: AgentHarness): string | null {
  const lifecycleState = harness.getContext().lifecycleState;
  if (lifecycleState === "finalized") {
    return null;
  }

  if (lifecycleState === "active") {
    return "Skipped finalizing the previous main harness because it is still active.";
  }

  harness.finalize();
  return null;
}

function resolveProvider(
  provider: StepCliProvider | undefined,
  baseUrl: string,
): StepCliProvider {
  if (provider) {
    return provider;
  }

  const normalized = baseUrl.trim().toLowerCase();
  if (normalized.includes("anthropic")) {
    return "anthropic";
  }

  try {
    const parsed = new URL(baseUrl);
    const pathname = parsed.pathname.toLowerCase();
    if (pathname.endsWith("/v1/messages") || pathname.endsWith("/messages")) {
      return "anthropic";
    }
  } catch {
    if (
      normalized.includes("/v1/messages") ||
      normalized.endsWith("/messages")
    ) {
      return "anthropic";
    }
  }

  return "openai";
}

function resolveOptionalPath(
  workspaceRoot: string,
  value: string | undefined,
): string | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }

  return path.isAbsolute(value) ? value : path.resolve(workspaceRoot, value);
}

function resolveSessionPath(
  workspaceRoot: string,
  sessionFile: string,
): string {
  if (path.isAbsolute(sessionFile)) {
    return sessionFile;
  }

  return path.resolve(workspaceRoot, sessionFile);
}

async function listStoredSessionSnapshotFiles(
  directory: string,
): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const snapshotFile = path.join(directory, entry.name, "session.json");
          if (await pathExists(snapshotFile)) {
            return snapshotFile;
          }
          const legacyEventsFile = path.join(
            directory,
            entry.name,
            "events.jsonl",
          );
          return (await pathExists(legacyEventsFile)) ? legacyEventsFile : null;
        }),
    );
    return files.filter((entry): entry is string => Boolean(entry));
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function loadStoredSessionSnapshot(
  filePath: string,
): Promise<SessionSnapshot | null> {
  return new SessionEventStore({ snapshotFile: filePath }).load();
}

function readSnapshotSessionId(snapshot: SessionSnapshot): string | null {
  const sessionId =
    "runtime" in snapshot ? snapshot.runtime?.sessionId : undefined;
  return typeof sessionId === "string" && sessionId.trim().length > 0
    ? sessionId
    : null;
}

function formatResumePreview(snapshot: SessionSnapshot): string {
  const firstUserMessage = snapshot.memory.messages.find(
    (message) => message.role === "user",
  );
  const previewSource =
    firstUserMessage && "content" in firstUserMessage
      ? userMessagePreviewText(firstUserMessage, {
          verboseAttachments: false,
        })
      : snapshot.memory.summary;
  const normalizedPreview = previewSource.replace(/\s+/g, " ").trim();
  return truncateInlineByWidth(normalizedPreview || "(empty session)", 56);
}

function formatSavedAtForDisplay(savedAt: string): string {
  const timestamp = Date.parse(savedAt);
  if (!Number.isFinite(timestamp)) {
    return "saved unknown";
  }
  return `saved ${new Date(timestamp).toISOString().replace("T", " ").replace(".000Z", "Z")}`;
}

function formatSessionFileForDisplay(
  workspaceRoot: string,
  sessionFile: string,
): string {
  const relativePath = path.relative(workspaceRoot, sessionFile);
  if (
    relativePath &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
  ) {
    return relativePath;
  }
  return formatDisplayPath(sessionFile);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error !== null && typeof error === "object" && "code" in error;
}

type TextTone = "muted" | "accent" | "success" | "warning" | "danger";
type TextWeight = "normal" | "bold";

function buildPrompt(workspaceRoot: string): string {
  void workspaceRoot;
  return `${styleText(">_", "accent", "bold")} `;
}

function buildDecisionPrompt(): string {
  return `${styleText("decision", "warning", "bold")} ${styleText(">", "warning", "bold")} `;
}

function formatHeading(title: string): string {
  return `${styleText(title, "accent", "bold")}\n${formatDivider(Math.max(24, visibleLength(title) + 10))}`;
}

function formatDivider(width = 36): string {
  return styleText("-".repeat(width), "muted");
}

function formatInfoLine(label: string, value: string): string {
  const safeValue = value.replace(/\s+/g, " ").trim() || "(none)";
  return `${styleText(padDisplayRight(label, 15), "muted", "bold")} ${safeValue}`;
}

function formatCommandLine(command: string, description: string): string {
  return `${styleText(padDisplayRight(command, 22), "accent", "bold")} ${description}`;
}

function formatNoticeLine(notice: string): string {
  return formatCallout("Notice", notice, classifyNoticeTone(notice));
}

function formatDisplayPath(value: string): string {
  const homeDirectory = process.env.HOME?.trim();
  if (homeDirectory && value.startsWith(homeDirectory)) {
    const suffix = value.slice(homeDirectory.length);
    return suffix.length > 0 ? `~${suffix}` : "~";
  }
  return value;
}

function shortId(value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    return "unknown";
  }
  return value.slice(0, 8);
}

interface MultiAgentSnapshot {
  team: AgentTeamState | null;
  subtasks: BackgroundSubtaskView[];
  backgroundCommands: BackgroundCommandView[];
  delegations: DelegationView[];
  overlay: TeammatesOverlaySnapshot;
}

function isAgentTeamState(value: unknown): value is AgentTeamState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const snapshot = value as Record<string, unknown>;
  return (
    Array.isArray(snapshot.teammates) &&
    Array.isArray(snapshot.shutdownRequests) &&
    Array.isArray(snapshot.planRequests)
  );
}

function formatTeammateSummary(snapshot: MultiAgentSnapshot): string {
  const summary = snapshot.overlay.summary;

  if (!snapshot.team && summary.backgroundTotal === 0) {
    return "agent-team unavailable";
  }

  return [
    snapshot.team
      ? `${summary.teammates} total / ${summary.working} working / ${summary.idle} idle / ${summary.error} error`
      : "agent-team unavailable",
    summary.backgroundTotal > 0
      ? `${summary.backgroundTotal} bg / ${summary.runningBackground} running / ${summary.queuedBackground} queued${summary.problemBackground > 0 ? ` / ${summary.problemBackground} problem` : ""}`
      : null,
  ]
    .filter((value): value is string => value !== null)
    .join(" / ");
}

function buildCompactTeammateSummary(
  snapshot: MultiAgentSnapshot,
): string | null {
  const summary = snapshot.overlay.summary;
  if (!snapshot.team && summary.backgroundTotal === 0) {
    return null;
  }

  const activeTeammates = snapshot.overlay.teammates.filter(
    (entry) => entry.status === "working",
  );
  const activeSummary =
    activeTeammates.length === 1
      ? `${activeTeammates[0]!.name} working`
      : activeTeammates.length > 1
        ? `${activeTeammates[0]!.name} +${activeTeammates.length - 1} working`
        : null;
  const activeBackgroundSummary = buildCompactBackgroundDelegationSummary(
    snapshot.delegations,
  );

  const segments = [
    activeSummary,
    activeBackgroundSummary,
    summary.teammates > 0 ? `${summary.teammates} total` : null,
    summary.working > 0 && !activeSummary ? `${summary.working} working` : null,
    summary.idle > 0 ? `${summary.idle} idle` : null,
    summary.error > 0 ? `${summary.error} error` : null,
    summary.runningBackground > 0 && !activeBackgroundSummary
      ? `${summary.runningBackground} bg running`
      : null,
    summary.queuedBackground > 0
      ? `${summary.queuedBackground} bg queued`
      : null,
    summary.problemBackground > 0
      ? `${summary.problemBackground} bg problem`
      : null,
    summary.planRequests > 0 ? `${summary.planRequests} plan` : null,
    summary.shutdownRequests > 0
      ? `${summary.shutdownRequests} shutdown`
      : null,
  ]
    .filter((value): value is string => value !== null)
    .slice(0, 3);

  return segments.length > 0 ? segments.join(" · ") : null;
}

function buildTeammateSnapshotLines(snapshot: MultiAgentSnapshot): string[] {
  const overlay = snapshot.overlay;
  const lines = [
    `teammates        ${overlay.summary.teammates}`,
    `working          ${overlay.summary.working}`,
    `idle             ${overlay.summary.idle}`,
    `error            ${overlay.summary.error}`,
    `shutdown         ${overlay.summary.shutdown}`,
    `plan requests    ${overlay.summary.planRequests}`,
    `shutdown reqs    ${overlay.summary.shutdownRequests}`,
    `background       ${overlay.summary.backgroundTotal}`,
    `bg running       ${overlay.summary.runningBackground}`,
    `bg queued        ${overlay.summary.queuedBackground}`,
    `bg problem       ${overlay.summary.problemBackground}`,
    `subtasks         ${overlay.summary.subtasks}`,
    `commands         ${overlay.summary.backgroundCommands}`,
  ];

  for (const entry of overlay.unavailable) {
    lines.push(formatOverlayUnavailableLine(entry));
  }

  if (overlay.emptyState) {
    lines.push("", `(none)                 ${overlay.emptyState}`);
  }

  for (const teammate of overlay.teammates) {
    const actions = formatSnapshotActions(teammate.actions);
    lines.push(
      ...[
        "",
        `${padDisplayRight(teammate.name, 16)} [${teammate.status}] ${teammate.role}`,
        `  lead           ${teammate.lead}`,
        `  workspace      ${teammate.workspace}`,
        `  profile        ${teammate.profile}`,
        actions ? `  actions        ${actions}` : null,
        `  updated        ${teammate.updated}`,
        `  session        ${teammate.session}  goal ${teammate.goal}`,
      ].filter((line): line is string => Boolean(line)),
    );
  }

  if (overlay.subtasks.length > 0) {
    lines.push("", "background subtasks:");
    for (const task of overlay.subtasks) {
      const actions = formatSnapshotActions(task.actions);
      lines.push(
        ...[
          `${padDisplayRight(normalizeSnapshotValue(task.label) || task.taskId, 16)} [${task.status}] ${task.kind}`,
          `  task           ${task.taskId}`,
          task.alias ? `  alias          ${task.alias}` : null,
          task.group ? `  group          ${task.group}` : null,
          `  workspace      ${task.workspace}`,
          `  profile        ${task.profile}`,
          `  updated        ${task.updated}`,
          `  queue          ${task.queue}`,
          actions ? `  actions        ${actions}` : null,
        ].filter((line): line is string => Boolean(line)),
      );
      if (task.active) {
        lines.push(`  active         ${task.active}`);
      }
      if (task.summary) {
        lines.push(`  summary        ${task.summary}`);
      }
      if (task.error) {
        lines.push(`  error          ${task.error}`);
      }
      if (task.artifact) {
        lines.push(`  artifact       ${task.artifact}`);
      }
      for (const warning of task.warnings) {
        const normalizedWarning = normalizeSnapshotValue(warning);
        if (normalizedWarning) {
          lines.push(`  warning        ${normalizedWarning}`);
        }
      }
      lines.push("");
    }
    trimTrailingBlankLines(lines);
  }

  if (overlay.backgroundCommands.length > 0) {
    lines.push("", "background commands:");
    for (const task of overlay.backgroundCommands) {
      const actions = formatSnapshotActions(task.actions);
      lines.push(
        ...[
          `${padDisplayRight(normalizeSnapshotValue(task.label) || task.id, 16)} [${task.status}] ${task.kind}`,
          `  id             ${task.id}`,
          `  workspace      ${task.workspace}`,
          `  updated        ${task.updated}`,
          actions ? `  actions        ${actions}` : null,
          `  command        ${task.command}`,
          task.summary ? `  summary        ${task.summary}` : null,
          task.error ? `  error          ${task.error}` : null,
        ].filter((line): line is string => Boolean(line)),
      );
      lines.push("");
    }
    trimTrailingBlankLines(lines);
  }

  if (overlay.planRequests.length > 0) {
    lines.push("", "pending plan approvals:");
    for (const request of overlay.planRequests) {
      lines.push(
        `  ${padDisplayRight(request.requestId, 14)} ${request.from} -> ${request.to} [${request.status}]`,
        `    updated       ${request.updated}`,
      );
    }
  }

  if (overlay.shutdownRequests.length > 0) {
    lines.push("", "pending shutdown requests:");
    for (const request of overlay.shutdownRequests) {
      lines.push(
        `  ${padDisplayRight(request.requestId, 14)} ${request.from} -> ${request.to} [${request.status}]`,
        `    updated       ${request.updated}`,
      );
    }
  }

  return lines;
}

function formatSnapshotActions(
  actions: DelegationActionAffordances,
): string | null {
  const entries: Array<readonly [label: string, enabled: boolean]> = [];

  if (typeof actions.reply === "boolean") {
    entries.push(["reply", actions.reply]);
  }
  if (typeof actions.interrupt === "boolean") {
    entries.push(["interrupt", actions.interrupt]);
  }
  if (typeof actions.waitReady === "boolean") {
    entries.push(["wait-ready", actions.waitReady]);
  }

  return entries.length > 0 ? formatSnapshotActionSummary(entries) : null;
}

function formatOverlayUnavailableLine(entry: string): string {
  const separatorIndex = entry.indexOf(":");
  if (separatorIndex < 0) {
    return `status           ${entry}`;
  }

  const label = entry.slice(0, separatorIndex).trim() || "status";
  const value = entry.slice(separatorIndex + 1).trim();
  return `${padDisplayRight(label, 16)} ${value || "(unknown)"}`;
}

function buildCompactBackgroundDelegationSummary(
  delegations: readonly DelegationView[],
): string | null {
  const activeDelegations = delegations.filter(
    (delegation) =>
      delegation.kind !== "teammate" &&
      (delegation.status === "running" || delegation.status === "queued"),
  );
  if (activeDelegations.length === 0) {
    return null;
  }

  const first = activeDelegations[0]!;
  const label = normalizeSnapshotValue(first.label) ?? first.id;
  if (activeDelegations.length === 1) {
    const noun = first.kind === "background_command" ? "cmd" : "bg";
    return `${label} ${noun} ${first.status}`;
  }

  return `${label} +${activeDelegations.length - 1} bg`;
}

function trimTrailingBlankLines(lines: string[]): void {
  while (lines.length > 0 && lines[lines.length - 1]?.length === 0) {
    lines.pop();
  }
}

function formatSnapshotActionSummary(
  actions: ReadonlyArray<readonly [label: string, enabled: boolean]>,
): string {
  return actions
    .map(([label, enabled]) => `${label} ${enabled ? "yes" : "no"}`)
    .join("  ");
}

function normalizeSnapshotValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function styleText(
  text: string,
  tone: TextTone,
  weight: TextWeight = "normal",
): string {
  if (!shouldUseColor()) {
    return text;
  }

  const codes: string[] = [];
  if (weight === "bold") {
    codes.push("1");
  }

  switch (tone) {
    case "muted":
      codes.push("2");
      break;
    case "accent":
      codes.push("36");
      break;
    case "success":
      codes.push("32");
      break;
    case "warning":
      codes.push("33");
      break;
    case "danger":
      codes.push("31");
      break;
  }

  return `\u001b[${codes.join(";")}m${text}\u001b[0m`;
}

function shouldUseColor(): boolean {
  if (envForcesColor()) {
    return true;
  }
  if (envRequestsNoColor()) {
    return false;
  }

  const term = (process.env.TERM ?? "").toLowerCase();
  if (term === "dumb") {
    return false;
  }

  const stdout = process.stdout;
  if (
    stdout.isTTY ||
    (typeof stdout.getColorDepth === "function" && stdout.getColorDepth() > 1)
  ) {
    return true;
  }

  const termProgram = (process.env.TERM_PROGRAM ?? "").toLowerCase();
  if (termProgram === "vscode" || termProgram === "tmux") {
    return true;
  }

  if ((process.env.COLORTERM ?? "").length > 0) {
    return true;
  }

  return (
    term.includes("256color") ||
    term.includes("color") ||
    term.startsWith("screen") ||
    term.startsWith("xterm")
  );
}

function envForcesColor(): boolean {
  return (
    isEnabledFlag(process.env.FORCE_COLOR) ||
    isEnabledFlag(process.env.CLICOLOR_FORCE)
  );
}

function envRequestsNoColor(): boolean {
  if (
    isEnabledFlag(process.env.STEP_CLI_NO_COLOR) ||
    isEnabledFlag(process.env.NO_COLOR)
  ) {
    return true;
  }
  return process.env.CLICOLOR === "0";
}

function isEnabledFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    (normalized !== "0" && normalized !== "false" && normalized !== "no")
  );
}

function buildHeroCard(lines: string[]): string {
  return formatBox(lines, Math.min(76, Math.max(48, getTerminalWidth() - 2)));
}

function formatBox(lines: string[], width: number): string {
  const innerWidth = Math.max(20, width - 4);
  const top = styleText(`+${"-".repeat(innerWidth + 2)}+`, "muted");
  const body = lines.map((line, index) => {
    const rendered = truncateInlineText(line, innerWidth);
    const padded = rendered.padEnd(innerWidth, " ");
    const content = index === 0 ? styleText(padded, "accent", "bold") : padded;
    return `${styleText("|", "muted")} ${content} ${styleText("|", "muted")}`;
  });
  return [top, ...body, top].join("\n");
}

function formatCallout(label: string, message: string, tone: TextTone): string {
  return `${styleText(`${label}:`, tone, "bold")} ${message}`;
}

function buildComposerDivider(): string {
  const width = Math.min(84, Math.max(28, getTerminalWidth() - 2));
  return `${styleText("-".repeat(width), "muted")}\n`;
}

function formatStreamEvent(
  label: string,
  message: string,
  tone: TextTone,
): string {
  const trimmedLabel = truncateInlineText(label, 8).padEnd(8, " ");
  return `${styleText("|", "muted")} ${styleText(trimmedLabel, tone, "bold")} ${message}`;
}

function formatToolStreamPreview(
  toolName: string,
  rawArgs: string | undefined,
  inspection?: ToolCallInspection,
): string {
  const inspectionHint =
    inspection?.inputHint ||
    inspection?.fileOperations?.[0] ||
    inspection?.touchedPaths?.[0];
  if (inspectionHint) {
    return `${toolName} · ${truncateInlineText(inspectionHint, 96)}`;
  }

  const parsedArgs = parseToolStreamArgs(rawArgs);
  if (!parsedArgs) {
    return toolName;
  }

  if (toolName === "update_plan") {
    const plan = Array.isArray(parsedArgs.plan) ? parsedArgs.plan : [];
    const firstItem = plan[0];
    const firstStep =
      firstItem &&
      typeof firstItem === "object" &&
      !Array.isArray(firstItem) &&
      typeof firstItem.step === "string"
        ? firstItem.step.trim()
        : "";

    if (firstStep) {
      return `${toolName} · ${plan.length} item(s) · ${truncateInlineText(firstStep, 72)}`;
    }

    return `${toolName} · ${plan.length} item(s)`;
  }

  if (toolName === "run_command") {
    const command =
      typeof parsedArgs.command === "string" ? parsedArgs.command.trim() : "";
    return command
      ? `${toolName} · ${truncateInlineText(command, 96)}`
      : toolName;
  }

  if (
    toolName === "list_directory" ||
    toolName === "read_file" ||
    toolName === "write_file" ||
    toolName === "edit_file"
  ) {
    const targetPath =
      typeof parsedArgs.path === "string" ? parsedArgs.path.trim() : "";
    return targetPath
      ? `${toolName} · ${truncateInlineText(targetPath, 96)}`
      : toolName;
  }

  return toolName;
}

function parseToolStreamArgs(
  rawArgs: string | undefined,
): Record<string, unknown> | null {
  if (!rawArgs || rawArgs.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawArgs) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function formatResponseLabel(): string {
  return styleText("assistant", "muted", "bold");
}

function classifyNoticeTone(notice: string): TextTone {
  const normalized = notice.toLowerCase();
  if (normalized.includes("failed") || normalized.includes("mismatch")) {
    return "warning";
  }
  if (normalized.includes("resumed") || normalized.includes("loaded")) {
    return "success";
  }
  return "muted";
}

function truncateInlineText(value: string, maxChars: number): string {
  return truncateInlineByWidth(value, maxChars);
}

function getTerminalWidth(): number {
  return process.stdout.columns ?? 80;
}

function renderWelcomeBrandMark(width: number): string {
  const rows = getBrandMarkRows(width < 64 ? "compact" : "full");
  return rows
    .map((row) => {
      const leftPad = Math.max(0, Math.floor((width - visibleLength(row)) / 2));
      return `${" ".repeat(leftPad)}${styleText(row, "accent", "bold")}`;
    })
    .join("\n");
}

function renderExitBrandMark(): string {
  const width = Math.min(76, Math.max(48, getTerminalWidth() - 2));
  const rows = getBrandMarkRows(width < 64 ? "compact" : "full");
  return rows
    .map((row) => {
      const leftPad = Math.max(0, Math.floor((width - visibleLength(row)) / 2));
      return `${" ".repeat(leftPad)}${styleText(row, "accent", "bold")}`;
    })
    .join("\n");
}

function visibleLength(value: string): number {
  return displayVisibleLength(value);
}

function padDisplayRight(value: string, width: number): string {
  const padding = Math.max(0, width - visibleLength(value));
  return `${value}${" ".repeat(padding)}`;
}

async function promptForToolApproval(
  request: ToolApprovalRequest,
  policy: ToolPolicy,
): Promise<ToolApprovalDecision> {
  const hasInteractiveTty = process.stdin.isTTY && process.stdout.isTTY;
  if (!hasInteractiveTty) {
    return policy.getNonInteractiveBehavior() === "allow"
      ? "allow-once"
      : "deny";
  }

  const rl = readline.createInterface({
    input,
    output,
    terminal: true,
  });

  const preview =
    request.rawArgs.length > 240
      ? `${request.rawArgs.slice(0, 237)}...`
      : request.rawArgs;

  try {
    output.write(
      [
        "",
        formatHeading("Approval Required"),
        formatInfoLine("tool", request.toolName),
        formatInfoLine("risk", request.risk),
        formatInfoLine("reason", request.reason),
        formatInfoLine("args", preview || "(none)"),
        formatInfoLine(
          "choices",
          "y once  a exact-call  t trust-tool  n deny  x deny-tool",
        ),
        "",
      ].join("\n"),
    );

    // OpenClaw-style: allow-once | allow-always | deny
    // Extra convenience: trust/deny-tool persist as a ToolPolicy override (saved in session snapshots).
    while (true) {
      const answer = (await rl.question(buildDecisionPrompt()))
        .trim()
        .toLowerCase();

      if (answer === "y" || answer === "yes") {
        return "allow-once";
      }

      if (answer === "a" || answer === "always") {
        return "allow-always";
      }

      if (answer === "t" || answer === "tool" || answer === "trust") {
        policy.setOverride(request.toolName, "allow");
        output.write(`[policy] tool override set: ${request.toolName}=allow\n`);
        return "allow-once";
      }

      if (answer === "x" || answer === "never" || answer === "deny-always") {
        policy.setOverride(request.toolName, "deny");
        output.write(`[policy] tool override set: ${request.toolName}=deny\n`);
        return "deny";
      }

      if (answer === "" || answer === "n" || answer === "no") {
        return "deny";
      }

      if (answer === "?" || answer === "help") {
        output.write(
          [
            formatHeading("Approval Options"),
            formatCommandLine("y", "Allow once and prompt again next time"),
            formatCommandLine(
              "a",
              "Allow this exact call signature without prompting again",
            ),
            formatCommandLine(
              "t",
              "Trust the entire tool for the current session",
            ),
            formatCommandLine("n", "Deny this request"),
            formatCommandLine(
              "x",
              "Deny the entire tool for the current session",
            ),
            "",
          ].join("\n"),
        );
        continue;
      }

      output.write(`Unrecognized decision: ${answer}. Type '?' for help.\n`);
    }
  } finally {
    rl.close();
  }
}

async function promptForUserClarification(
  request: UserClarificationRequest,
): Promise<UserClarificationResponse> {
  const hasInteractiveTty = process.stdin.isTTY && process.stdout.isTTY;
  if (!hasInteractiveTty) {
    return {
      cancelled: true,
      reason:
        "Interactive terminal input is unavailable for user clarification.",
    };
  }

  const rl = readline.createInterface({
    input,
    output,
    terminal: true,
  });

  const options = Array.isArray(request.options) ? request.options : [];
  const helpLines = buildClarificationHelpLines(request);

  try {
    const lines = [
      "",
      formatHeading("Clarification Required"),
      formatInfoLine("question", request.question),
    ];

    if (request.reason) {
      lines.push(formatInfoLine("reason", request.reason));
    }

    if (options.length > 0) {
      lines.push(formatInfoLine("options", `${options.length} choice(s)`));
      lines.push(
        ...options.map(
          (option, index) => `  ${formatClarificationOption(option, index)}`,
        ),
      );
    } else {
      lines.push(formatInfoLine("options", "(none)"));
    }

    lines.push(
      formatInfoLine(
        "choices",
        clarificationAllowsFreeform(request)
          ? "number / label / freeform text, Enter to cancel"
          : "number / label, Enter to cancel",
      ),
      "",
    );

    output.write(lines.join("\n"));

    while (true) {
      const rawAnswer = await rl.question("clarify> ");
      if (rawAnswer.trim().length === 0) {
        return {
          cancelled: true,
          reason: "User skipped clarification.",
        };
      }

      const parsed = parseClarificationAnswer(request, rawAnswer);
      if (parsed.kind === "answer" || parsed.kind === "cancel") {
        return parsed.response;
      }

      if (parsed.kind === "help") {
        output.write(
          [
            formatHeading("Clarification Help"),
            ...helpLines.map((line) => formatCommandLine("·", line)),
            "",
          ].join("\n"),
        );
        continue;
      }

      output.write(`${parsed.message}\n`);
    }
  } finally {
    rl.close();
  }
}

const APPROVALS_USAGE =
  "/approvals [confirm|auto|strict|read-only|workspace-write|full-access|default] [allow|deny]";

function mapCurrentApprovalPreset(
  mode: ApprovalMode,
  nonInteractiveApproval: NonInteractiveApproval,
): string | null {
  if (mode === "strict" && nonInteractiveApproval === "deny") {
    return "read-only";
  }
  if (mode === "confirm" && nonInteractiveApproval === "deny") {
    return "auto-preset";
  }
  if (mode === "auto" && nonInteractiveApproval === "allow") {
    return "full-access";
  }
  return null;
}

function normalizeSlashCommand(command: string): string {
  const normalized = command.trim().toLowerCase();
  switch (normalized) {
    case "/approval":
    case "/permission":
    case "/permissions":
      return "/approvals";
    default:
      return normalized;
  }
}

function parseSlashCommandLine(line: string): ParsedSlashCommand | null {
  if (!line.startsWith("/")) {
    return null;
  }

  const [command, ...rest] = line.split(/\s+/);
  return {
    command: command ?? "",
    normalizedCommand: normalizeSlashCommand(command ?? ""),
    rest,
  };
}

function parseApprovalsCommandArgs(
  args: string[],
  current: {
    mode: ApprovalMode;
    nonInteractiveApproval: NonInteractiveApproval;
  },
):
  | {
      mode: ApprovalMode;
      nonInteractiveApproval: NonInteractiveApproval;
      preset?: string;
    }
  | {
      error: string;
    } {
  const tokens = args
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  if (tokens.length === 0) {
    return {
      mode: current.mode,
      nonInteractiveApproval: current.nonInteractiveApproval,
    };
  }

  if (tokens.length > 2) {
    return {
      error: "Too many arguments for /approvals.",
    };
  }

  let mode = current.mode;
  let nonInteractiveApproval = current.nonInteractiveApproval;
  let preset: string | undefined;

  const [first, second] = tokens;
  switch (first) {
    case "auto-preset":
      mode = "confirm";
      nonInteractiveApproval = "deny";
      preset = "auto";
      break;
    case "confirm":
    case "auto":
    case "strict":
      mode = first;
      break;
    case "default":
    case "ask":
      mode = "confirm";
      nonInteractiveApproval = "deny";
      preset = first;
      break;
    case "read-only":
      mode = "strict";
      nonInteractiveApproval = "deny";
      preset = first;
      break;
    case "workspace-write":
      mode = "confirm";
      nonInteractiveApproval = "deny";
      preset = first;
      break;
    case "full-access":
      mode = "auto";
      nonInteractiveApproval = "allow";
      preset = first;
      break;
    case "allow":
    case "deny":
      nonInteractiveApproval = first;
      break;
    default:
      return {
        error: `Unsupported approval mode: ${first}`,
      };
  }

  if (second !== undefined) {
    if (second !== "allow" && second !== "deny") {
      return {
        error: `Unsupported non-interactive approval: ${second}`,
      };
    }
    nonInteractiveApproval = second;
  }

  return {
    mode,
    nonInteractiveApproval,
    ...(preset ? { preset } : {}),
  };
}

function throwIfAbortRequested(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }

  throw new Error(toErrorMessage(reason) || "Operation aborted.");
}

function isInterruptErrorMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("run interrupted by user") ||
    normalized.includes("request aborted")
  );
}

function didTurnSucceed(result: AgentRunResult): boolean {
  const completion = [...result.actions]
    .reverse()
    .find((action) => action.kind === "goal_complete");
  return completion?.success === true;
}

function describeRunFailure(result: Pick<AgentRunResult, "output">): string {
  const message = result.output.trim();
  return message.length > 0
    ? message
    : "The last run failed. Open Transcript (^T) for details.";
}

function classifyStateHookImportance(
  state: AgentStateSnapshot["state"],
): StepCliSessionHookEventPayload["importance"] {
  if (
    state === "tool_execution" ||
    state === "context_compaction" ||
    state === "final_response" ||
    state === "goal_complete" ||
    state === "failed"
  ) {
    return "high";
  }

  if (
    state === "before_model_request_hooks" ||
    state === "model_request" ||
    state === "apply_tool_results"
  ) {
    return "medium";
  }

  return "low";
}

function classifyActionHookImportance(
  kind: AgentLoopAction["kind"],
): StepCliSessionHookEventPayload["importance"] {
  if (
    kind === "context_compaction" ||
    kind === "fresh_attempt_restart" ||
    kind === "goal_complete"
  ) {
    return "high";
  }

  return "medium";
}

function normalizeHookSource(
  value: unknown,
): StepCliSessionHookEventPayload["source"] | null {
  return value === "main" ||
    value === "subagent" ||
    value === "teammate" ||
    value === "system"
    ? value
    : null;
}

function normalizeHookHarnessType(
  value: unknown,
): StepCliSessionHookEventPayload["harnessType"] | null {
  return value === "main" ||
    value === "subagent" ||
    value === "teammate" ||
    value === "unknown"
    ? value
    : null;
}

function normalizeHookLane(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeHookIdentifier(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function describeActionTitle(action: AgentLoopAction): string {
  if (action.kind === "goal_start") {
    return "Goal started";
  }

  if (action.kind === "context_compaction") {
    return "Context compacted";
  }

  if (action.kind === "fresh_attempt_restart") {
    return "Fresh attempt restarted";
  }

  return action.success === false ? "Goal failed" : "Goal completed";
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function sanitizeSessionAssetBasename(value: string): string {
  const normalized = value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 64) : "image";
}

function cloneInteractiveAttachments(
  attachments: UserAttachment[],
): UserAttachment[] {
  return attachments.map((attachment) =>
    attachment.source.type === "url"
      ? {
          kind: "image",
          source: {
            type: "url",
            url: attachment.source.url,
          },
        }
      : {
          kind: "image",
          source: {
            type: "file",
            path: attachment.source.path,
          },
        },
  );
}

function buildInteractiveAttachmentLines(
  attachments: UserAttachment[],
): string[] {
  if (attachments.length === 0) {
    return ["(none)                 no pending image attachments"];
  }

  return attachments.map(
    (attachment, index) =>
      `${formatInteractiveAttachmentReference(index).padEnd(12)} ${describeInteractiveAttachment(attachment)}`,
  );
}

function describeInteractiveAttachment(attachment: UserAttachment): string {
  return attachment.source.type === "url"
    ? attachment.source.url
    : attachment.source.path;
}

function formatInteractiveAttachmentReference(index: number): string {
  return `[Image #${index + 1}]`;
}

function removeInteractiveAttachment(
  attachments: UserAttachment[],
  rawIndex: string | undefined,
): {
  next: UserAttachment[];
  removed: Array<{
    attachment: UserAttachment;
    index: number;
  }>;
  error?: string;
} {
  if (attachments.length === 0) {
    return {
      next: [],
      removed: [],
      error: "No pending image attachments.",
    };
  }

  if (!rawIndex || rawIndex.length === 0) {
    return {
      next: [],
      removed: attachments.map((attachment, index) => ({ attachment, index })),
    };
  }

  const parsed = Number.parseInt(rawIndex, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > attachments.length) {
    return {
      next: cloneInteractiveAttachments(attachments),
      removed: [],
      error: `Attachment index must be between 1 and ${attachments.length}.`,
    };
  }

  const zeroBasedIndex = parsed - 1;
  return {
    next: attachments.filter((_, index) => index !== zeroBasedIndex),
    removed: [
      {
        attachment: attachments[zeroBasedIndex]!,
        index: zeroBasedIndex,
      },
    ],
  };
}
