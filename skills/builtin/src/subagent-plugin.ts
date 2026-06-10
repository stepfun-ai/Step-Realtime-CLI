import { randomUUID } from "node:crypto";
import {
  AgentHarnessFactory,
  type AgentHarness,
  type AgentHarnessOptions,
} from "@step-cli/core/agent/harness.js";
import {
  getHarnessContext,
  resolveExecutionProfile,
  type AgentDelegationSnapshot,
} from "@step-cli/core/agent/harness-context.js";
import {
  type AgentRunArtifactStore,
  persistAgentRunArtifact,
  renderAgentRunArtifactNotice,
  renderAgentRunInlineNotice,
} from "@step-cli/core/agent/run-artifact-store.js";
import type { AgentPresetRegistry } from "@step-cli/core/agent/agent-presets.js";
import { compileSubagentHarness } from "@step-cli/core/agent/scaffolding.js";
import {
  WorktreeManager,
  type ManagedWorktreeEntry,
} from "@step-cli/core/agent/worktree-manager.js";
import {
  parseJsonObject,
  readBooleanField,
  readIntegerField,
  readRequiredStringField,
  readStringField,
} from "@step-cli/core/tools/args.js";
import type {
  StepCliSessionHookEventPayload,
  ToolExecutionResult,
  ToolGroupingDescriptor,
  ToolSpec,
} from "@step-cli/protocol";
import { toErrorMessage } from "@step-cli/utils/error.js";
import { clamp } from "@step-cli/utils/math.js";
import { shortenLine, truncateText } from "@step-cli/utils/text.js";
import type { MutableRef } from "@step-cli/utils/mutable-ref.js";
import { isTopLevelMainHarness } from "@step-cli/core/plugins/tool-visibility.js";
import type {
  PluginHookContext,
  PluginHookResult,
  ToolPlugin,
} from "@step-cli/core/plugins/types.js";
import {
  compareBackgroundSubtaskRecords,
  isTaskBusy,
  parseSerializedBackgroundSubtask,
  renderNotification,
  renderNotifications,
  renderTaskDetails,
  renderTaskOverview,
  type BackgroundSubtaskActiveTurn,
  type BackgroundSubtaskLastRun,
  type BackgroundSubtaskNotification,
  type BackgroundSubtaskQueuedTurn,
  type BackgroundSubtaskStatus,
  type BackgroundSubtaskView,
  type SerializedBackgroundSubtask,
  type SerializedBackgroundSubtaskState,
  unknownTaskResult,
} from "@step-cli/core/plugins/subagent-state.js";

export type {
  BackgroundSubtaskStatus,
  BackgroundSubtaskView,
} from "@step-cli/core/plugins/subagent-state.js";

interface TaskArgs {
  prompt: string;
  description?: string;
  preset?: string;
  alias?: string;
  group?: string;
  contextMode?: TaskContextMode;
  isolateWorkspace?: boolean;
  worktreeName?: string;
}

interface TaskReplyArgs {
  taskId?: string;
  alias?: string;
  prompt: string;
}

type TaskWaitMode = "any" | "all" | "first_ready";
type TaskContextMode = "inherit" | "fresh";

interface TaskWaitArgs {
  taskId?: string;
  alias?: string;
  group?: string;
  waitFor?: TaskWaitMode;
  waitMs?: number;
}

interface TaskInterruptArgs {
  taskId?: string;
  alias?: string;
}

interface TaskListArgs {
  taskId?: string;
  alias?: string;
  group?: string;
}

interface TopLevelHarnessInfo {
  id: string;
  depth: number;
  sessionId: string;
  goalId: string;
  delegationSnapshot?: AgentDelegationSnapshot;
  attemptId: string | null;
}

type TaskHandleResolution =
  | {
      ok: true;
      task?: BackgroundSubtaskRecord;
    }
  | {
      ok: false;
      result: ToolExecutionResult;
    };

type TaskTargetResolution =
  | {
      ok: true;
      task?: BackgroundSubtaskRecord;
      tasks?: BackgroundSubtaskRecord[];
      label?: string;
    }
  | {
      ok: false;
      result: ToolExecutionResult;
    };

interface BackgroundSubtaskRecord {
  id: string;
  label: string;
  alias?: string;
  group?: string;
  parent: TopLevelHarnessInfo;
  status: BackgroundSubtaskStatus;
  createdAt: string;
  updatedAt: string;
  workspaceRoot: string;
  worktree?: ManagedWorktreeEntry;
  warnings: string[];
  systemPrompt: string;
  harness: AgentHarness;
  queue: BackgroundSubtaskQueuedTurn[];
  activeTurn?: BackgroundSubtaskActiveTurn;
  abortController?: AbortController;
  worker?: Promise<void>;
  lastRun: BackgroundSubtaskLastRun;
}

export interface SubagentToolPlugin extends ToolPlugin {
  getBackgroundViews(): BackgroundSubtaskView[];
}

type SubtaskHooksFactory = (
  name: string,
) => AgentHarnessOptions["hooks"] | undefined;
type SessionHookEmitter = (payload: StepCliSessionHookEventPayload) => void;

const MAIN_ORCHESTRATION_REMINDER = [
  "Delegation reminder:",
  "- If the current request can be decomposed into independent branches, launch those branches concurrently instead of serializing them.",
  "- You may issue multiple independent task_start or spawn_teammate calls in the same assistant turn when their work does not depend on each other.",
  "- Use task only for blocking one-shot delegation. Use task_start for finite background work and spawn_teammate for longer-lived collaborators.",
  "- Prefer isolate_workspace=true when parallel branches may edit overlapping files.",
].join("\n");

const DEFAULT_WAIT_MS = 5_000;
const MAX_WAIT_MS = 60_000;
const WAIT_POLL_MS = 200;
const SHUTDOWN_GRACE_MS = 5_000;
const MAX_BACKGROUND_SUBTASKS = 48;
const MAX_NOTIFICATION_HISTORY = 32;
const MAX_NOTIFICATION_DRAIN = 6;
const MAX_NOTIFICATION_CONTENT_CHARS = 1_800;
const MAX_NOTIFICATION_PREVIEW_CHARS = 900;
const TASK_ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TASK_GROUPING_SUMMARY =
  "Manage delegated subagents and background subtasks through one tool.";
const TASK_GROUPING_SECURITY = {
  risk: "meta",
  defaultMode: "allow",
} as const;
const TASK_GROUPING_PROPERTY_OVERRIDES = {
  prompt: {
    type: "string",
    description: "Prompt for the delegated subagent or background task turn.",
  },
} as const;

function createTaskGrouping(
  action: string,
  aliases: string[],
): ToolGroupingDescriptor {
  return {
    family: "task",
    summary: TASK_GROUPING_SUMMARY,
    action,
    aliases,
    propertyOverrides: TASK_GROUPING_PROPERTY_OVERRIDES,
    security: TASK_GROUPING_SECURITY,
  };
}

export function createSubagentPlugin(
  factoryRef: MutableRef<AgentHarnessFactory>,
  worktreeManager: WorktreeManager,
  artifactStore?: AgentRunArtifactStore,
  presetRegistry?: AgentPresetRegistry,
  subtaskHooksFactory?: SubtaskHooksFactory,
  sessionHookEmitter?: SessionHookEmitter,
): SubagentToolPlugin {
  const backgroundManager = new BackgroundSubtaskManager(
    factoryRef,
    worktreeManager,
    artifactStore,
    presetRegistry,
    subtaskHooksFactory,
    sessionHookEmitter,
  );

  return {
    id: "subagent-plugin",
    description:
      "Synchronous and background subagent delegation with parent-context handoff",
    register: (context) =>
      isTopLevelMainHarness(context)
        ? [
            createTaskTool(
              factoryRef,
              worktreeManager,
              artifactStore,
              presetRegistry,
            ),
            createTaskStartTool(backgroundManager),
            createTaskReplyTool(backgroundManager),
            createTaskWaitTool(backgroundManager),
            createTaskInterruptTool(backgroundManager),
            createTaskListTool(backgroundManager),
          ]
        : [],
    hooks: {
      beforeModelRequest: (context) =>
        backgroundManager.beforeModelRequest(context),
      onUserInterrupt: () => backgroundManager.interruptAll() > 0,
    },
    getBackgroundViews: () => backgroundManager.listViews(),
    exportState: () => backgroundManager.exportState(),
    loadState: (state) => {
      backgroundManager.loadState(state);
    },
    shutdown: async (reason) => {
      await backgroundManager.shutdown(reason);
    },
  };
}

