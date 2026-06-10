import { randomUUID } from "node:crypto";
import type { ChatCompletionClient } from "../model-client.js";
import type {
  LoadedToolPlugin,
  PluginHookContext,
  PluginHookResult,
  PluginUserPromptSubmitContext,
  PluginUserPromptSubmitResult,
  ToolPluginContext,
} from "../plugins/types.js";
import { getToolSecurityIssue } from "../tools/security.js";
import { ToolRuntime, type ToolRuntimeState } from "../tools/runtime.js";
import type {
  AgentOperatingMode,
  AgentRunConfig,
  StepCliInteractionProfile,
  ToolApprovalHandler,
  ToolExecutionContext,
  ToolPresentationConfig,
  ToolPermissionPolicy,
  ToolSpec,
  UserClarificationHandler,
  UserTurnInput,
} from "@step-cli/protocol";
import {
  AgentLoop,
  type AgentLoopOptions,
  type AgentRunResult,
} from "./agent-loop.js";
import {
  ConversationMemory,
  type ContextRotReport,
  type ConversationMemoryState,
  type FreshAttemptProgressStore,
  type MemoryConfig,
} from "./conversation-memory.js";
import type { ConversationTranscriptStore } from "./conversation-memory-transcript.js";
import {
  cloneExecutionProfile,
  resolveExecutionProfile,
  runWithHarnessContext,
  type AgentExecutionProfile,
  type AgentExecutionProfileOverrides,
  type AgentHarnessContext,
  type AgentHarnessIdentity,
  type AgentHarnessKind,
} from "./harness-context.js";

export interface AgentHarnessOptions {
  id: string;
  kind: AgentHarnessKind;
  name: string;
  depth: number;
  workspaceRoot: string;
  parentId?: string;
  sessionId?: string;
  goalId?: string;
  executionProfile?: AgentExecutionProfileOverrides;
  systemPrompt?: string;
  memoryState?: ConversationMemoryState;
  toolRuntimeState?: unknown;
  approvalHandler?: ToolApprovalHandler;
  allowedTools?: string[];
  hooks?: AgentLoopOptions["hooks"];
  signal?: AbortSignal;
}

export interface AgentHarnessState {
  identity: AgentHarnessIdentity;
  memory: ConversationMemoryState;
  toolRuntime: ToolRuntimeState;
  allowedTools: string[];
}

export interface AgentHarnessCreation {
  harness: AgentHarness;
  warnings: string[];
}

export interface AgentHarnessFactoryOptions {
  model: string;
  client: ChatCompletionClient;
  defaultSystemPrompt: string;
  operatingMode?: AgentOperatingMode;
  toolPresentation?: Partial<ToolPresentationConfig>;
  memoryConfig: MemoryConfig;
  runConfig: AgentRunConfig;
  commandTimeoutMs: number;
  commandOutputLimit: number;
  permissionPolicy?: ToolPermissionPolicy;
  approvalHandler?: ToolApprovalHandler;
  clarificationHandler?: UserClarificationHandler;
  plugins: LoadedToolPlugin[];
  interactionProfile: StepCliInteractionProfile;
  baseHooks?: AgentLoopOptions["hooks"];
  progressStore?: FreshAttemptProgressStore;
  transcriptStore?: ConversationTranscriptStore;
  beforeModelRequest?: (
    context: PluginHookContext,
  ) => Promise<PluginHookResult | void> | PluginHookResult | void;
  userPromptSubmit?: (
    context: PluginUserPromptSubmitContext,
  ) =>
    | Promise<PluginUserPromptSubmitResult | void>
    | PluginUserPromptSubmitResult
    | void;
}

export class AgentHarness {
  private readonly context: AgentHarnessIdentity;
  private readonly memory: ConversationMemory;
  private readonly tools: ToolRuntime;
  private readonly agent: AgentLoop;
  private readonly allowedTools: string[];

  constructor(input: {
    context: AgentHarnessIdentity;
    memory: ConversationMemory;
    tools: ToolRuntime;
    agent: AgentLoop;
    allowedTools: string[];
  }) {
    this.context = input.context;
    this.memory = input.memory;
    this.tools = input.tools;
    this.agent = input.agent;
    this.allowedTools = [...input.allowedTools];
  }

