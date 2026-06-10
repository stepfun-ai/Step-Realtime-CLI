import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolExecutionResult, ToolSpec } from "@step-cli/protocol";
import type {
  BackgroundCommandView,
  BackgroundTasksToolPlugin,
  BackgroundTaskStatus,
} from "@step-cli/core/plugins/background-tasks-types.js";
import {
  parseJsonObject,
  readIntegerField,
  readRequiredStringField,
  readStringField,
} from "@step-cli/core/tools/args.js";
import { clamp } from "@step-cli/utils/math.js";
import {
  resolveExistingPathInWorkspace,
  toWorkspaceRelative,
} from "@step-cli/utils/path.js";
import { truncateText } from "@step-cli/utils/text.js";
import type {
  PluginHookContext,
  PluginHookResult,
} from "@step-cli/core/plugins/types.js";
import { enforceOutputLimit, renderCommandOutput } from "./command-output.js";
import { createCommandInspection } from "./tool-inspection.js";

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_NOTIFICATION_PREVIEW_CHARS = 900;
const MAX_TASK_HISTORY = 64;
const FORCE_KILL_GRACE_MS = 1_500;

interface BackgroundTask {
  id: string;
  status: BackgroundTaskStatus;
  command: string;
  cwd: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  timedOut?: boolean;
  output: string;
  outputTruncation?: {
    originalChars: number;
    retainedChars: number;
  };
}

interface BackgroundNotification {
  id: string;
  status: BackgroundTaskStatus;
  command: string;
  outputPreview: string;
  at: string;
}

export interface BackgroundTasksPluginInstance extends BackgroundTasksToolPlugin {
  loadState(state: unknown): void;
  shutdown(reason?: string): Promise<void>;
}

function signalChildProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to signaling the immediate shell process.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // Best-effort cleanup only.
  }
}

class BackgroundTaskManager {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly notifications: BackgroundNotification[] = [];
  private readonly children = new Map<string, ChildProcess>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly logPaths = new Map<string, string>();
  private readonly outputLimits = new Map<string, number>();
  private readonly settleCallbacks = new Map<string, () => void>();
  private readonly taskTimers = new Map<string, NodeJS.Timeout>();
  private readonly forceKillTimers = new Map<string, NodeJS.Timeout>();
  private shutdownPromise: Promise<void> | null = null;

