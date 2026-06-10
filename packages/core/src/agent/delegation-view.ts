import type { AgentTeamState, TeamProtocolRequest } from "./agent-team.js";
import {
  formatExecutionProfile,
  type AgentExecutionProfile,
} from "./harness-context.js";
import type { BackgroundSubtaskView } from "../plugins/subagent-state.js";
import type { BackgroundCommandView } from "../plugins/background-tasks-types.js";

const BACKGROUND_COMMAND_LABEL_MAX_CHARS = 52;

type DelegationKind = "teammate" | "subtask" | "background_command";

export interface DelegationActionAffordances {
  reply?: boolean;
  interrupt?: boolean;
  waitReady?: boolean;
}

interface BaseDelegationView {
  kind: DelegationKind;
  id: string;
  alias?: string;
  label: string;
  status: string;
  workspaceRoot: string;
  sessionId?: string;
  goalId?: string;
  executionProfile?: AgentExecutionProfile;
  createdAt?: string;
  updatedAt: string;
  queueDepth?: number;
  lastSummary?: string;
  lastError?: string;
  canReply?: boolean;
  canInterrupt?: boolean;
  canWaitReady?: boolean;
}

interface TeammateDelegationView extends BaseDelegationView {
  kind: "teammate";
  name: string;
  role: string;
  lead: string;
}

interface SubtaskDelegationView extends BaseDelegationView {
  kind: "subtask";
  taskId: string;
  group?: string;
  activePrompt?: string;
  artifactPath?: string;
  warnings: string[];
}

interface BackgroundCommandDelegationView extends BaseDelegationView {
  kind: "background_command";
  command: string;
  exitCode?: number;
  timedOut?: boolean;
  outputPreview?: string;
}

export type DelegationView =
  | TeammateDelegationView
  | SubtaskDelegationView
  | BackgroundCommandDelegationView;

interface DelegationSummary {
  teammates: {
    total: number;
    working: number;
    idle: number;
    error: number;
    shutdown: number;
  };
  background: {
    total: number;
    running: number;
    queued: number;
    problem: number;
    subtasks: number;
    runningSubtasks: number;
    queuedSubtasks: number;
    problemSubtasks: number;
    commands: number;
    runningCommands: number;
    problemCommands: number;
  };
}

interface TeammateOverlayEntry {
  name: string;
  status: string;
  role: string;
  lead: string;
  workspace: string;
  profile: string;
  updated: string;
  session: string;
  goal: string;
  actions: DelegationActionAffordances;
}

interface BackgroundSubtaskOverlayEntry {
  label: string;
  alias: string;
  group: string;
  status: string;
  kind: string;
  taskId: string;
  workspace: string;
  profile: string;
  updated: string;
  queue: number;
  active: string;
  summary: string;
  error: string;
  artifact: string;
  warnings: string[];
  actions: DelegationActionAffordances;
}

interface BackgroundCommandOverlayEntry {
  label: string;
  id: string;
  status: string;
  kind: string;
  workspace: string;
  updated: string;
  command: string;
  summary: string;
  error: string;
  actions: DelegationActionAffordances;
}

interface DelegationProtocolRequestView {
  requestId: string;
  from: string;
  to: string;
  status: string;
  updated: string;
}

export interface TeammatesOverlaySnapshot {
  summary: {
    teammates: number;
    working: number;
    idle: number;
    error: number;
    shutdown: number;
    planRequests: number;
    shutdownRequests: number;
    subtasks: number;
    runningSubtasks: number;
    queuedSubtasks: number;
    problemSubtasks: number;
    backgroundCommands: number;
    runningBackgroundCommands: number;
    problemBackgroundCommands: number;
    backgroundTotal: number;
    runningBackground: number;
    queuedBackground: number;
    problemBackground: number;
  };
  unavailable: string[];
  emptyState: string | null;
  teammates: TeammateOverlayEntry[];
  planRequests: DelegationProtocolRequestView[];
  subtasks: BackgroundSubtaskOverlayEntry[];
  backgroundCommands: BackgroundCommandOverlayEntry[];
  shutdownRequests: DelegationProtocolRequestView[];
}

