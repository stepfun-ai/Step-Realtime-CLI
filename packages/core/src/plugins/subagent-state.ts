import type { AgentHarnessState } from "../agent/harness.js";
import type { AgentExecutionProfile } from "../runtime-context-types.js";
import type { AgentRunArtifactRef } from "../agent/run-artifact-store.js";
import type { ManagedWorktreeEntry } from "../agent/worktree-manager.js";
import type { ToolExecutionResult } from "@step-cli/protocol";
import { truncateText } from "@step-cli/utils/text.js";

export type BackgroundSubtaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "error"
  | "interrupted"
  | "lost";

export interface BackgroundSubtaskQueuedTurn {
  prompt: string;
  enqueuedAt: string;
}

export interface BackgroundSubtaskActiveTurn extends BackgroundSubtaskQueuedTurn {
  startedAt: string;
}

export interface BackgroundSubtaskLastRun {
  prompt?: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  notice?: string;
  outputPreview?: string;
  error?: string;
  steps?: number;
  toolCalls?: number;
  artifact?: AgentRunArtifactRef;
  artifactError?: string;
}

export interface BackgroundSubtaskView {
  id: string;
  label: string;
  alias?: string;
  group?: string;
  status: BackgroundSubtaskStatus;
  queueDepth: number;
  workspaceRoot: string;
  worktree?: ManagedWorktreeEntry;
  executionProfile: AgentExecutionProfile;
  createdAt: string;
  updatedAt: string;
  activePrompt?: string;
  lastPrompt?: string;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastSummary?: string;
  lastError?: string;
  steps?: number;
  toolCalls?: number;
  artifact?: AgentRunArtifactRef;
  warnings?: string[];
}

export interface BackgroundSubtaskNotification {
  sequence: number;
  taskId: string;
  label: string;
  alias?: string;
  status: BackgroundSubtaskStatus;
  summary: string;
  content: string;
  at: string;
}

export interface SerializedBackgroundSubtask {
  id: string;
  label: string;
  alias?: string;
  group?: string;
  status: BackgroundSubtaskStatus;
  createdAt: string;
  updatedAt: string;
  workspaceRoot: string;
  worktree?: ManagedWorktreeEntry;
  warnings?: string[];
  systemPrompt: string;
  harnessState: AgentHarnessState;
  queue: BackgroundSubtaskQueuedTurn[];
  activeTurn?: BackgroundSubtaskActiveTurn;
  lastRun?: BackgroundSubtaskLastRun;
}

export interface SerializedBackgroundSubtaskState {
  version: 1;
  tasks: SerializedBackgroundSubtask[];
}

interface BackgroundSubtaskBusyLike {
  status: BackgroundSubtaskStatus;
  queue: readonly BackgroundSubtaskQueuedTurn[];
  activeTurn?: BackgroundSubtaskActiveTurn;
}

interface BackgroundSubtaskSortableLike {
  label: string;
  status: BackgroundSubtaskStatus;
  updatedAt: string;
}

interface UnknownBackgroundSubtaskHandle {
  id: string;
  alias?: string;
  label?: string;
}

export function renderTaskOverview(task: BackgroundSubtaskView): string {
  const lines = [`[task:${task.id}] ${task.status} ${task.label}`];
  if (task.alias) {
    lines.push(`alias: ${task.alias}`);
  }
  if (task.group) {
    lines.push(`group: ${task.group}`);
  }
  lines.push(`workspace_mode: ${task.executionProfile.workspaceMode}`);
  lines.push(`memory_mode: ${task.executionProfile.memoryMode}`);
  lines.push(`priority: ${task.executionProfile.priority}`);
  lines.push(`queued_turns: ${task.queueDepth}`);
  lines.push(`workspace_root: ${task.workspaceRoot}`);
  if (task.worktree) {
    lines.push(`worktree: ${task.worktree.name} (${task.worktree.path})`);
  }
  if (task.activePrompt) {
    lines.push(`active_prompt: ${shorten(task.activePrompt, 180)}`);
  }
  if (task.lastSummary) {
    lines.push(`last_summary: ${task.lastSummary}`);
  }
  if (task.lastError) {
    lines.push(`last_error: ${task.lastError}`);
  }
  if (task.lastStartedAt) {
    lines.push(`last_started_at: ${task.lastStartedAt}`);
  }
  if (task.lastFinishedAt) {
    lines.push(`last_finished_at: ${task.lastFinishedAt}`);
  }
  if (typeof task.steps === "number") {
    lines.push(`steps: ${task.steps}`);
  }
  if (typeof task.toolCalls === "number") {
    lines.push(`tool_calls: ${task.toolCalls}`);
  }
  if (task.artifact) {
    lines.push(`artifact: ${task.artifact.relativePath}`);
  }
  for (const warning of task.warnings ?? []) {
    lines.push(`warning: ${warning}`);
  }
  return lines.join("\n");
}