function createTaskTool(
  factoryRef: MutableRef<AgentHarnessFactory>,
  worktreeManager: WorktreeManager,
  artifactStore?: AgentRunArtifactStore,
  presetRegistry?: AgentPresetRegistry,
): ToolSpec<TaskArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "task",
        description:
          "Run a synchronous one-shot subagent and wait for the final result. By default the subagent inherits a snapshot of the parent's context; set context_mode='fresh' to start without parent history. Use this only when the parent must block on the answer; use task_start for independent/background subtasks, including concurrent launches in the same turn.",
        parameters: {
          type: "object",
          required: ["prompt"],
          properties: {
            prompt: {
              type: "string",
              description:
                "Precise task for the delegated subagent to execute.",
            },
            description: {
              type: "string",
              description: "Short label for the delegated task.",
            },
            preset: {
              type: "string",
              description:
                "Optional delegated subagent preset, such as review, planner, or explore.",
            },
            context_mode: {
              type: "string",
              enum: ["inherit", "fresh"],
              description:
                "How much parent context to hand off. Defaults to 'inherit'; use 'fresh' to start without the parent's conversation snapshot.",
            },
            isolate_workspace: {
              type: "boolean",
              description:
                "Create or reuse a dedicated git worktree for this subagent.",
            },
            worktree_name: {
              type: "string",
              description:
                "Optional worktree lane name. Defaults to a sanitized task label.",
            },
          },
        },
      },
    },
    security: {
      risk: "meta",
      defaultMode: "allow",
    },
    grouping: createTaskGrouping("run", ["task"]),
    parseArgs: parseTaskArgs,
    inspect: ({ args }) => buildTaskInspection(args),
    execute: async (args, ctx): Promise<ToolExecutionResult> => {
      const access = requireTopLevelHarness("task");
      if (!access.ok) {
        return access.result;
      }

      const taskId = randomUUID().slice(0, 8);
      const label = normalizeTaskLabel(args.description, "subagent", taskId);
      const prepared = await prepareSubagentHarness({
        factoryRef,
        worktreeManager,
        workspaceRoot: ctx.workspaceRoot,
        parent: access.parent,
        taskId,
        label,
        preset: args.preset,
        presetRegistry,
        contextMode: args.contextMode,
        isolateWorkspace: args.isolateWorkspace,
        worktreeName: args.worktreeName,
        mode: "sync",
      });

      try {
        const result = await prepared.harness.run(args.prompt, ctx.signal);
        prepared.harness.finalize();

        const subagent = prepared.harness.getContext();
        const summary = `Subagent '${label}' finished in ${result.steps} step(s) with ${result.toolCalls} tool call(s)`;

        try {
          const artifact = await persistAgentRunArtifact(artifactStore, {
            workspaceRoot: prepared.workspaceRoot,
            category: "subagent",
            label,
            taskPrompt: args.prompt,
            harness: subagent,
            result,
            notes: {
              worktree: prepared.worktree,
              warnings:
                prepared.warnings.length > 0 ? prepared.warnings : undefined,
            },
          });

          return {
            ok: true,
            summary,
            content: renderAgentRunArtifactNotice({
              subject: `Subagent '${label}'`,
              artifact,
              result,
            }),
            data: {
              subagent,
              artifact,
              label,
              steps: result.steps,
              toolCalls: result.toolCalls,
              run: result.run,
              worktree: prepared.worktree,
              warnings:
                prepared.warnings.length > 0 ? prepared.warnings : undefined,
            },
          };
        } catch (artifactError) {
          return {
            ok: true,
            summary,
            content: renderAgentRunInlineNotice({
              subject: `Subagent '${label}'`,
              error: artifactError,
              result,
            }),
            data: {
              subagent,
              artifactError: toErrorMessage(artifactError),
              label,
              steps: result.steps,
              toolCalls: result.toolCalls,
              run: result.run,
              worktree: prepared.worktree,
              warnings:
                prepared.warnings.length > 0 ? prepared.warnings : undefined,
            },
          };
        }
      } finally {
        prepared.harness.finalize();
      }
    },
  };
}

function createTaskStartTool(
  manager: BackgroundSubtaskManager,
): ToolSpec<TaskArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "task_start",
        description:
          "Start an asynchronous background subtask session. The first turn inherits a snapshot of the parent's context by default; set context_mode='fresh' to start without parent history. Returns immediately with a task id; use it for work that can proceed independently, and launch multiple task_start calls in the same turn for parallel branches. Later use task_wait, task_list, task_reply, or task_interrupt.",
        parameters: {
          type: "object",
          required: ["prompt"],
          properties: {
            prompt: {
              type: "string",
              description: "Initial prompt for the background subtask session.",
            },
            description: {
              type: "string",
              description: "Short label for the background subtask.",
            },
            preset: {
              type: "string",
              description:
                "Optional delegated subagent preset, such as review, planner, or explore.",
            },
            context_mode: {
              type: "string",
              enum: ["inherit", "fresh"],
              description:
                "How much parent context to hand off to the first background turn. Defaults to 'inherit'; use 'fresh' to start without the parent's conversation snapshot.",
            },
            alias: {
              type: "string",
              description:
                "Optional stable handle for later task_wait/task_list orchestration.",
            },
            group: {
              type: "string",
              description:
                "Optional non-unique orchestration group for task_wait/task_list selectors.",
            },
            isolate_workspace: {
              type: "boolean",
              description:
                "Create or reuse a dedicated git worktree for this background subtask. Strongly recommended when concurrent writers may touch files.",
            },
            worktree_name: {
              type: "string",
              description:
                "Optional worktree lane name. Defaults to a sanitized task label.",
            },
          },
        },
      },
    },
    security: {
      risk: "meta",
      defaultMode: "allow",
    },
    grouping: createTaskGrouping("start", ["task_start"]),
    parseArgs: parseTaskArgs,
    inspect: ({ args }) =>
      buildTaskInspection(args, {
        externalLabel: "task_start",
      }),
    execute: async (args, ctx): Promise<ToolExecutionResult> => {
      const access = requireTopLevelHarness("task_start");
      if (!access.ok) {
        return access.result;
      }

      return manager.start(args, ctx.workspaceRoot, access.parent);
    },
  };
}

function createTaskReplyTool(
  manager: BackgroundSubtaskManager,
): ToolSpec<TaskReplyArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "task_reply",
        description:
          "Send a follow-up prompt to an existing background subtask session. Provide either task_id or alias. If the subtask is still running, the new prompt is queued for the next turn.",
        parameters: {
          type: "object",
          required: ["prompt"],
          properties: {
            task_id: {
              type: "string",
              description: "Background subtask id returned by task_start.",
            },
            alias: {
              type: "string",
              description: "Background subtask alias assigned via task_start.",
            },
            prompt: {
              type: "string",
              description:
                "Follow-up instruction for that background subtask session.",
            },
          },
        },
      },
    },
    security: {
      risk: "meta",
      defaultMode: "allow",
    },
    grouping: createTaskGrouping("reply", ["task_reply"]),
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      const taskId =
        readStringField(payload.task_id) ?? readStringField(payload.taskId);
      const alias = parseTaskAlias(payload.alias, "alias");
      if (taskId && alias) {
        throw new Error("Provide either task_id or alias, not both");
      }
      if (!taskId && !alias) {
        throw new Error("task_reply requires task_id or alias");
      }

      return {
        taskId,
        alias,
        prompt: readRequiredStringField(payload.prompt, "prompt"),
      };
    },
    inspect: ({ args }) => buildTaskReplyInspection(args),
    execute: async (args): Promise<ToolExecutionResult> => {
      const access = requireTopLevelHarness("task_reply");
      if (!access.ok) {
        return access.result;
      }

      return manager.reply(args.taskId, args.alias, args.prompt);
    },
  };
}

function createTaskWaitTool(
  manager: BackgroundSubtaskManager,
): ToolSpec<TaskWaitArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "task_wait",
        description:
          "Wait for background subtask updates after launching one or more task_start branches. With task_id or alias, waits for that subtask. With group, waits across that named subset. Without a selector, waits for any, first_ready, or all currently running background subtasks.",
        parameters: {
          type: "object",
          properties: {
            task_id: {
              type: "string",
              description:
                "Optional background subtask id. If provided, wait only for that subtask.",
            },
            alias: {
              type: "string",
              description:
                "Optional background subtask alias. Use either task_id or alias.",
            },
            group: {
              type: "string",
              description:
                "Optional background subtask group. Use instead of task_id or alias.",
            },
            wait_for: {
              type: "string",
              enum: ["any", "all", "first_ready"],
              description:
                "Without a selector: wait for any ready update, for the first newly ready current subtask, or for all currently running subtasks. With group: apply the same mode within that group. Defaults to any.",
            },
            wait_ms: {
              type: "integer",
              minimum: 0,
              maximum: MAX_WAIT_MS,
              description: `Maximum time to wait in milliseconds. Defaults to ${DEFAULT_WAIT_MS}.`,
            },
          },
        },
      },
    },
    security: {
      risk: "meta",
      defaultMode: "allow",
    },
    grouping: createTaskGrouping("wait", ["task_wait"]),
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      const taskId =
        readStringField(payload.task_id) ?? readStringField(payload.taskId);
      const alias = parseTaskAlias(payload.alias, "alias");
      const group = parseTaskGroup(payload.group, "group");
      const selectorCount =
        Number(Boolean(taskId)) +
        Number(Boolean(alias)) +
        Number(Boolean(group));
      if (selectorCount > 1) {
        throw new Error("Provide at most one of task_id, alias, or group");
      }
      return {
        taskId,
        alias,
        group,
        waitFor: readTaskWaitMode(
          payload.wait_for ?? payload.waitFor,
          "wait_for",
        ),
        waitMs: readIntegerField(payload.wait_ms ?? payload.waitMs, "wait_ms"),
      };
    },
    execute: async (args, ctx): Promise<ToolExecutionResult> => {
      const access = requireTopLevelHarness("task_wait");
      if (!access.ok) {
        return access.result;
      }

      return manager.wait({
        taskId: args.taskId,
        alias: args.alias,
        group: args.group,
        waitFor: args.waitFor,
        waitMs: args.waitMs,
        signal: ctx.signal,
      });
    },
  };
}