  run(input: {
    command: string;
    cwd: string;
    timeoutMs: number;
    outputLimit: number;
  }): BackgroundTask {
    const id = randomUUID().slice(0, 8);
    const startedAt = new Date().toISOString();

    const task: BackgroundTask = {
      id,
      status: "running",
      command: input.command,
      cwd: input.cwd,
      startedAt,
      output: "",
    };

    this.tasks.set(id, task);
    this.trimHistory();

    const logPath = path.join(tmpdir(), `step-cli-bg-${process.pid}-${id}.log`);
    const stdoutFd = openSync(logPath, "a");
    const stderrFd = openSync(logPath, "a");
    const child = spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    closeSync(stdoutFd);
    closeSync(stderrFd);
    child.unref?.();
    this.children.set(id, child);
    this.logPaths.set(id, logPath);
    this.outputLimits.set(id, input.outputLimit);

    let timedOut = false;
    let settle: (() => void) | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      this.stopChild(id, "SIGTERM", FORCE_KILL_GRACE_MS);
    }, input.timeoutMs);
    timer.unref?.();
    this.taskTimers.set(id, timer);

    const completion = new Promise<void>((resolve) => {
      let settled = false;
      settle = () => {
        if (settled) {
          return;
        }
        settled = true;
        this.clearTaskTimer(id);
        this.clearForceKillTimer(id);
        this.children.delete(id);
        this.settleCallbacks.delete(id);
        this.inFlight.delete(id);
        resolve();
      };
      this.settleCallbacks.set(id, settle);

      child.on("error", (error) => {
        task.status = "error";
        task.finishedAt = new Date().toISOString();
        task.output = `Process error: ${error instanceof Error ? error.message : String(error)}`;
        this.enqueueNotification(task);
        settle?.();
      });

      child.on("close", (code) => {
        task.finishedAt = new Date().toISOString();
        task.exitCode = code ?? -1;
        task.timedOut = timedOut;

        const logOutput = this.readTaskLog(id);
        const rendered = renderCommandOutput({
          exitCode: task.exitCode,
          timedOut,
          stdout: logOutput,
          stderr: "",
          timeoutMs: input.timeoutMs,
        });

        const truncated = truncateText({
          text: rendered,
          maxChars: input.outputLimit,
          strategy: "head_tail",
        });

        task.output = truncated.text;
        task.outputTruncation = truncated.truncation
          ? {
              originalChars: truncated.truncation.originalChars,
              retainedChars: truncated.truncation.retainedChars,
            }
          : undefined;

        if (timedOut) {
          task.status = "timeout";
        } else if (task.exitCode === 0) {
          task.status = "completed";
        } else {
          task.status = "error";
        }

        this.enqueueNotification(task);
        settle?.();
      });
    });
    this.inFlight.set(id, completion);

    return task;
  }

  check(taskId?: string): {
    ok: boolean;
    summary: string;
    content: string;
    data: unknown;
  } {
    if (taskId) {
      const task = this.tasks.get(taskId);
      if (!task) {
        return {
          ok: false,
          summary: `Unknown background task '${taskId}'`,
          content: "",
          data: {
            taskId,
            available: [...this.tasks.keys()],
          },
        };
      }

      if (task.status === "running") {
        task.output = this.readTaskLog(task.id);
      }

      return {
        ok: task.status === "completed",
        summary: `[${task.status}] ${shorten(task.command, 70)}`,
        content: task.output,
        data: {
          id: task.id,
          status: task.status,
          command: task.command,
          cwd: task.cwd,
          startedAt: task.startedAt,
          finishedAt: task.finishedAt,
          exitCode: task.exitCode,
          timedOut: task.timedOut,
          outputTruncation: task.outputTruncation,
        },
      };
    }

    const lines: string[] = [];
    for (const task of this.tasks.values()) {
      const marker =
        task.status === "completed"
          ? "ok"
          : task.status === "running"
            ? "..."
            : "err";
      lines.push(`${task.id} [${marker}] ${shorten(task.command, 110)}`);
    }

    return {
      ok: true,
      summary: `Background tasks: ${this.tasks.size}`,
      content: lines.join("\n") || "(none)",
      data: {
        tasks: [...this.tasks.values()].map((task) => ({
          id: task.id,
          status: task.status,
          command: task.command,
          cwd: task.cwd,
          startedAt: task.startedAt,
          finishedAt: task.finishedAt,
          exitCode: task.exitCode,
          timedOut: task.timedOut,
        })),
      },
    };
  }

  drainNotifications(): BackgroundNotification[] {
    if (this.notifications.length === 0) {
      return [];
    }
    const drained = [...this.notifications];
    this.notifications.length = 0;
    return drained;
  }

  listViews(): BackgroundCommandView[] {
    return [...this.tasks.values()].map((task) => this.toView(task));
  }

  exportState(): unknown {
    return {
      tasks: [...this.tasks.values()],
    };
  }

  loadState(state: unknown): void {
    this.stopAllChildren("Background task state reloaded.");
    this.tasks.clear();
    this.notifications.length = 0;
    this.logPaths.clear();
    this.outputLimits.clear();
    this.settleCallbacks.clear();
    this.taskTimers.clear();
    this.forceKillTimers.clear();

    if (!state || typeof state !== "object") {
      return;
    }

    const candidate = state as Record<string, unknown>;
    const tasks = candidate.tasks;
    if (!Array.isArray(tasks)) {
      return;
    }

    for (const entry of tasks) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id : "";
      const command = typeof item.command === "string" ? item.command : "";
      const cwd = typeof item.cwd === "string" ? item.cwd : ".";
      const status = typeof item.status === "string" ? item.status : "lost";
      if (!id || !command) {
        continue;
      }

      const normalizedStatus =
        status === "running" ? "lost" : (status as BackgroundTaskStatus);
      const startedAt =
        typeof item.startedAt === "string"
          ? item.startedAt
          : new Date().toISOString();
      const finishedAt =
        typeof item.finishedAt === "string" ? item.finishedAt : undefined;
      const exitCode =
        typeof item.exitCode === "number" ? item.exitCode : undefined;
      const timedOut =
        typeof item.timedOut === "boolean" ? item.timedOut : undefined;

      this.tasks.set(id, {
        id,
        status: normalizedStatus,
        command,
        cwd,
        startedAt,
        finishedAt,
        exitCode,
        timedOut,
        output: "",
      });
    }

    this.trimHistory();
  }

  async shutdown(
    reason = "Background task manager shutting down.",
  ): Promise<void> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }

    this.shutdownPromise = this.stopAllChildrenAndWait(reason);

    await this.shutdownPromise;
  }

  private enqueueNotification(task: BackgroundTask): void {
    if (!this.tasks.has(task.id)) {
      return;
    }

    const preview = truncateText({
      text: task.output,
      maxChars: DEFAULT_NOTIFICATION_PREVIEW_CHARS,
      strategy: "head_tail",
    });

    this.notifications.push({
      id: task.id,
      status: task.status,
      command: task.command,
      outputPreview: preview.text,
      at: new Date().toISOString(),
    });
  }

  private trimHistory(): void {
    if (this.tasks.size <= MAX_TASK_HISTORY) {
      return;
    }

    const overflow = this.tasks.size - MAX_TASK_HISTORY;
    const toDelete = [...this.tasks.keys()].slice(0, overflow);
    for (const key of toDelete) {
      this.tasks.delete(key);
      this.logPaths.delete(key);
      this.outputLimits.delete(key);
    }
  }

  private toView(task: BackgroundTask): BackgroundCommandView {
    const preview = truncateText({
      text: task.output,
      maxChars: DEFAULT_NOTIFICATION_PREVIEW_CHARS,
      strategy: "head_tail",
    });

    return {
      id: task.id,
      status: task.status,
      command: task.command,
      cwd: task.cwd,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      updatedAt: task.finishedAt ?? task.startedAt,
      exitCode: task.exitCode,
      timedOut: task.timedOut,
      outputPreview: preview.text.trim().length > 0 ? preview.text : undefined,
    };
  }

  private stopAllChildren(reason: string): Promise<void>[] {
    const completions = [...this.inFlight.values()];
    for (const [taskId] of this.children.entries()) {
      const task = this.tasks.get(taskId);
      if (task && task.status === "running") {
        task.output = this.appendShutdownNote(task, reason);
      }

      this.clearTaskTimer(taskId);
      this.stopChild(taskId, "SIGTERM", FORCE_KILL_GRACE_MS);
    }
    return completions;
  }

  private async stopAllChildrenAndWait(reason: string): Promise<void> {
    const completions = this.stopAllChildren(reason);
    if (completions.length === 0) {
      return;
    }
    await Promise.allSettled(completions);
  }

  private stopChild(
    taskId: string,
    signal: NodeJS.Signals,
    forceKillAfterMs?: number,
  ): void {
    const child = this.children.get(taskId);
    if (!child) {
      return;
    }

    signalChildProcess(child, signal);

    if (signal === "SIGKILL" || !forceKillAfterMs || forceKillAfterMs <= 0) {
      this.clearForceKillTimer(taskId);
      return;
    }

    this.clearForceKillTimer(taskId);
    const forceKillTimer = setTimeout(() => {
      this.forceKillTimers.delete(taskId);
      this.stopChild(taskId, "SIGKILL");
    }, forceKillAfterMs);
    forceKillTimer.unref?.();
    this.forceKillTimers.set(taskId, forceKillTimer);
  }

  private clearForceKillTimer(taskId: string): void {
    const timer = this.forceKillTimers.get(taskId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.forceKillTimers.delete(taskId);
  }

  private clearTaskTimer(taskId: string): void {
    const timer = this.taskTimers.get(taskId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.taskTimers.delete(taskId);
  }

  private appendShutdownNote(task: BackgroundTask, reason: string): string {
    const logOutput =
      task.output.trim().length > 0 ? task.output : this.readTaskLog(task.id);
    return logOutput.trim().length > 0
      ? `${logOutput}\n\nnote: ${reason}`
      : `note: ${reason}`;
  }

  private readTaskLog(taskId: string): string {
    const logPath = this.logPaths.get(taskId);
    if (!logPath) {
      return "";
    }

    try {
      const outputLimit = this.outputLimits.get(taskId) ?? 120_000;
      return enforceOutputLimit(readFileSync(logPath, "utf8"), outputLimit);
    } catch {
      return "";
    }
  }
}

export function createBackgroundTasksPlugin(): BackgroundTasksPluginInstance {
  const manager = new BackgroundTaskManager();

  const hooks = {
    beforeModelRequest: (
      context: PluginHookContext,
    ): PluginHookResult | void => {
      const notifications = manager.drainNotifications();
      if (notifications.length === 0) {
        return;
      }

      const lines = notifications.map((notification) => {
        const header = `[bg:${notification.id}] ${notification.status}: ${shorten(notification.command, 80)}`;
        const body =
          notification.outputPreview.trim().length > 0
            ? `\n${notification.outputPreview}`
            : "";
        return `${header}${body}`;
      });

      return {
        messages: [
          {
            role: "system",
            content: [
              `Background notifications (step=${context.step}):`,
              "<background-results>",
              ...lines,
              "</background-results>",
            ].join("\n"),
          },
        ],
      };
    },
  };

  return {
    id: "background-tasks",
    description: "Background command execution + heartbeat notifications",
    register: () => [
      createBackgroundRunTool(manager),
      createCheckBackgroundTool(manager),
    ],
    hooks,
    getViews: () => manager.listViews(),
    exportState: () => manager.exportState(),
    loadState: (state) => manager.loadState(state),
    shutdown: async (reason) => await manager.shutdown(reason),
  } satisfies BackgroundTasksPluginInstance;
}

export const backgroundTasksPlugin = createBackgroundTasksPlugin();

interface BackgroundRunArgs {
  command: string;
  cwd?: string;
  timeout_ms?: number;
  max_output_chars?: number;
}

function createBackgroundRunTool(
  manager: BackgroundTaskManager,
): ToolSpec<BackgroundRunArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "background_run",
        description:
          "Run a shell command in background. Use for long commands; results will show up later as notifications.",
        parameters: {
          type: "object",
          required: ["command"],
          properties: {
            command: { type: "string", description: "Shell command string" },
            cwd: { type: "string", description: "Relative working directory" },
            timeout_ms: {
              type: "integer",
              minimum: MIN_TIMEOUT_MS,
              maximum: MAX_TIMEOUT_MS,
            },
            max_output_chars: {
              type: "integer",
              minimum: 200,
              maximum: 120000,
              description: "Output character cap for stdout+stderr",
            },
          },
        },
      },
    },
    security: {
      risk: "execute",
      defaultMode: "confirm",
    },
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      return {
        command: readRequiredStringField(payload.command, "command"),
        cwd: readStringField(payload.cwd),
        timeout_ms: readIntegerField(payload.timeout_ms, "timeout_ms"),
        max_output_chars: readIntegerField(
          payload.max_output_chars,
          "max_output_chars",
        ),
      };
    },
    inspect: ({ args }) =>
      createCommandInspection(args.command, "background_run"),
    execute: async (args, ctx) => {
      const timeoutMs = clamp(
        args.timeout_ms ?? ctx.commandTimeoutMs,
        MIN_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      );
      const outputLimit = clamp(
        args.max_output_chars ?? ctx.commandOutputLimit,
        200,
        120_000,
      );
      if (ctx.signal?.aborted) {
        return backgroundNotStartedResult(args, ctx.signal);
      }

      const absoluteCwd = await resolveExistingPathInWorkspace(
        ctx.workspaceRoot,
        args.cwd ?? ".",
      );
      if (ctx.signal?.aborted) {
        return backgroundNotStartedResult(args, ctx.signal);
      }

      const task = manager.run({
        command: args.command,
        cwd: absoluteCwd,
        timeoutMs,
        outputLimit,
      });

      return {
        ok: true,
        summary: `Background task ${task.id} started`,
        data: {
          id: task.id,
          command: args.command,
          cwd: toWorkspaceRelative(ctx.workspaceRoot, absoluteCwd),
          startedAt: task.startedAt,
          timeoutMs,
          outputLimit,
        },
      };
    },
  };
}