interface DelegationSnapshotSource {
  team: AgentTeamState | null;
  delegations: readonly DelegationView[];
}

export function buildDelegationViews(input: {
  team: AgentTeamState | null;
  subtasks: readonly BackgroundSubtaskView[];
  backgroundCommands: readonly BackgroundCommandView[];
}): DelegationView[] {
  return [
    ...buildTeammateDelegationViews(input.team),
    ...buildSubtaskDelegationViews(input.subtasks),
    ...buildBackgroundCommandDelegationViews(input.backgroundCommands),
  ];
}

function summarizeDelegations(
  delegations: readonly DelegationView[],
): DelegationSummary {
  return delegations.reduce<DelegationSummary>(
    (summary, delegation) => {
      switch (delegation.kind) {
        case "teammate":
          summary.teammates.total += 1;
          switch (delegation.status) {
            case "working":
              summary.teammates.working += 1;
              break;
            case "idle":
              summary.teammates.idle += 1;
              break;
            case "error":
              summary.teammates.error += 1;
              break;
            case "shutdown":
              summary.teammates.shutdown += 1;
              break;
            default:
              break;
          }
          break;
        case "subtask":
          summary.background.total += 1;
          summary.background.subtasks += 1;
          switch (delegation.status) {
            case "running":
              summary.background.running += 1;
              summary.background.runningSubtasks += 1;
              break;
            case "queued":
              summary.background.queued += 1;
              summary.background.queuedSubtasks += 1;
              break;
            case "error":
            case "interrupted":
            case "lost":
              summary.background.problem += 1;
              summary.background.problemSubtasks += 1;
              break;
            default:
              break;
          }
          break;
        case "background_command":
          summary.background.total += 1;
          summary.background.commands += 1;
          switch (delegation.status) {
            case "running":
              summary.background.running += 1;
              summary.background.runningCommands += 1;
              break;
            case "error":
            case "timeout":
            case "lost":
              summary.background.problem += 1;
              summary.background.problemCommands += 1;
              break;
            default:
              break;
          }
          break;
        default:
          break;
      }
      return summary;
    },
    {
      teammates: {
        total: 0,
        working: 0,
        idle: 0,
        error: 0,
        shutdown: 0,
      },
      background: {
        total: 0,
        running: 0,
        queued: 0,
        problem: 0,
        subtasks: 0,
        runningSubtasks: 0,
        queuedSubtasks: 0,
        problemSubtasks: 0,
        commands: 0,
        runningCommands: 0,
        problemCommands: 0,
      },
    },
  );
}