function createTaskInterruptTool(
  manager: BackgroundSubtaskManager,
): ToolSpec<TaskInterruptArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "task_interrupt",
        description:
          "Interrupt a running background subtask and clear any queued follow-up turns for that task session. Provide either task_id or alias for a single subtask target.",
        parameters: {
          type: "object",
          properties: {
            task_id: {
              type: "string",
              description: "Background subtask id returned by task_start.",
            },
            alias: {
              type: "string",
              description: "Background subtask alias assigned via task_start.",
            },
          },
        },
      },
    },
    security: {
      risk: "meta",
      defaultMode: "allow",
    },
    grouping: createTaskGrouping("interrupt", ["task_interrupt"]),
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      const taskId =
        readStringField(payload.task_id) ?? readStringField(payload.taskId);
      const alias = parseTaskAlias(payload.alias, "alias");
      if (taskId && alias) {
        throw new Error("Provide either task_id or alias, not both");
      }
      if (!taskId && !alias) {
        throw new Error("task_interrupt requires task_id or alias");
      }

      return { taskId, alias };
    },
    execute: async (args): Promise<ToolExecutionResult> => {
      const access = requireTopLevelHarness("task_interrupt");
      if (!access.ok) {
        return access.result;
      }

      return manager.interrupt(args.taskId, args.alias);
    },
  };
}

function createTaskListTool(
  manager: BackgroundSubtaskManager,
): ToolSpec<TaskListArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "task_list",
        description:
          "Inspect background subtask sessions. Provide task_id or alias for one subtask, group for a named subset, or omit selectors to list all known subtasks.",
        parameters: {
          type: "object",
          properties: {
            task_id: {
              type: "string",
              description:
                "Optional background subtask id for a detailed single-task view.",
            },
            alias: {
              type: "string",
              description:
                "Optional background subtask alias for a detailed single-task view.",
            },
            group: {
              type: "string",
              description:
                "Optional background subtask group for a filtered multi-task view.",
            },
          },
        },
      },
    },
    security: {
      risk: "meta",
      defaultMode: "allow",
    },
    grouping: createTaskGrouping("list", ["task_list"]),
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      const taskId =
        readStringField(payload.task_id) ?? readStringField(payload.taskId);
      const alias = parseTaskAlias(payload.alias, "alias");
      const group = parseTaskGroup(payload.group, "group");
      const selectorCount =
        Number(Boolean(taskId)) +
        Number(Boolean(alias)) +
        Number(Boolean(group));
      if (selectorCount > 1) {
        throw new Error("Provide at most one of task_id, alias, or group");
      }
      return {
        taskId,
        alias,
        group,
      };
    },
    execute: async (args): Promise<ToolExecutionResult> => {
      const access = requireTopLevelHarness("task_list");
      if (!access.ok) {
        return access.result;
      }

      return manager.list(args.taskId, args.alias, args.group);
    },
  };
}