export function renderTaskDetails(
  task: BackgroundSubtaskView,
  notice: string | undefined,
): string {
  const overview = renderTaskOverview(task);
  if (!notice) {
    return overview;
  }
  return `${overview}\n${notice}`;
}

export function renderNotifications(
  entries: BackgroundSubtaskNotification[],
): string {
  return entries.map((entry) => renderNotification(entry)).join("\n\n");
}

export function renderNotification(
  entry: BackgroundSubtaskNotification,
  maxChars?: number,
): string {
  const content =
    typeof maxChars === "number"
      ? truncateText({
          text: entry.content,
          maxChars,
          strategy: "head_tail",
        }).text
      : entry.content;

  return [
    `[task:${entry.taskId}] ${entry.status} ${entry.label}`,
    entry.alias ? `alias: ${entry.alias}` : undefined,
    entry.summary,
    content,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function compareBackgroundSubtaskRecords(
  left: BackgroundSubtaskSortableLike,
  right: BackgroundSubtaskSortableLike,
): number {
  const rankDelta =
    backgroundSubtaskStatusRank(left.status) -
    backgroundSubtaskStatusRank(right.status);
  if (rankDelta !== 0) {
    return rankDelta;
  }

  const updatedDelta = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedDelta !== 0) {
    return updatedDelta;
  }

  return left.label.localeCompare(right.label);
}

export function unknownTaskResult(
  taskId: string,
  availableTasks: Iterable<string | UnknownBackgroundSubtaskHandle>,
): ToolExecutionResult {
  const normalized = [...availableTasks]
    .map((entry) =>
      typeof entry === "string"
        ? {
            id: entry,
          }
        : entry,
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const available = normalized.map((entry) => formatUnknownTaskHandle(entry));
  return {
    ok: false,
    summary: `Unknown background subtask '${taskId}'`,
    content:
      available.length > 0
        ? `Available subtasks:\n${available.join("\n")}`
        : undefined,
    data: {
      taskId,
      available,
    },
  };
}

export function parseSerializedBackgroundSubtask(
  value: unknown,
): SerializedBackgroundSubtask | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const entry = value as Record<string, unknown>;
  const id = typeof entry.id === "string" ? entry.id : "";
  const label = typeof entry.label === "string" ? entry.label : "";
  const alias = typeof entry.alias === "string" ? entry.alias : undefined;
  const group = typeof entry.group === "string" ? entry.group : undefined;
  const status = parseBackgroundSubtaskStatus(entry.status);
  const createdAt =
    typeof entry.createdAt === "string"
      ? entry.createdAt
      : new Date().toISOString();
  const updatedAt =
    typeof entry.updatedAt === "string" ? entry.updatedAt : createdAt;
  const workspaceRoot =
    typeof entry.workspaceRoot === "string" ? entry.workspaceRoot : "";
  const systemPrompt =
    typeof entry.systemPrompt === "string" ? entry.systemPrompt : "";
  const harnessState = parseHarnessState(entry.harnessState);
  const queue = Array.isArray(entry.queue)
    ? entry.queue
        .map((candidate) => parseQueuedTurn(candidate))
        .filter((candidate): candidate is BackgroundSubtaskQueuedTurn =>
          Boolean(candidate),
        )
    : [];
  const activeTurn = parseActiveTurn(entry.activeTurn);
  const warnings = Array.isArray(entry.warnings)
    ? entry.warnings.filter(
        (candidate): candidate is string => typeof candidate === "string",
      )
    : undefined;
  const lastRun = parseLastRun(entry.lastRun);
  const worktree = parseManagedWorktree(entry.worktree);

  if (!id || !label || !status || !systemPrompt || !harnessState) {
    return null;
  }

  return {
    id,
    label,
    alias,
    group,
    status,
    createdAt,
    updatedAt,
    workspaceRoot,
    worktree: worktree ?? undefined,
    warnings,
    systemPrompt,
    harnessState,
    queue,
    activeTurn: activeTurn ?? undefined,
    lastRun: lastRun ?? undefined,
  };
}

export function isTaskBusy(
  task: BackgroundSubtaskBusyLike | undefined,
): boolean {
  if (!task) {
    return false;
  }

  return (
    task.status === "queued" ||
    task.status === "running" ||
    task.queue.length > 0 ||
    Boolean(task.activeTurn)
  );
}

function backgroundSubtaskStatusRank(status: BackgroundSubtaskStatus): number {
  switch (status) {
    case "running":
      return 0;
    case "queued":
      return 1;
    case "error":
    case "interrupted":
    case "lost":
      return 2;
    case "completed":
    default:
      return 3;
  }
}

function parseBackgroundSubtaskStatus(
  value: unknown,
): BackgroundSubtaskStatus | null {
  switch (value) {
    case "queued":
    case "running":
    case "completed":
    case "error":
    case "interrupted":
    case "lost":
      return value;
    default:
      return null;
  }
}

function parseHarnessState(value: unknown): AgentHarnessState | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const entry = value as Partial<AgentHarnessState>;
  if (!entry.identity || !entry.memory || !entry.toolRuntime) {
    return null;
  }

  return entry as AgentHarnessState;
}