  getContext(): AgentHarnessIdentity {
    return {
      ...this.context,
      executionProfile: cloneExecutionProfile(this.context.executionProfile),
    };
  }

  getMemory(): ConversationMemory {
    return this.memory;
  }

  getTools(): ToolRuntime {
    return this.tools;
  }

  exportState(): AgentHarnessState {
    return {
      identity: this.getContext(),
      memory: this.memory.exportState(),
      toolRuntime: this.tools.exportState(),
      allowedTools: [...this.allowedTools],
    };
  }

  finalize(): void {
    if (this.context.lifecycleState === "finalized") {
      return;
    }

    if (this.context.lifecycleState === "active") {
      throw new Error(
        `Harness '${this.context.name}' cannot be finalized while active`,
      );
    }

    this.context.lifecycleState = "finalized";
  }

  async run(
    prompt: string | UserTurnInput,
    signal?: AbortSignal,
  ): Promise<AgentRunResult> {
    this.assertRunnable();
    this.context.lifecycleState = "active";
    this.agent.setSignal(signal);
    this.tools.setSignal(signal);

    try {
      const firstAttempt = await this.runAttempt(prompt);
      const contextRot = this.memory.getContextRotReport();
      if (!shouldTriggerFreshAttempt(firstAttempt, contextRot)) {
        return firstAttempt;
      }

      const reason = contextRot.reasons.join("; ") || "context rot detected";
      const checkpoint = await this.memory.prepareFreshAttempt({
        workspaceRoot: this.context.workspaceRoot,
        reason,
        repeatedIssue: contextRot.repeatedIssue,
      });
      const restartAction = this.agent.dispatchExternalAction({
        kind: "fresh_attempt_restart",
        step: firstAttempt.steps,
        toolCalls: firstAttempt.toolCalls,
        summary: buildFreshRestartSummary(reason, checkpoint.progressPath),
        restart: {
          reason,
          progressPath: checkpoint.progressPath,
          fromAttemptId: firstAttempt.run.attemptId,
          nextAttemptNumber: this.context.attemptCount + 1,
        },
        ...this.buildRunMetadata({
          attemptId: firstAttempt.run.attemptId,
          runStartedAt: firstAttempt.run.runStartedAt,
        }),
      });
      const freshAttempt = await this.runAttempt(prompt);

      return {
        output: freshAttempt.output,
        steps: firstAttempt.steps + freshAttempt.steps,
        toolCalls: firstAttempt.toolCalls + freshAttempt.toolCalls,
        run: freshAttempt.run,
        actions: [
          ...firstAttempt.actions,
          restartAction,
          ...freshAttempt.actions,
        ],
        stateTimeline: [
          ...firstAttempt.stateTimeline,
          ...freshAttempt.stateTimeline,
        ],
      };
    } finally {
      this.agent.setSignal(undefined);
      this.tools.setSignal(undefined);
      this.context.lifecycleState = "inactive";
    }
  }

  private async runAttempt(
    prompt: string | UserTurnInput,
  ): Promise<AgentRunResult> {
    this.context.attemptCount += 1;
    const runContext: AgentHarnessContext = {
      ...this.context,
      executionProfile: cloneExecutionProfile(this.context.executionProfile),
      attemptId: randomUUID(),
      runStartedAt: new Date().toISOString(),
      delegationSnapshotProvider: () => ({
        memoryState: this.memory.exportState(),
      }),
    };

    return runWithHarnessContext(runContext, async () =>
      this.agent.run(prompt),
    );
  }

  private assertRunnable(): void {
    if (this.context.lifecycleState === "finalized") {
      throw new Error(
        `Harness '${this.context.name}' has already been finalized`,
      );
    }

    if (this.context.lifecycleState === "active") {
      throw new Error(`Harness '${this.context.name}' is already running`);
    }
  }