class BackgroundSubtaskManager {
  private readonly factoryRef: MutableRef<AgentHarnessFactory>;
  private readonly worktreeManager: WorktreeManager;
  private readonly artifactStore?: AgentRunArtifactStore;
  private readonly presetRegistry?: AgentPresetRegistry;
  private readonly subtaskHooksFactory?: SubtaskHooksFactory;
  private readonly sessionHookEmitter?: SessionHookEmitter;
  private readonly tasks = new Map<string, BackgroundSubtaskRecord>();
  private notifications: BackgroundSubtaskNotification[] = [];
  private nextNotificationSequence = 1;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    factoryRef: MutableRef<AgentHarnessFactory>,
    worktreeManager: WorktreeManager,
    artifactStore?: AgentRunArtifactStore,
    presetRegistry?: AgentPresetRegistry,
    subtaskHooksFactory?: SubtaskHooksFactory,
    sessionHookEmitter?: SessionHookEmitter,
  ) {
    this.factoryRef = factoryRef;
    this.worktreeManager = worktreeManager;
    this.artifactStore = artifactStore;
    this.presetRegistry = presetRegistry;
    this.subtaskHooksFactory = subtaskHooksFactory;
    this.sessionHookEmitter = sessionHookEmitter;
  }

  async start(
    args: TaskArgs,
    workspaceRoot: string,
    parent: TopLevelHarnessInfo,
  ): Promise<ToolExecutionResult> {
    const taskId = randomUUID().slice(0, 8);
    const label = normalizeTaskLabel(args.description, "subtask", taskId);
    const alias = parseOptionalTaskAlias(args.alias);
    if (args.alias !== undefined && !alias) {
      return invalidTaskAliasResult(args.alias);
    }
    const group = parseOptionalTaskGroup(args.group);
    if (args.group !== undefined && !group) {
      return invalidTaskGroupResult(args.group);
    }

    const aliasConflict = alias ? this.findTaskByAlias(alias) : undefined;
    if (aliasConflict) {
      return {
        ok: false,
        summary: `Background subtask alias '${alias}' is already in use`,
        content: renderTaskOverview(this.toView(aliasConflict)),
        data: {
          alias,
          task: this.toView(aliasConflict),
        },
      };
    }

    const prepared = await prepareSubagentHarness({
      factoryRef: this.factoryRef,
      worktreeManager: this.worktreeManager,
      workspaceRoot,
      parent,
      taskId,
      label,
      preset: args.preset,
      presetRegistry: this.presetRegistry,
      contextMode: args.contextMode,
      isolateWorkspace: args.isolateWorkspace,
      worktreeName: args.worktreeName,
      mode: "background",
      subtaskHooksFactory: this.subtaskHooksFactory,
    });

    const warnings = [...prepared.warnings];
    if (!args.isolateWorkspace) {
      warnings.push(
        "Shared workspace background subtasks can race with the main harness or with other subtasks. Prefer isolate_workspace=true for concurrent writers.",
      );

      const sharedConflicts = this.findSharedWorkspaceConflicts(
        prepared.workspaceRoot,
      );
      if (sharedConflicts.length > 0) {
        warnings.push(
          `Another shared-workspace background subtask is already active: ${sharedConflicts.map((task) => `${task.id}:${task.label}`).join(", ")}`,
        );
      }
    }

    const now = new Date().toISOString();
    const task: BackgroundSubtaskRecord = {
      id: taskId,
      label,
      alias,
      group,
      parent,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      workspaceRoot: prepared.workspaceRoot,
      worktree: prepared.worktree,
      warnings,
      systemPrompt: prepared.systemPrompt,
      harness: prepared.harness,
      queue: [],
      lastRun: {},
    };

    this.tasks.set(taskId, task);
    this.trimHistory();
    this.enqueueTurn(task, args.prompt);
    this.ensureWorker(task);

    const view = this.toView(task);
    const handleParts = [
      alias ? `alias: ${alias}` : undefined,
      group ? `group: ${group}` : undefined,
    ].filter((entry): entry is string => Boolean(entry));
    return {
      ok: true,
      summary:
        handleParts.length > 0
          ? `Background subtask '${label}' started as ${taskId} (${handleParts.join(", ")})`
          : `Background subtask '${label}' started as ${taskId}`,
      content: renderTaskOverview(view),
      data: {
        task: view,
      },
    };
  }

  async wait(input: {
    taskId?: string;
    alias?: string;
    group?: string;
    waitFor?: TaskWaitMode;
    waitMs?: number;
    signal?: AbortSignal;
  }): Promise<ToolExecutionResult> {
    const waitMs = clamp(input.waitMs ?? DEFAULT_WAIT_MS, 0, MAX_WAIT_MS);
    const waitFor = input.waitFor ?? "any";
    throwIfAborted(input.signal);

    const selection = this.resolveTaskTargets(
      input.taskId,
      input.alias,
      input.group,
    );
    if (!selection.ok) {
      return selection.result;
    }

    if (selection.task) {
      if (waitFor === "all") {
        return this.waitForAllTargets([selection.task], waitMs, input.signal);
      }
      if (waitFor === "first_ready") {
        return this.waitForFirstReadyTargets(
          [selection.task],
          waitMs,
          input.signal,
        );
      }
      return this.waitForSingleTaskUpdates(
        selection.task,
        waitMs,
        input.signal,
      );
    }

    if (selection.tasks) {
      if (waitFor === "all") {
        return this.waitForAllTargets(
          selection.tasks,
          waitMs,
          input.signal,
          selection.label,
        );
      }
      if (waitFor === "first_ready") {
        return this.waitForFirstReadyTargets(
          selection.tasks,
          waitMs,
          input.signal,
          selection.label,
        );
      }
      return this.waitForAnyTargetUpdates(
        selection.tasks,
        waitMs,
        input.signal,
        selection.label,
      );
    }

    if (waitFor === "all") {
      const targets = [...this.tasks.values()].filter((task) =>
        isTaskBusy(task),
      );
      if (targets.length === 0) {
        const ready = this.takeNotifications(() => true);
        if (ready.length > 0) {
          return {
            ok: true,
            summary: `${ready.length} background subtask update(s) already available`,
            content: renderNotifications(ready),
            data: {
              timedOut: false,
              ready: ready
                .map((entry) => this.tasks.get(entry.taskId))
                .filter((task): task is BackgroundSubtaskRecord =>
                  Boolean(task),
                )
                .map((task) => this.toView(task)),
              running: [],
            },
          };
        }

        return {
          ok: true,
          summary: "No background subtasks are currently running",
          content: "(none)",
          data: {
            timedOut: false,
            ready: [],
            running: [],
          },
        };
      }

      return this.waitForAllTargets(targets, waitMs, input.signal);
    }

    if (waitFor === "first_ready") {
      const targets = [...this.tasks.values()].filter((task) =>
        isTaskBusy(task),
      );
      if (targets.length === 0) {
        return {
          ok: true,
          summary: "No background subtasks are currently running",
          content: "(none)",
          data: {
            timedOut: false,
            ready: [],
            running: [],
          },
        };
      }

      return this.waitForFirstReadyTargets(targets, waitMs, input.signal);
    }

    const immediate = this.takeNotifications(() => true);
    if (immediate.length > 0) {
      return {
        ok: true,
        summary: `${immediate.length} background subtask update(s) ready`,
        content: renderNotifications(immediate),
        data: {
          timedOut: false,
          ready: immediate
            .map((entry) => this.tasks.get(entry.taskId))
            .filter((task): task is BackgroundSubtaskRecord => Boolean(task))
            .map((task) => this.toView(task)),
          running: this.listBusyViews(),
        },
      };
    }

    const runningBeforeWait = this.listBusyViews();
    if (runningBeforeWait.length === 0) {
      return {
        ok: true,
        summary: "No background subtasks are currently running",
        content: "(none)",
        data: {
          timedOut: false,
          ready: [],
          running: [],
        },
      };
    }

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(
        Math.min(WAIT_POLL_MS, Math.max(20, deadline - Date.now())),
        input.signal,
      );
      const ready = this.takeNotifications(() => true);
      if (ready.length > 0) {
        return {
          ok: true,
          summary: `${ready.length} background subtask update(s) ready`,
          content: renderNotifications(ready),
          data: {
            timedOut: false,
            ready: ready
              .map((entry) => this.tasks.get(entry.taskId))
              .filter((task): task is BackgroundSubtaskRecord => Boolean(task))
              .map((task) => this.toView(task)),
            running: this.listBusyViews(),
          },
        };
      }
    }

    return {
      ok: true,
      summary: `Timed out after ${waitMs}ms waiting for any background subtask update`,
      content: this.listBusyViews()
        .map((task) => renderTaskOverview(task))
        .join("\n\n"),
      data: {
        timedOut: true,
        ready: [],
        running: this.listBusyViews(),
      },
    };
  }

  reply(
    taskId: string | undefined,
    alias: string | undefined,
    prompt: string,
  ): ToolExecutionResult {
    const resolved = this.resolveTaskHandle(taskId, alias);
    if (!resolved.ok) {
      return resolved.result;
    }

    const task = resolved.task;
    if (!task) {
      return {
        ok: false,
        summary: "task_reply requires task_id or alias",
      };
    }

    this.enqueueTurn(task, prompt);
    this.ensureWorker(task);

    const view = this.toView(task);
    return {
      ok: true,
      summary: `Queued follow-up turn for background subtask '${task.label}'`,
      content: renderTaskOverview(view),
      data: {
        task: view,
      },
    };
  }

  interrupt(taskId?: string, alias?: string): ToolExecutionResult {
    const resolved = this.resolveTaskHandle(taskId, alias);
    if (!resolved.ok) {
      return resolved.result;
    }

    const task = resolved.task;
    if (!task) {
      return {
        ok: false,
        summary: "task_interrupt requires task_id or alias",
      };
    }

    const clearedQueuedTurns = task.queue.length;
    task.queue.length = 0;

    if (!task.abortController) {
      if (!isTaskBusy(task)) {
        return {
          ok: false,
          summary: `Background subtask '${task.label}' is not currently running`,
          data: {
            task: this.toView(task),
          },
        };
      }

      task.status = "interrupted";
      task.updatedAt = new Date().toISOString();
      task.lastRun.summary = `Background subtask '${task.label}' was interrupted before the next turn started`;
      task.lastRun.notice = task.lastRun.summary;
      this.emitSubagentStatus(task, {
        status: "interrupted",
        recordedAt: task.updatedAt,
        summary: task.lastRun.summary,
        detail: task.lastRun.notice,
        dedupeSeed: task.updatedAt,
      });
      this.enqueueNotification(task);

      return {
        ok: true,
        summary: `Cleared queued turns for background subtask '${task.label}'`,
        content: renderTaskOverview(this.toView(task)),
        data: {
          clearedQueuedTurns,
          task: this.toView(task),
        },
      };
    }

    task.abortController.abort("Run interrupted by user.");
    return {
      ok: true,
      summary: `Interrupt requested for background subtask '${task.label}'`,
      content: renderTaskOverview(this.toView(task)),
      data: {
        clearedQueuedTurns,
        task: this.toView(task),
      },
    };
  }

  interruptAll(): number {
    const busyTaskIds = [...this.tasks.values()]
      .filter((task) => isTaskBusy(task))
      .map((task) => task.id);

    let interrupted = 0;
    for (const taskId of busyTaskIds) {
      const result = this.interrupt(taskId);
      if (result.ok) {
        interrupted += 1;
      }
    }

    return interrupted;
  }

  list(taskId?: string, alias?: string, group?: string): ToolExecutionResult {
    const selection = this.resolveTaskTargets(taskId, alias, group);
    if (!selection.ok) {
      return selection.result;
    }

    if (selection.task) {
      const task = selection.task;

      return {
        ok: true,
        summary: `Background subtask '${task.label}' is ${task.status}`,
        content: renderTaskDetails(this.toView(task), task.lastRun.notice),
        data: {
          task: this.toView(task),
        },
      };
    }

    if (selection.tasks) {
      const views = selection.tasks.map((task) => this.toView(task));
      return {
        ok: true,
        summary: `${selection.label}: ${views.length}`,
        content:
          views.map((task) => renderTaskOverview(task)).join("\n\n") ||
          "(none)",
        data: {
          tasks: views,
        },
      };
    }

    const views = [...this.tasks.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((task) => this.toView(task));

    return {
      ok: true,
      summary: `Background subtasks: ${views.length}`,
      content:
        views.map((task) => renderTaskOverview(task)).join("\n") || "(none)",
      data: {
        tasks: views,
      },
    };
  }

  beforeModelRequest(context: PluginHookContext): PluginHookResult | void {
    if (context.harnessType !== "main" || (context.harnessDepth ?? 0) !== 0) {
      return;
    }

    const messages: PluginHookResult["messages"] = [];
    if (context.step <= 1) {
      messages.push({
        role: "system",
        content: MAIN_ORCHESTRATION_REMINDER,
      });
    }

    const ready = this.takeNotifications(() => true, MAX_NOTIFICATION_DRAIN);
    if (ready.length > 0) {
      messages.push({
        role: "system",
        content: [
          `Background subtask notifications (step=${context.step}):`,
          "<background-subtasks>",
          ...ready.map((entry) =>
            renderNotification(entry, MAX_NOTIFICATION_PREVIEW_CHARS),
          ),
          "</background-subtasks>",
        ].join("\n"),
      });
    }

    if (messages.length === 0) {
      return;
    }

    return { messages };
  }

  exportState(): unknown {
    const tasks = [...this.tasks.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map<SerializedBackgroundSubtask>((task) => ({
        id: task.id,
        label: task.label,
        alias: task.alias,
        group: task.group,
        status: task.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        workspaceRoot: task.workspaceRoot,
        worktree: task.worktree ? { ...task.worktree } : undefined,
        warnings: task.warnings.length > 0 ? [...task.warnings] : undefined,
        systemPrompt: task.systemPrompt,
        harnessState: task.harness.exportState(),
        queue: task.queue.map((entry) => ({ ...entry })),
        activeTurn: task.activeTurn ? { ...task.activeTurn } : undefined,
        lastRun: { ...task.lastRun },
      }));

    return {
      version: 1,
      tasks,
    } satisfies SerializedBackgroundSubtaskState;
  }

  loadState(state: unknown): void {
    this.clearTasks();
    this.notifications = [];
    this.nextNotificationSequence = 1;

    if (!state || typeof state !== "object") {
      return;
    }

    const candidate = state as Partial<SerializedBackgroundSubtaskState>;
    if (candidate.version !== 1 || !Array.isArray(candidate.tasks)) {
      return;
    }

    for (const entry of candidate.tasks) {
      const snapshot = parseSerializedBackgroundSubtask(entry);
      if (!snapshot) {
        continue;
      }

      try {
        const factory = this.factoryRef.get();
        const restored = compileSubagentHarness(factory, {
          id: snapshot.harnessState.identity.id || `subtask:${snapshot.id}`,
          name: snapshot.label,
          label: snapshot.label,
          mode: "background",
          depth: Math.max(1, snapshot.harnessState.identity.depth ?? 1),
          parentId: snapshot.harnessState.identity.parentId,
          workspaceRoot:
            snapshot.workspaceRoot ||
            snapshot.harnessState.identity.workspaceRoot,
          sessionId: snapshot.harnessState.identity.sessionId,
          goalId: snapshot.harnessState.identity.goalId,
          executionProfile: snapshot.harnessState.identity.executionProfile,
          systemPrompt: snapshot.systemPrompt,
          allowedTools: snapshot.harnessState.allowedTools,
          memoryState: snapshot.harnessState.memory,
          toolRuntimeState: snapshot.harnessState.toolRuntime,
          hooks: this.subtaskHooksFactory?.(snapshot.label),
        });

        const hadPendingWork =
          snapshot.status === "running" ||
          snapshot.status === "queued" ||
          snapshot.queue.length > 0 ||
          Boolean(snapshot.activeTurn);

        const warnings = [...(snapshot.warnings ?? []), ...restored.warnings];
        if (hadPendingWork) {
          warnings.push(
            "Session resume restored this background subtask in lost state. In-flight or queued work was not restarted automatically.",
          );
        }

        let alias = snapshot.alias;
        if (alias && this.findTaskByAlias(alias)) {
          warnings.push(
            `Duplicate restored alias '${alias}' was dropped during session restore.`,
          );
          alias = undefined;
        }

        const task: BackgroundSubtaskRecord = {
          id: snapshot.id,
          label: snapshot.label,
          alias,
          group: snapshot.group,
          parent: buildRestoredTopLevelHarnessInfo(
            restored.harness.getContext(),
          ),
          status: hadPendingWork ? "lost" : snapshot.status,
          createdAt: snapshot.createdAt,
          updatedAt: snapshot.updatedAt,
          workspaceRoot:
            snapshot.workspaceRoot ||
            snapshot.harnessState.identity.workspaceRoot,
          worktree: snapshot.worktree ? { ...snapshot.worktree } : undefined,
          warnings,
          systemPrompt: snapshot.systemPrompt,
          harness: restored.harness,
          queue: [],
          lastRun: { ...snapshot.lastRun },
        };

        if (hadPendingWork && !task.lastRun.summary) {
          task.lastRun.summary = `Background subtask '${task.label}' was not resumed automatically after session restore`;
          task.lastRun.notice = task.lastRun.summary;
        }

        this.tasks.set(task.id, task);
        if (hadPendingWork) {
          this.emitSubagentStatus(task, {
            status: "lost",
            recordedAt: snapshot.updatedAt,
            summary:
              task.lastRun.summary ??
              `Background subtask '${task.label}' was restored in lost state`,
            detail: task.lastRun.notice,
            dedupeSeed: snapshot.updatedAt,
          });
        }
      } catch {
        continue;
      }
    }

    this.trimHistory();
  }

  async shutdown(
    reason = "Background subtask manager shutting down.",
  ): Promise<void> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }

    this.shutdownPromise = (async () => {
      const workerPromises: Promise<void>[] = [];

      for (const task of this.tasks.values()) {
        task.queue.length = 0;
        task.updatedAt = new Date().toISOString();

        if (task.abortController && !task.abortController.signal.aborted) {
          task.abortController.abort(reason);
        }

        if (task.worker) {
          workerPromises.push(task.worker);
        }
      }

      if (workerPromises.length > 0) {
        await Promise.race([
          Promise.allSettled(workerPromises),
          sleep(SHUTDOWN_GRACE_MS).then(() => undefined),
        ]);
      }

      this.clearTasks();
      this.notifications = [];
      this.nextNotificationSequence = 1;
    })();

    await this.shutdownPromise;
  }

  private enqueueTurn(task: BackgroundSubtaskRecord, prompt: string): void {
    const enqueuedAt = new Date().toISOString();
    task.queue.push({
      prompt,
      enqueuedAt,
    });

    if (task.status !== "running") {
      task.status = "queued";
    }
    task.updatedAt = enqueuedAt;
    this.emitSubagentStatus(task, {
      status: "queued",
      recordedAt: enqueuedAt,
      summary: `Background subtask '${task.label}' queued a turn`,
      detail: shortenLine(prompt, 240),
      dedupeSeed: enqueuedAt,
    });
  }

  private ensureWorker(task: BackgroundSubtaskRecord): void {
    if (task.worker) {
      return;
    }

    task.worker = this.runWorker(task).finally(() => {
      task.abortController = undefined;
      task.activeTurn = undefined;
      task.worker = undefined;
      if (task.queue.length > 0) {
        this.ensureWorker(task);
      }
    });
  }

  private async runWorker(task: BackgroundSubtaskRecord): Promise<void> {
    while (task.queue.length > 0) {
      const nextTurn = task.queue.shift();
      if (!nextTurn) {
        return;
      }

      const startedAt = new Date().toISOString();
      task.activeTurn = {
        ...nextTurn,
        startedAt,
      };
      task.status = "running";
      task.updatedAt = startedAt;
      task.lastRun.prompt = nextTurn.prompt;
      task.lastRun.startedAt = startedAt;
      task.lastRun.finishedAt = undefined;
      task.lastRun.error = undefined;
      task.lastRun.summary = undefined;
      task.lastRun.notice = undefined;
      task.lastRun.outputPreview = undefined;
      task.lastRun.steps = undefined;
      task.lastRun.toolCalls = undefined;
      task.lastRun.artifact = undefined;
      task.lastRun.artifactError = undefined;
      this.emitSubagentStatus(task, {
        status: "running",
        recordedAt: startedAt,
        summary: `Background subtask '${task.label}' started a turn`,
        detail: shortenLine(nextTurn.prompt, 240),
        dedupeSeed: startedAt,
      });

      const abortController = new AbortController();
      task.abortController = abortController;

      try {
        const result = await task.harness.run(
          nextTurn.prompt,
          abortController.signal,
        );
        const finishedAt = new Date().toISOString();
        task.updatedAt = finishedAt;
        task.status = "completed";
        task.lastRun.finishedAt = finishedAt;
        task.lastRun.summary = `Background subtask '${task.label}' finished in ${result.steps} step(s) with ${result.toolCalls} tool call(s)`;
        task.lastRun.outputPreview = truncateText({
          text: result.output.trim() || "(no final output)",
          maxChars: MAX_NOTIFICATION_CONTENT_CHARS,
          strategy: "head_tail",
        }).text;
        task.lastRun.steps = result.steps;
        task.lastRun.toolCalls = result.toolCalls;

        try {
          const artifact = await persistAgentRunArtifact(this.artifactStore, {
            workspaceRoot: task.workspaceRoot,
            category: "subagent",
            label: task.label,
            taskPrompt: nextTurn.prompt,
            harness: task.harness.getContext(),
            result,
            notes: {
              worktree: task.worktree,
              warnings: task.warnings.length > 0 ? task.warnings : undefined,
              backgroundTaskId: task.id,
            },
          });

          task.lastRun.artifact = artifact;
          task.lastRun.notice = renderAgentRunArtifactNotice({
            subject: `Background subtask '${task.label}'`,
            artifact,
            result,
          });
        } catch (artifactError) {
          task.lastRun.artifactError = toErrorMessage(artifactError);
          task.lastRun.notice = renderAgentRunInlineNotice({
            subject: `Background subtask '${task.label}'`,
            error: artifactError,
            result,
          });
        }
        this.emitSubagentStatus(task, {
          status: "completed",
          recordedAt: finishedAt,
          summary: task.lastRun.summary,
          detail: task.lastRun.notice ?? task.lastRun.outputPreview,
          attemptId:
            result.run && typeof result.run === "object"
              ? readStringField(
                  (result.run as { attemptId?: unknown }).attemptId,
                )
              : undefined,
          dedupeSeed: finishedAt,
        });
      } catch (error) {
        const finishedAt = new Date().toISOString();
        const interrupted = abortController.signal.aborted;
        task.updatedAt = finishedAt;
        task.status = interrupted ? "interrupted" : "error";
        task.lastRun.finishedAt = finishedAt;
        task.lastRun.error = toErrorMessage(error);
        task.lastRun.summary = interrupted
          ? `Background subtask '${task.label}' was interrupted`
          : `Background subtask '${task.label}' failed`;
        task.lastRun.notice = interrupted
          ? [
              `Background subtask '${task.label}' was interrupted.`,
              task.lastRun.error ? `reason: ${task.lastRun.error}` : undefined,
            ]
              .filter((entry): entry is string => Boolean(entry))
              .join("\n")
          : [
              `Background subtask '${task.label}' failed.`,
              task.lastRun.error ? `error: ${task.lastRun.error}` : undefined,
            ]
              .filter((entry): entry is string => Boolean(entry))
              .join("\n");
        this.emitSubagentStatus(task, {
          status: interrupted ? "interrupted" : "error",
          recordedAt: finishedAt,
          summary: task.lastRun.summary,
          detail: task.lastRun.notice,
          dedupeSeed: finishedAt,
        });
      } finally {
        task.abortController = undefined;
        task.activeTurn = undefined;
        task.updatedAt = new Date().toISOString();
        this.enqueueNotification(task);
      }
    }
  }

  private emitSubagentStatus(
    task: BackgroundSubtaskRecord,
    input: {
      status: BackgroundSubtaskStatus;
      recordedAt?: string;
      summary?: string;
      detail?: string;
      attemptId?: string | null;
      dedupeSeed?: string | null;
    },
  ): void {
    if (!this.sessionHookEmitter) {
      return;
    }

    const harness = task.harness.getContext();
    const lane = task.alias ?? task.label;
    const recordedAt = input.recordedAt ?? new Date().toISOString();
    const attemptId =
      input.attemptId === undefined ? task.parent.attemptId : input.attemptId;

    this.sessionHookEmitter({
      hookId: randomUUID(),
      hookKind: "subagent.status",
      recordedAt,
      importance: classifySubagentStatusImportance(input.status),
      title: `Subagent ${input.status}`,
      summary:
        input.summary ??
        `Background subtask '${task.label}' is ${input.status}`,
      detail: input.detail,
      lane,
      source: "subagent",
      harnessType: "subagent",
      harnessName: lane,
      harnessId: harness.id || `subtask:${task.id}`,
      parentHarnessId: harness.parentId ?? task.parent.id,
      goalId: harness.goalId ?? `${task.parent.goalId}/subtask:${task.id}`,
      attemptId: attemptId ?? null,
      depth: harness.depth ?? task.parent.depth + 1,
      state: input.status,
      dedupeKey: [
        "subagent.status",
        task.id,
        input.status,
        input.dedupeSeed ?? recordedAt,
      ].join(":"),
      data: {
        status: input.status,
        taskId: task.id,
        label: task.label,
        alias: task.alias ?? null,
        group: task.group ?? null,
        queueDepth: task.queue.length,
        workspaceRoot: task.workspaceRoot,
        updatedAt: task.updatedAt,
        lastStartedAt: task.lastRun.startedAt ?? null,
        lastFinishedAt: task.lastRun.finishedAt ?? null,
        error: task.lastRun.error ?? null,
      },
    });
  }

  private enqueueNotification(task: BackgroundSubtaskRecord): void {
    const summary =
      task.lastRun.summary ?? `Background subtask '${task.label}' updated`;
    const content = truncateText({
      text: task.lastRun.notice ?? task.lastRun.outputPreview ?? summary,
      maxChars: MAX_NOTIFICATION_CONTENT_CHARS,
      strategy: "head_tail",
    }).text;

    this.notifications.push({
      sequence: this.nextNotificationSequence++,
      taskId: task.id,
      label: task.label,
      alias: task.alias,
      status: task.status,
      summary,
      content,
      at: new Date().toISOString(),
    });

    if (this.notifications.length > MAX_NOTIFICATION_HISTORY) {
      this.notifications = this.notifications.slice(
        this.notifications.length - MAX_NOTIFICATION_HISTORY,
      );
    }
  }

  private takeNotifications(
    predicate: (entry: BackgroundSubtaskNotification) => boolean,
    limit = Number.POSITIVE_INFINITY,
  ): BackgroundSubtaskNotification[] {
    const taken: BackgroundSubtaskNotification[] = [];
    const remaining: BackgroundSubtaskNotification[] = [];

    for (const entry of this.notifications) {
      if (taken.length < limit && predicate(entry)) {
        taken.push(entry);
      } else {
        remaining.push(entry);
      }
    }

    this.notifications = remaining;
    return taken;
  }

  private findTaskByAlias(alias: string): BackgroundSubtaskRecord | undefined {
    for (const task of this.tasks.values()) {
      if (task.alias === alias) {
        return task;
      }
    }
    return undefined;
  }

  private findTasksByGroup(group: string): BackgroundSubtaskRecord[] {
    return this.listTaskRecords().filter((task) => task.group === group);
  }

  private listUnknownTaskHandles(): Array<{
    id: string;
    alias?: string;
    label?: string;
  }> {
    return this.listTaskRecords().map((task) => ({
      id: task.id,
      alias: task.alias,
      label: task.label,
    }));
  }

  private listKnownTaskGroups(): string[] {
    return [
      ...new Set(
        this.listTaskRecords()
          .map((task) => task.group)
          .filter((group): group is string => Boolean(group)),
      ),
    ];
  }

  private resolveTaskHandle(
    taskId?: string,
    alias?: string,
  ): TaskHandleResolution {
    if (taskId && alias) {
      return {
        ok: false,
        result: {
          ok: false,
          summary: "Provide either task_id or alias, not both",
          data: {
            taskId,
            alias,
          },
        },
      };
    }

    if (taskId) {
      const task = this.tasks.get(taskId);
      if (!task) {
        return {
          ok: false,
          result: unknownTaskResult(taskId, this.listUnknownTaskHandles()),
        };
      }
      return {
        ok: true,
        task,
      };
    }

    if (alias) {
      const task = this.findTaskByAlias(alias);
      if (!task) {
        return {
          ok: false,
          result: unknownTaskResult(alias, this.listUnknownTaskHandles()),
        };
      }
      return {
        ok: true,
        task,
      };
    }

    return { ok: true };
  }

  private resolveTaskTargets(
    taskId?: string,
    alias?: string,
    group?: string,
  ): TaskTargetResolution {
    if (group) {
      if (taskId || alias) {
        return {
          ok: false,
          result: {
            ok: false,
            summary: "Provide only one selector: task_id, alias, or group",
            data: {
              taskId,
              alias,
              group,
            },
          },
        };
      }

      const tasks = this.findTasksByGroup(group);
      if (tasks.length === 0) {
        return {
          ok: false,
          result: unknownTaskGroupResult(group, this.listKnownTaskGroups()),
        };
      }

      return {
        ok: true,
        tasks,
        label: `group '${group}'`,
      };
    }

    return this.resolveTaskHandle(taskId, alias);
  }

  private async waitForSingleTaskUpdates(
    task: BackgroundSubtaskRecord,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const takeTaskNotifications = (): BackgroundSubtaskNotification[] =>
      this.takeNotifications((entry) => entry.taskId === task.id);

    const immediate = takeTaskNotifications();
    if (immediate.length > 0) {
      return this.buildWaitReadyResult({
        summary:
          immediate.length === 1
            ? `Background subtask '${task.label}' reported an update`
            : `${immediate.length} background subtask update(s) ready for '${task.label}'`,
        notifications: immediate,
        ready: [this.toView(task)],
      });
    }

    if (!isTaskBusy(task)) {
      return this.buildWaitReadyResult({
        summary: `Background subtask '${task.label}' is ${task.status}`,
        ready: [this.toView(task)],
      });
    }

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(
        Math.min(WAIT_POLL_MS, Math.max(20, deadline - Date.now())),
        signal,
      );

      const ready = takeTaskNotifications();
      if (ready.length > 0) {
        return this.buildWaitReadyResult({
          summary:
            ready.length === 1
              ? `Background subtask '${task.label}' reported an update`
              : `${ready.length} background subtask update(s) ready for '${task.label}'`,
          notifications: ready,
          ready: [this.toView(task)],
        });
      }

      if (!isTaskBusy(task)) {
        return this.buildWaitReadyResult({
          summary: `Background subtask '${task.label}' is ${task.status}`,
          ready: [this.toView(task)],
        });
      }
    }

    return this.buildWaitTimeoutResult({
      summary: `Timed out after ${waitMs}ms waiting for background subtask '${task.label}'`,
      running: [this.toView(task)],
    });
  }

  private async waitForAnyTargetUpdates(
    targets: BackgroundSubtaskRecord[],
    waitMs: number,
    signal: AbortSignal | undefined,
    label: string | undefined,
  ): Promise<ToolExecutionResult> {
    const targetIds = new Set(targets.map((task) => task.id));
    const takeTargetNotifications = (): BackgroundSubtaskNotification[] =>
      this.takeNotifications((entry) => targetIds.has(entry.taskId));
    const summarizeReady = (
      notifications: BackgroundSubtaskNotification[],
    ): BackgroundSubtaskView[] => {
      const readyIds = new Set(notifications.map((entry) => entry.taskId));
      return targets
        .filter((task) => readyIds.has(task.id))
        .map((task) => this.toView(task));
    };
    const subject = label ?? "selected background subtasks";

    const immediate = takeTargetNotifications();
    if (immediate.length > 0) {
      return this.buildWaitReadyResult({
        summary: `${immediate.length} background subtask update(s) ready for ${subject}`,
        notifications: immediate,
        ready: summarizeReady(immediate),
      });
    }

    const runningTargets = targets.filter((task) => isTaskBusy(task));
    if (runningTargets.length === 0) {
      return {
        ok: true,
        summary: label
          ? `No background subtasks in ${label} are currently running`
          : `No ${subject.toLowerCase()} are currently running`,
        content: "(none)",
        data: {
          timedOut: false,
          ready: [],
          running: [],
        },
      };
    }

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(
        Math.min(WAIT_POLL_MS, Math.max(20, deadline - Date.now())),
        signal,
      );
      const ready = takeTargetNotifications();
      if (ready.length > 0) {
        return this.buildWaitReadyResult({
          summary: `${ready.length} background subtask update(s) ready for ${subject}`,
          notifications: ready,
          ready: summarizeReady(ready),
        });
      }
    }

    return this.buildWaitTimeoutResult({
      summary: label
        ? `Timed out after ${waitMs}ms waiting for any update from ${label}`
        : `Timed out after ${waitMs}ms waiting for any update from ${subject.toLowerCase()}`,
      running: targets
        .filter((task) => isTaskBusy(task))
        .map((task) => this.toView(task)),
    });
  }

  private async waitForAllTargets(
    targets: BackgroundSubtaskRecord[],
    waitMs: number,
    signal?: AbortSignal,
    label?: string,
  ): Promise<ToolExecutionResult> {
    const targetIds = new Set(targets.map((task) => task.id));
    const notifications: BackgroundSubtaskNotification[] = [];
    const collectNotifications = (): void => {
      notifications.push(
        ...this.takeNotifications((entry) => targetIds.has(entry.taskId)),
      );
    };

    collectNotifications();

    const deadline = Date.now() + waitMs;
    while (targets.some((task) => isTaskBusy(task)) && Date.now() < deadline) {
      await sleep(
        Math.min(WAIT_POLL_MS, Math.max(20, deadline - Date.now())),
        signal,
      );
      collectNotifications();
    }

    const ready = targets
      .filter((task) => !isTaskBusy(task))
      .map((task) => this.toView(task));
    const stillRunning = targets
      .filter((task) => isTaskBusy(task))
      .map((task) => this.toView(task));
    if (stillRunning.length === 0) {
      return this.buildWaitReadyResult({
        summary:
          targets.length === 1
            ? `Background subtask '${targets[0]!.label}' is ${targets[0]!.status}`
            : label
              ? `All ${targets.length} background subtasks in ${label} are ready`
              : `All ${targets.length} background subtasks are ready`,
        notifications,
        ready,
      });
    }

    return this.buildWaitTimeoutResult({
      summary: label
        ? `Timed out after ${waitMs}ms waiting for all ${targets.length} background subtask(s) in ${label}`
        : `Timed out after ${waitMs}ms waiting for all ${targets.length} background subtask(s)`,
      notifications,
      ready,
      running: stillRunning,
    });
  }

  private async waitForFirstReadyTargets(
    targets: BackgroundSubtaskRecord[],
    waitMs: number,
    signal?: AbortSignal,
    label?: string,
  ): Promise<ToolExecutionResult> {
    const targetIds = new Set(targets.map((task) => task.id));
    const busyTargetIds = new Set(
      targets.filter((task) => isTaskBusy(task)).map((task) => task.id),
    );
    if (busyTargetIds.size === 0) {
      return this.buildWaitReadyResult({
        summary:
          targets.length === 1
            ? `Background subtask '${targets[0]!.label}' is already ${targets[0]!.status}`
            : label
              ? `${targets.length} background subtasks in ${label} are already ready`
              : `${targets.length} background subtasks are already ready`,
        ready: targets.map((task) => this.toView(task)),
      });
    }

    const minSequence = this.nextNotificationSequence;
    const takeFreshNotifications = (): BackgroundSubtaskNotification[] =>
      this.takeNotifications(
        (entry) => entry.sequence >= minSequence && targetIds.has(entry.taskId),
        1,
      );

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const fresh = takeFreshNotifications();
      if (fresh.length > 0) {
        const task = this.tasks.get(fresh[0]!.taskId);
        return this.buildWaitReadyResult({
          summary: label
            ? `Background subtask '${fresh[0]!.label}' became ready first in ${label}`
            : `Background subtask '${fresh[0]!.label}' became ready first`,
          notifications: fresh,
          ready: task ? [this.toView(task)] : [],
        });
      }

      const newlyReady = targets
        .filter((task) => busyTargetIds.has(task.id) && !isTaskBusy(task))
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
      if (newlyReady.length > 0) {
        return this.buildWaitReadyResult({
          summary: label
            ? `Background subtask '${newlyReady[0]!.label}' became ready first in ${label}`
            : `Background subtask '${newlyReady[0]!.label}' became ready first`,
          ready: [this.toView(newlyReady[0]!)],
        });
      }

      await sleep(
        Math.min(WAIT_POLL_MS, Math.max(20, deadline - Date.now())),
        signal,
      );
    }

    return this.buildWaitTimeoutResult({
      summary: label
        ? `Timed out after ${waitMs}ms waiting for the first ready background subtask in ${label}`
        : `Timed out after ${waitMs}ms waiting for the first ready background subtask`,
      running: targets
        .filter((task) => isTaskBusy(task))
        .map((task) => this.toView(task)),
    });
  }

  private buildWaitReadyResult(input: {
    summary: string;
    notifications?: BackgroundSubtaskNotification[];
    ready: BackgroundSubtaskView[];
  }): ToolExecutionResult {
    return {
      ok: true,
      summary: input.summary,
      content: this.renderWaitContent(input.notifications ?? [], input.ready),
      data: {
        timedOut: false,
        ready: input.ready,
        running: this.listBusyViews(),
      },
    };
  }

  private buildWaitTimeoutResult(input: {
    summary: string;
    notifications?: BackgroundSubtaskNotification[];
    ready?: BackgroundSubtaskView[];
    running: BackgroundSubtaskView[];
  }): ToolExecutionResult {
    return {
      ok: true,
      summary: input.summary,
      content: this.renderWaitContent(input.notifications ?? [], [
        ...(input.ready ?? []),
        ...input.running,
      ]),
      data: {
        timedOut: true,
        ready: input.ready ?? [],
        running: this.listBusyViews(),
      },
    };
  }

  private renderWaitContent(
    notifications: readonly BackgroundSubtaskNotification[],
    tasks: readonly BackgroundSubtaskView[],
  ): string {
    const parts: string[] = [];
    if (notifications.length > 0) {
      parts.push(renderNotifications([...notifications]));
    }
    if (tasks.length > 0) {
      parts.push(tasks.map((task) => renderTaskOverview(task)).join("\n\n"));
    }
    return parts.join("\n\n") || "(none)";
  }

  listViews(): BackgroundSubtaskView[] {
    return this.listTaskRecords().map((task) => this.toView(task));
  }

  private listBusyViews(): BackgroundSubtaskView[] {
    return this.listTaskRecords()
      .filter((task) => isTaskBusy(task))
      .map((task) => this.toView(task));
  }

  private listTaskRecords(): BackgroundSubtaskRecord[] {
    return [...this.tasks.values()].sort(compareBackgroundSubtaskRecords);
  }

  private toView(task: BackgroundSubtaskRecord): BackgroundSubtaskView {
    const context = task.harness.getContext();
    return {
      id: task.id,
      label: task.label,
      alias: task.alias,
      group: task.group,
      status: task.status,
      queueDepth: task.queue.length,
      workspaceRoot: task.workspaceRoot,
      worktree: task.worktree ? { ...task.worktree } : undefined,
      executionProfile: context.executionProfile,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      activePrompt: task.activeTurn?.prompt,
      lastPrompt: task.lastRun.prompt,
      lastStartedAt: task.lastRun.startedAt,
      lastFinishedAt: task.lastRun.finishedAt,
      lastSummary: task.lastRun.summary,
      lastError: task.lastRun.error,
      steps: task.lastRun.steps,
      toolCalls: task.lastRun.toolCalls,
      artifact: task.lastRun.artifact,
      warnings: task.warnings.length > 0 ? [...task.warnings] : undefined,
    };
  }

  private findSharedWorkspaceConflicts(
    workspaceRoot: string,
  ): BackgroundSubtaskRecord[] {
    return [...this.tasks.values()].filter(
      (task) =>
        task.workspaceRoot === workspaceRoot &&
        task.harness.getContext().executionProfile.workspaceMode === "shared" &&
        isTaskBusy(task),
    );
  }

  private trimHistory(): void {
    if (this.tasks.size <= MAX_BACKGROUND_SUBTASKS) {
      return;
    }

    const removable = [...this.tasks.values()]
      .filter((task) => !isTaskBusy(task))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));

    while (this.tasks.size > MAX_BACKGROUND_SUBTASKS && removable.length > 0) {
      const task = removable.shift();
      if (!task) {
        return;
      }

      this.tasks.delete(task.id);
      safeFinalize(task.harness);
    }
  }

  private clearTasks(): void {
    for (const task of this.tasks.values()) {
      safeFinalize(task.harness);
    }
    this.tasks.clear();
  }
}