export function buildTeammatesOverlaySnapshot(
  source: DelegationSnapshotSource,
): TeammatesOverlaySnapshot {
  const summary = summarizeDelegations(source.delegations);
  const teammates = source.delegations
    .filter(
      (delegation): delegation is TeammateDelegationView =>
        delegation.kind === "teammate",
    )
    .map((delegation) => ({
      name: delegation.name,
      status: delegation.status,
      role: delegation.role,
      lead: delegation.lead,
      workspace: formatDisplayPath(delegation.workspaceRoot),
      profile: formatExecutionProfile(delegation.executionProfile ?? {}),
      updated: formatTimestamp(delegation.updatedAt),
      session: shortId(delegation.sessionId),
      goal: formatGoalId(delegation.goalId),
      actions: extractDelegationActionAffordances(delegation),
    }));
  const subtasks = source.delegations
    .filter(
      (delegation): delegation is SubtaskDelegationView =>
        delegation.kind === "subtask",
    )
    .map((delegation) => ({
      label: delegation.label,
      alias: delegation.alias ?? "",
      group: delegation.group ?? "",
      status: delegation.status,
      kind: "background subtask",
      taskId: delegation.taskId,
      workspace: formatDisplayPath(delegation.workspaceRoot),
      profile: formatExecutionProfile(delegation.executionProfile ?? {}),
      updated: formatTimestamp(delegation.updatedAt),
      queue: delegation.queueDepth ?? 0,
      active: normalizeInlineValue(delegation.activePrompt) ?? "",
      summary: normalizeInlineValue(delegation.lastSummary) ?? "",
      error: normalizeInlineValue(delegation.lastError) ?? "",
      artifact: normalizeInlineValue(delegation.artifactPath) ?? "",
      warnings: delegation.warnings
        .map((warning) => normalizeInlineValue(warning))
        .filter((warning): warning is string => Boolean(warning)),
      actions: extractDelegationActionAffordances(delegation),
    }));
  const backgroundCommands = source.delegations
    .filter(
      (delegation): delegation is BackgroundCommandDelegationView =>
        delegation.kind === "background_command",
    )
    .map((delegation) => ({
      label: delegation.label,
      id: delegation.id,
      status: delegation.status,
      kind: "background command",
      workspace: formatDisplayPath(delegation.workspaceRoot),
      updated: formatTimestamp(delegation.updatedAt),
      command: normalizeInlineValue(delegation.command) ?? delegation.id,
      summary: normalizeInlineValue(delegation.lastSummary) ?? "",
      error: normalizeInlineValue(delegation.lastError) ?? "",
      actions: extractDelegationActionAffordances(delegation),
    }));
  const pendingPlans = (source.team?.planRequests ?? []).filter(
    (request) => request.status === "pending",
  );
  const pendingShutdown = (source.team?.shutdownRequests ?? []).filter(
    (request) => request.status === "pending",
  );

  return {
    summary: {
      teammates: summary.teammates.total,
      working: summary.teammates.working,
      idle: summary.teammates.idle,
      error: summary.teammates.error,
      shutdown: summary.teammates.shutdown,
      planRequests: pendingPlans.length,
      shutdownRequests: pendingShutdown.length,
      subtasks: summary.background.subtasks,
      runningSubtasks: summary.background.runningSubtasks,
      queuedSubtasks: summary.background.queuedSubtasks,
      problemSubtasks: summary.background.problemSubtasks,
      backgroundCommands: summary.background.commands,
      runningBackgroundCommands: summary.background.runningCommands,
      problemBackgroundCommands: summary.background.problemCommands,
      backgroundTotal: summary.background.total,
      runningBackground: summary.background.running,
      queuedBackground: summary.background.queued,
      problemBackground: summary.background.problem,
    },
    unavailable:
      source.team === null
        ? ["persistent teammate orchestration is unavailable in this session"]
        : [],
    emptyState:
      source.team !== null &&
      teammates.length === 0 &&
      subtasks.length === 0 &&
      backgroundCommands.length === 0
        ? "no persistent teammates yet"
        : null,
    teammates,
    planRequests: pendingPlans.map(formatProtocolRequest),
    subtasks,
    backgroundCommands,
    shutdownRequests: pendingShutdown.map(formatProtocolRequest),
  };
}

function buildTeammateDelegationViews(
  team: AgentTeamState | null,
): TeammateDelegationView[] {
  if (!team) {
    return [];
  }

  return team.teammates.map((teammate) => ({
    kind: "teammate",
    id: `teammate:${teammate.name}`,
    name: teammate.name,
    label: teammate.name,
    role: teammate.role,
    lead: teammate.lead,
    status: teammate.status,
    workspaceRoot: teammate.workspaceRoot,
    sessionId: teammate.sessionId,
    goalId: teammate.goalId,
    executionProfile: teammate.executionProfile,
    createdAt: teammate.createdAt,
    updatedAt: teammate.updatedAt,
    canReply: teammate.status !== "shutdown",
    canInterrupt: teammate.status === "working",
  }));
}