function backgroundNotStartedResult(
  args: BackgroundRunArgs,
  signal?: AbortSignal,
): ToolExecutionResult {
  return {
    ok: false,
    summary: "Background task not started",
    error: {
      code: "TOOL_EXECUTION_ABORTED",
      message: getAbortMessage(signal),
    },
    data: {
      command: args.command,
      cwd: args.cwd ?? ".",
    },
  };
}

interface CheckBackgroundArgs {
  task_id?: string;
}

function createCheckBackgroundTool(
  manager: BackgroundTaskManager,
): ToolSpec<CheckBackgroundArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "check_background",
        description:
          "Check background task status. Omit task_id to list all tasks.",
        parameters: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "Background task id" },
          },
        },
      },
    },
    security: {
      risk: "read",
      defaultMode: "allow",
    },
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      return {
        task_id: readStringField(payload.task_id),
      };
    },
    execute: async (args) => {
      const result = manager.check(args.task_id);
      return {
        ok: result.ok,
        summary: result.summary,
        content: result.content,
        data: result.data,
      };
    },
  };
}

function shorten(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function getAbortMessage(signal?: AbortSignal): string {
  const reason = signal?.reason;
  return typeof reason === "string" && reason.trim().length > 0
    ? reason
    : "Run interrupted by user.";
}