function parseTaskArgs(rawArgs: string): TaskArgs {
  const payload = parseJsonObject(rawArgs);
  return {
    prompt: readRequiredStringField(payload.prompt, "prompt"),
    description: readStringField(payload.description),
    preset: readStringField(payload.preset),
    alias: parseTaskAlias(payload.alias, "alias"),
    group: parseTaskGroup(payload.group, "group"),
    contextMode: parseTaskContextMode(
      payload.context_mode ?? payload.contextMode,
      "context_mode",
    ),
    isolateWorkspace:
      readBooleanField(payload.isolate_workspace, "isolate_workspace") ??
      readBooleanField(payload.isolateWorkspace, "isolateWorkspace"),
    worktreeName:
      readStringField(payload.worktree_name) ??
      readStringField(payload.worktreeName),
  };
}

function buildTaskInspection(
  args: TaskArgs,
  options?: {
    externalLabel?: string;
  },
) {
  const hintSource =
    args.description?.trim() ||
    args.alias?.trim() ||
    args.group?.trim() ||
    args.prompt;
  const inputHint = shortenLine(hintSource, 96);

  return {
    inputHint,
    ...(options?.externalLabel
      ? {
          externalEffects: [
            {
              kind: "external-unsafe" as const,
              label: options.externalLabel,
            },
          ],
        }
      : {}),
  };
}