function parseQueuedTurn(value: unknown): BackgroundSubtaskQueuedTurn | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const entry = value as Record<string, unknown>;
  const prompt = typeof entry.prompt === "string" ? entry.prompt : "";
  const enqueuedAt =
    typeof entry.enqueuedAt === "string"
      ? entry.enqueuedAt
      : new Date().toISOString();
  if (!prompt) {
    return null;
  }

  return {
    prompt,
    enqueuedAt,
  };
}

function parseActiveTurn(value: unknown): BackgroundSubtaskActiveTurn | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const entry = value as Record<string, unknown>;
  const queued = parseQueuedTurn(entry);
  const startedAt = typeof entry.startedAt === "string" ? entry.startedAt : "";
  if (!queued || !startedAt) {
    return null;
  }

  return {
    ...queued,
    startedAt,
  };
}

function parseLastRun(value: unknown): BackgroundSubtaskLastRun | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const entry = value as Record<string, unknown>;
  return {
    prompt: typeof entry.prompt === "string" ? entry.prompt : undefined,
    startedAt:
      typeof entry.startedAt === "string" ? entry.startedAt : undefined,
    finishedAt:
      typeof entry.finishedAt === "string" ? entry.finishedAt : undefined,
    summary: typeof entry.summary === "string" ? entry.summary : undefined,
    notice: typeof entry.notice === "string" ? entry.notice : undefined,
    outputPreview:
      typeof entry.outputPreview === "string" ? entry.outputPreview : undefined,
    error: typeof entry.error === "string" ? entry.error : undefined,
    steps: typeof entry.steps === "number" ? entry.steps : undefined,
    toolCalls:
      typeof entry.toolCalls === "number" ? entry.toolCalls : undefined,
    artifact: parseArtifact(entry.artifact) ?? undefined,
    artifactError:
      typeof entry.artifactError === "string" ? entry.artifactError : undefined,
  };
}

function parseArtifact(value: unknown): AgentRunArtifactRef | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const entry = value as Record<string, unknown>;
  if (
    entry.kind !== "agent_run" ||
    (entry.category !== "subagent" && entry.category !== "teammate") ||
    typeof entry.artifactId !== "string" ||
    typeof entry.absolutePath !== "string" ||
    typeof entry.relativePath !== "string"
  ) {
    return null;
  }

  return entry as unknown as AgentRunArtifactRef;
}

function parseManagedWorktree(value: unknown): ManagedWorktreeEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const entry = value as Record<string, unknown>;
  if (
    typeof entry.name !== "string" ||
    typeof entry.path !== "string" ||
    typeof entry.branch !== "string" ||
    (entry.ownerKind !== "subagent" && entry.ownerKind !== "teammate") ||
    typeof entry.ownerName !== "string" ||
    typeof entry.workspaceSubpath !== "string" ||
    (entry.status !== "active" && entry.status !== "stale") ||
    typeof entry.createdAt !== "string" ||
    typeof entry.updatedAt !== "string"
  ) {
    return null;
  }

  return entry as unknown as ManagedWorktreeEntry;
}

function shorten(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function formatUnknownTaskHandle(
  handle: UnknownBackgroundSubtaskHandle,
): string {
  const alias =
    typeof handle.alias === "string" && handle.alias.trim().length > 0
      ? handle.alias.trim()
      : null;
  const label =
    typeof handle.label === "string" && handle.label.trim().length > 0
      ? handle.label.trim()
      : null;

  if (alias && label) {
    return `${handle.id} (alias: ${alias}, label: ${label})`;
  }

  if (alias) {
    return `${handle.id} (alias: ${alias})`;
  }

  if (label) {
    return `${handle.id} (${label})`;
  }

  return handle.id;
}