function buildSubtaskDelegationViews(
  subtasks: readonly BackgroundSubtaskView[],
): SubtaskDelegationView[] {
  return subtasks.map((subtask) => ({
    kind: "subtask",
    id: subtask.id,
    taskId: subtask.id,
    alias: subtask.alias,
    group: subtask.group,
    label: subtask.label,
    status: subtask.status,
    workspaceRoot: subtask.workspaceRoot,
    executionProfile: subtask.executionProfile,
    createdAt: subtask.createdAt,
    updatedAt: subtask.updatedAt,
    queueDepth: subtask.queueDepth,
    lastSummary: subtask.lastSummary,
    lastError: subtask.lastError,
    activePrompt: subtask.activePrompt,
    artifactPath: subtask.artifact?.relativePath,
    warnings: subtask.warnings ?? [],
    canReply: true,
    canInterrupt: canInterruptBackgroundSubtask(subtask),
    canWaitReady: canWaitForBackgroundSubtaskUpdate(subtask),
  }));
}

function buildBackgroundCommandDelegationViews(
  backgroundCommands: readonly BackgroundCommandView[],
): BackgroundCommandDelegationView[] {
  return backgroundCommands.map((task) => {
    const statusMessage = buildBackgroundCommandStatusMessage(task);
    const outputPreview = normalizeInlineValue(task.outputPreview) ?? undefined;
    const isProblem =
      task.status === "error" ||
      task.status === "timeout" ||
      task.status === "lost";

    return {
      kind: "background_command",
      id: task.id,
      label: shortenInline(
        normalizeInlineValue(task.command) ?? `command ${task.id}`,
        BACKGROUND_COMMAND_LABEL_MAX_CHARS,
      ),
      status: task.status,
      workspaceRoot: task.cwd,
      createdAt: task.startedAt,
      updatedAt: task.updatedAt,
      lastSummary: isProblem
        ? undefined
        : (outputPreview ??
          (task.status === "completed" ? statusMessage : undefined)),
      lastError: isProblem ? (outputPreview ?? statusMessage) : undefined,
      canReply: false,
      canInterrupt: false,
      canWaitReady: false,
      command: task.command,
      exitCode: task.exitCode,
      timedOut: task.timedOut,
      outputPreview,
    };
  });
}

function buildBackgroundCommandStatusMessage(
  task: BackgroundCommandView,
): string {
  switch (task.status) {
    case "completed":
      return typeof task.exitCode === "number"
        ? `completed (exit ${task.exitCode})`
        : "completed";
    case "timeout":
      return "timed out";
    case "error":
      return typeof task.exitCode === "number"
        ? `failed (exit ${task.exitCode})`
        : "failed";
    case "lost":
      return "restored after a previously running command";
    case "running":
    default:
      return "running in background";
  }
}

function extractDelegationActionAffordances(
  delegation: Pick<
    DelegationView,
    "canReply" | "canInterrupt" | "canWaitReady"
  >,
): DelegationActionAffordances {
  const actions: DelegationActionAffordances = {};
  if (typeof delegation.canReply === "boolean") {
    actions.reply = delegation.canReply;
  }
  if (typeof delegation.canInterrupt === "boolean") {
    actions.interrupt = delegation.canInterrupt;
  }
  if (typeof delegation.canWaitReady === "boolean") {
    actions.waitReady = delegation.canWaitReady;
  }
  return actions;
}

function formatProtocolRequest(
  request: TeamProtocolRequest,
): DelegationProtocolRequestView {
  return {
    requestId: request.requestId,
    from: request.from,
    to: request.to,
    status: request.status,
    updated: formatTimestamp(request.updatedAt),
  };
}

function canInterruptBackgroundSubtask(task: BackgroundSubtaskView): boolean {
  return (
    task.status === "running" ||
    task.status === "queued" ||
    task.queueDepth > 0 ||
    Boolean(task.activePrompt)
  );
}

function canWaitForBackgroundSubtaskUpdate(
  task: BackgroundSubtaskView,
): boolean {
  return (
    task.status === "running" ||
    task.status === "queued" ||
    task.queueDepth > 0 ||
    Boolean(task.activePrompt)
  );
}

function normalizeInlineValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function shortenInline(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
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

function formatGoalId(value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    return "unknown";
  }

  return value.length <= 36
    ? value
    : `${value.slice(0, 24)}…${value.slice(-10)}`;
}

function formatTimestamp(value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    return "unknown";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "Z");
}