  private buildRunMetadata(
    overrides: Partial<
      Pick<AgentHarnessContext, "attemptId" | "runStartedAt">
    > = {},
  ): AgentRunResult["run"] {
    return {
      harnessId: this.context.id,
      harnessType: this.context.kind,
      harnessName: this.context.name,
      sessionId: this.context.sessionId,
      goalId: this.context.goalId,
      attemptId: overrides.attemptId,
      runStartedAt: overrides.runStartedAt,
      workspaceMode: this.context.executionProfile.workspaceMode,
      memoryMode: this.context.executionProfile.memoryMode,
      priority: this.context.executionProfile.priority,
    };
  }
}

export class AgentHarnessFactory {
  private readonly operatingMode: AgentOperatingMode;
  private readonly model: string;
  private readonly client: ChatCompletionClient;
  private readonly defaultSystemPrompt: string;
  private readonly memoryConfig: MemoryConfig;
  private readonly runConfig: AgentRunConfig;
  private readonly toolPresentation?: Partial<ToolPresentationConfig>;
  private readonly commandTimeoutMs: number;
  private readonly commandOutputLimit: number;
  private readonly permissionPolicy?: ToolPermissionPolicy;
  private readonly approvalHandler?: ToolApprovalHandler;
  private readonly clarificationHandler?: UserClarificationHandler;
  private readonly plugins: LoadedToolPlugin[];
  private readonly interactionProfile: StepCliInteractionProfile;
  private readonly baseHooks?: AgentLoopOptions["hooks"];
  private readonly progressStore?: FreshAttemptProgressStore;
  private readonly transcriptStore?: ConversationTranscriptStore;
  private readonly beforeModelRequest?: AgentHarnessFactoryOptions["beforeModelRequest"];
  private readonly userPromptSubmit?: AgentHarnessFactoryOptions["userPromptSubmit"];

  constructor(options: AgentHarnessFactoryOptions) {
    this.operatingMode = options.operatingMode ?? "normal";
    this.model = options.model;
    this.client = options.client;
    this.defaultSystemPrompt = options.defaultSystemPrompt;
    this.memoryConfig = options.memoryConfig;
    this.runConfig = options.runConfig;
    this.toolPresentation = options.toolPresentation;
    this.commandTimeoutMs = options.commandTimeoutMs;
    this.commandOutputLimit = options.commandOutputLimit;
    this.permissionPolicy = options.permissionPolicy;
    this.approvalHandler = options.approvalHandler;
    this.clarificationHandler = options.clarificationHandler;
    this.plugins = [...options.plugins];
    this.interactionProfile = { ...options.interactionProfile };
    this.baseHooks = options.baseHooks;
    this.progressStore = options.progressStore;
    this.transcriptStore = options.transcriptStore;
    this.beforeModelRequest = options.beforeModelRequest;
    this.userPromptSubmit = options.userPromptSubmit;
  }

  getDefaultSystemPrompt(): string {
    return this.defaultSystemPrompt;
  }

  getInteractionProfile(): StepCliInteractionProfile {
    return {
      ...this.interactionProfile,
    };
  }

  getDefaultExecutionProfile(kind: AgentHarnessKind): AgentExecutionProfile {
    return resolveExecutionProfile(kind);
  }