function buildTaskReplyInspection(args: TaskReplyArgs) {
  const target = args.alias?.trim() || args.taskId?.trim();
  const promptHint = shortenLine(args.prompt, 96);

  return {
    inputHint: target ? `${target} · ${promptHint}` : promptHint,
    externalEffects: [
      {
        kind: "external-unsafe" as const,
        label: "task_reply",
      },
    ],
  };
}

function parseTaskAlias(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const alias = parseOptionalTaskHandle(value);
  if (!alias) {
    throw new Error(`${field} must match ${TASK_ALIAS_PATTERN.source}`);
  }
  return alias;
}

function parseTaskContextMode(
  value: unknown,
  field: string,
): TaskContextMode | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "inherit" || value === "fresh") {
    return value;
  }

  throw new Error(`${field} must be 'inherit' or 'fresh'`);
}

function parseOptionalTaskAlias(value: unknown): string | undefined {
  return parseOptionalTaskHandle(value);
}

function parseTaskGroup(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const group = parseOptionalTaskGroup(value);
  if (!group) {
    throw new Error(`${field} must match ${TASK_ALIAS_PATTERN.source}`);
  }
  return group;
}

function parseOptionalTaskGroup(value: unknown): string | undefined {
  return parseOptionalTaskHandle(value);
}