  buildToolSpecs(context: ToolPluginContext): {
    specs: ToolSpec[];
    warnings: string[];
  } {
    const specs: ToolSpec[] = [];
    const warnings: string[] = [];

    for (const loaded of this.plugins) {
      try {
        const registered = loaded.plugin.register(context);
        for (const spec of registered) {
          const issue = getToolSecurityIssue(spec);
          if (issue) {
            warnings.push(
              `Plugin '${loaded.plugin.id}' skipped tool '${spec.definition.function.name}': ${issue}`,
            );
            continue;
          }
          specs.push(spec);
        }
      } catch (error) {
        warnings.push(
          `Failed to register plugin '${loaded.plugin.id}' for workspace '${context.workspaceRoot}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const filtered = filterToolSpecsForOperatingMode(specs, this.operatingMode);
    if (filtered.hidden.length > 0) {
      warnings.push(
        `Operating mode '${this.operatingMode}' hid ${filtered.hidden.length} tool(s): ${filtered.hidden.join(", ")}`,
      );
    }

    return {
      specs: filtered.specs,
      warnings,
    };
  }

  createHarness(options: AgentHarnessOptions): AgentHarnessCreation {
    const identity: AgentHarnessIdentity = {
      id: options.id,
      kind: options.kind,
      name: options.name,
      depth: options.depth,
      workspaceRoot: options.workspaceRoot,
      parentId: options.parentId,
      sessionId: options.sessionId ?? randomUUID(),
      goalId:
        options.goalId ??
        (options.kind === "main"
          ? "main:root"
          : `${options.kind}:${options.id}`),
      executionProfile: resolveExecutionProfile(
        options.kind,
        options.executionProfile,
      ),
      lifecycleState: "unconfigured",
      attemptCount: 0,
    };

    const built = this.buildToolSpecs({
      workspaceRoot: options.workspaceRoot,
      interactionProfile: this.getInteractionProfile(),
      harness: {
        kind: identity.kind,
        name: identity.name,
        depth: identity.depth,
        parentId: identity.parentId,
        sessionId: identity.sessionId,
        goalId: identity.goalId,
        executionProfile: cloneExecutionProfile(identity.executionProfile),
      },
    });
    const filtered = filterToolSpecs(built.specs, options.allowedTools);

    const memory = new ConversationMemory(this.memoryConfig, {
      sessionId: identity.sessionId,
      progressStore: this.progressStore,
      transcriptStore: this.transcriptStore,
    });
    if (options.memoryState) {
      memory.loadState(options.memoryState);
    }

    const runtimeContext: ToolExecutionContext = {
      workspaceRoot: options.workspaceRoot,
      commandTimeoutMs: this.commandTimeoutMs,
      commandOutputLimit: this.commandOutputLimit,
      interaction: {
        profile: this.getInteractionProfile(),
        requestUserClarification: this.clarificationHandler,
      },
    };

    const hooks = mergeAgentLoopHooks(this.baseHooks, options.hooks);

    const tools = new ToolRuntime(filtered.specs, runtimeContext, {
      permissionPolicy: this.permissionPolicy,
      approvalHandler: options.approvalHandler ?? this.approvalHandler,
      presentation: this.toolPresentation,
      beforeNestedToolExecution: hooks
        ? async (info) => {
            await hooks.beforeToolExecution?.(info);
          }
        : undefined,
    });
    if (options.toolRuntimeState) {
      tools.loadState(options.toolRuntimeState);
    }

    const agent = new AgentLoop({
      model: this.model,
      client: this.client,
      memory,
      tools,
      systemPrompt: options.systemPrompt ?? this.defaultSystemPrompt,
      workspaceRoot: options.workspaceRoot,
      beforeModelRequest: this.beforeModelRequest,
      userPromptSubmit: this.userPromptSubmit,
      config: this.runConfig,
      hooks,
      signal: options.signal,
    });

    identity.lifecycleState = "inactive";

    return {
      harness: new AgentHarness({
        context: identity,
        memory,
        tools,
        agent,
        allowedTools: filtered.persistedAllowedTools,
      }),
      warnings: [...built.warnings, ...filtered.warnings],
    };
  }
}

function mergeAgentLoopHooks(
  baseHooks: AgentLoopOptions["hooks"] | undefined,
  overrideHooks: AgentLoopOptions["hooks"] | undefined,
): AgentLoopOptions["hooks"] | undefined {
  if (!baseHooks) {
    return overrideHooks;
  }

  if (!overrideHooks) {
    return baseHooks;
  }

  return {
    onStep: (info) => {
      baseHooks.onStep?.(info);
      overrideHooks.onStep?.(info);
    },
    onModelStreamReset: (info) => {
      baseHooks.onModelStreamReset?.(info);
      overrideHooks.onModelStreamReset?.(info);
    },
    onModelTextDelta: (info) => {
      baseHooks.onModelTextDelta?.(info);
      overrideHooks.onModelTextDelta?.(info);
    },
    onModelToolCall: (info) => {
      baseHooks.onModelToolCall?.(info);
      overrideHooks.onModelToolCall?.(info);
    },
    onAssistantMessage: (info) => {
      baseHooks.onAssistantMessage?.(info);
      overrideHooks.onAssistantMessage?.(info);
    },
    beforeToolExecution: async (info) => {
      await baseHooks.beforeToolExecution?.(info);
      await overrideHooks.beforeToolExecution?.(info);
    },
    onToolStart: (info) => {
      baseHooks.onToolStart?.(info);
      overrideHooks.onToolStart?.(info);
    },
    onToolResult: (info) => {
      baseHooks.onToolResult?.(info);
      overrideHooks.onToolResult?.(info);
    },
    onAction: (action) => {
      baseHooks.onAction?.(action);
      overrideHooks.onAction?.(action);
    },
    onStateChange: (snapshot) => {
      baseHooks.onStateChange?.(snapshot);
      overrideHooks.onStateChange?.(snapshot);
    },
    onCheckpoint: async (info) => {
      await baseHooks.onCheckpoint?.(info);
      await overrideHooks.onCheckpoint?.(info);
    },
  };
}

function shouldTriggerFreshAttempt(
  result: AgentRunResult,
  report: ContextRotReport,
): boolean {
  if (!report.shouldRestart) {
    return false;
  }

  if (report.repeatedIssue) {
    return true;
  }

  return !didRunSucceed(result);
}

function didRunSucceed(result: AgentRunResult): boolean {
  const completion = [...result.actions]
    .reverse()
    .find((action) => action.kind === "goal_complete");
  return completion?.success === true;
}

function buildFreshRestartSummary(
  reason: string,
  progressPath: string | undefined,
): string {
  if (!progressPath) {
    return `Restarting with a fresh attempt: ${reason}`;
  }

  return `Restarting with a fresh attempt: ${reason} (progress: ${progressPath})`;
}

function filterToolSpecs(
  specs: ToolSpec[],
  allowedTools: string[] | undefined,
): { specs: ToolSpec[]; warnings: string[]; persistedAllowedTools: string[] } {
  const available = new Set(specs.map((spec) => spec.definition.function.name));
  const codeModeAvailable = available.has("exec") && available.has("wait");

  if (!allowedTools) {
    return {
      specs,
      warnings: [],
      persistedAllowedTools: specs.map((spec) => spec.definition.function.name),
    };
  }

  const requested = dedupeToolNames(allowedTools);
  const allowed = new Set(requested.filter((name) => available.has(name)));
  const requestedNestedTools = requested.some(
    (name) => available.has(name) && name !== "exec" && name !== "wait",
  );
  const requestedCodeModePublicTool = requested.some(
    (name) => name === "exec" || name === "wait",
  );

  if (
    codeModeAvailable &&
    (requestedNestedTools || requestedCodeModePublicTool)
  ) {
    allowed.add("exec");
    allowed.add("wait");
  }

  const warnings = requested
    .filter((name) => !available.has(name))
    .sort((left, right) => left.localeCompare(right))
    .map(
      (name) =>
        `Requested tool '${name}' is not available in this harness build.`,
    );

  return {
    specs: specs.filter((spec) => allowed.has(spec.definition.function.name)),
    warnings,
    persistedAllowedTools: specs
      .filter((spec) => allowed.has(spec.definition.function.name))
      .map((spec) => spec.definition.function.name),
  };
}

function dedupeToolNames(names: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const rawName of names) {
    const name = rawName.trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    normalized.push(name);
  }

  return normalized;
}

export function filterToolSpecsForOperatingMode(
  specs: ToolSpec[],
  mode: AgentOperatingMode,
): { specs: ToolSpec[]; hidden: string[] } {
  if (mode === "normal") {
    return {
      specs,
      hidden: [],
    };
  }

  const allowed: ToolSpec[] = [];
  const hidden: string[] = [];

  for (const spec of specs) {
    const name = spec.definition.function.name;
    const risk = spec.security.risk;
    const safeMeta =
      risk === "meta" && spec.operatingModes?.includes("plan") === true;

    if (risk === "read" || safeMeta) {
      allowed.push(spec);
      continue;
    }

    hidden.push(name);
  }

  hidden.sort((left, right) => left.localeCompare(right));

  return {
    specs: allowed,
    hidden,
  };
}