function parseOptionalTaskHandle(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const handle = value.trim();
  if (!handle) {
    return undefined;
  }
  if (!TASK_ALIAS_PATTERN.test(handle)) {
    return undefined;
  }
  return handle;
}

function invalidTaskAliasResult(alias: string): ToolExecutionResult {
  return {
    ok: false,
    summary: `Invalid background subtask alias '${alias}'`,
    content: `Aliases must match ${TASK_ALIAS_PATTERN.source}`,
    data: {
      alias,
      pattern: TASK_ALIAS_PATTERN.source,
    },
  };
}

function invalidTaskGroupResult(group: string): ToolExecutionResult {
  return {
    ok: false,
    summary: `Invalid background subtask group '${group}'`,
    content: `Groups must match ${TASK_ALIAS_PATTERN.source}`,
    data: {
      group,
      pattern: TASK_ALIAS_PATTERN.source,
    },
  };
}

function unknownTaskGroupResult(
  group: string,
  groups: Iterable<string>,
): ToolExecutionResult {
  const available = [...groups].sort((left, right) =>
    left.localeCompare(right),
  );
  return {
    ok: false,
    summary: `Unknown background subtask group '${group}'`,
    content:
      available.length > 0
        ? `Available groups:\n${available.join("\n")}`
        : undefined,
    data: {
      group,
      available,
    },
  };
}

async function prepareSubagentHarness(input: {
  factoryRef: MutableRef<AgentHarnessFactory>;
  worktreeManager: WorktreeManager;
  workspaceRoot: string;
  parent: TopLevelHarnessInfo;
  taskId: string;
  label: string;
  preset?: string;
  presetRegistry?: AgentPresetRegistry;
  contextMode?: TaskContextMode;
  isolateWorkspace?: boolean;
  worktreeName?: string;
  mode: "sync" | "background";
  subtaskHooksFactory?: SubtaskHooksFactory;
}): Promise<{
  harness: AgentHarness;
  workspaceRoot: string;
  worktree?: ManagedWorktreeEntry;
  warnings: string[];
  systemPrompt: string;
}> {
  const factory = input.factoryRef.get();
  let workspaceRoot = input.workspaceRoot;
  let worktree: ManagedWorktreeEntry | undefined;
  const warnings: string[] = [];

  if (input.isolateWorkspace) {
    const allocation = await input.worktreeManager.allocate({
      ownerKind: "subagent",
      ownerName: input.label,
      preferredName: input.worktreeName,
    });
    workspaceRoot = allocation.workspaceRoot;
    worktree = allocation.worktree;
    if (allocation.warnings) {
      warnings.push(...allocation.warnings);
    }
  }

  const executionProfile = resolveExecutionProfile("subagent", {
    workspaceMode: input.isolateWorkspace ? "isolated" : "shared",
    ...(input.mode === "background"
      ? {
          memoryMode: "persistent",
          priority: "background",
        }
      : {}),
  });

  const goalPrefix = input.mode === "sync" ? "subagent" : "subtask";
  const harnessId = `${goalPrefix}:${input.taskId}`;
  const memoryState =
    input.contextMode === "fresh"
      ? undefined
      : input.parent.delegationSnapshot?.memoryState;
  const created = compileSubagentHarness(factory, {
    id: harnessId,
    name: input.label,
    label: input.label,
    mode: input.mode,
    depth: input.parent.depth + 1,
    parentId: input.parent.id,
    workspaceRoot,
    sessionId: input.parent.sessionId,
    goalId: `${input.parent.goalId}/${goalPrefix}:${input.taskId}`,
    executionProfile,
    preset: input.preset,
    presetRegistry: input.presetRegistry,
    memoryState,
    hooks:
      input.mode === "background"
        ? input.subtaskHooksFactory?.(input.label)
        : undefined,
  });

  warnings.push(...created.warnings);

  return {
    harness: created.harness,
    workspaceRoot,
    worktree,
    warnings,
    systemPrompt: created.systemPrompt,
  };
}

function requireTopLevelHarness(
  toolName: string,
):
  | { ok: true; parent: TopLevelHarnessInfo }
  | { ok: false; result: ToolExecutionResult } {
  const parent = getHarnessContext();
  const parentDepth = parent?.depth ?? 0;
  if (parentDepth >= 1) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: "Nested subagent spawning is disabled",
        error: {
          code: "SUBAGENT_DEPTH_EXCEEDED",
          message: `${toolName} is only available from the top-level harness.`,
        },
        data: {
          parent,
        },
      },
    };
  }

  return {
    ok: true,
    parent: {
      id: parent?.id ?? "main",
      depth: parentDepth,
      sessionId: parent?.sessionId ?? randomUUID(),
      goalId: parent?.goalId ?? "main:root",
      delegationSnapshot: parent?.delegationSnapshotProvider?.(),
      attemptId: parent?.attemptId ?? null,
    },
  };
}

function buildRestoredTopLevelHarnessInfo(harness: {
  parentId?: string;
  depth?: number;
  sessionId?: string;
  goalId?: string;
}): TopLevelHarnessInfo {
  return {
    id: harness.parentId ?? "main",
    depth: Math.max(0, (harness.depth ?? 1) - 1),
    sessionId: harness.sessionId ?? randomUUID(),
    goalId: deriveParentGoalId(harness.goalId),
    attemptId: null,
  };
}

function deriveParentGoalId(goalId: string | undefined): string {
  if (typeof goalId !== "string" || goalId.trim().length === 0) {
    return "main:root";
  }

  const boundary = goalId.lastIndexOf("/");
  return boundary >= 0 ? goalId.slice(0, boundary) : goalId;
}

function normalizeTaskLabel(
  description: string | undefined,
  prefix: string,
  taskId: string,
): string {
  const trimmed = description?.trim();
  if (!trimmed) {
    return `${prefix}-${taskId}`;
  }

  return trimmed.replace(/\s+/g, " ").slice(0, 80);
}

function readTaskWaitMode(
  value: unknown,
  field: string,
): TaskWaitMode | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "any" || value === "all" || value === "first_ready") {
    return value;
  }

  throw new Error(`${field} must be 'any', 'all', or 'first_ready'`);
}

function safeFinalize(harness: AgentHarness): void {
  try {
    harness.finalize();
  } catch {
    // Best-effort cleanup only.
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw interruptError(signal);
  }
}

async function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);

    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(interruptError(signal));
    };

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener("abort", abort, { once: true });
  });
}

function interruptError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return new Error(
    typeof reason === "string" && reason.trim().length > 0
      ? reason
      : "Run interrupted by user.",
  );
}

function classifySubagentStatusImportance(
  status: BackgroundSubtaskStatus,
): StepCliSessionHookEventPayload["importance"] {
  if (
    status === "running" ||
    status === "completed" ||
    status === "error" ||
    status === "interrupted" ||
    status === "lost"
  ) {
    return "high";
  }

  return "medium";
}
