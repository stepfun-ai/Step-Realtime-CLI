import { describe, it, expect } from "vitest";
import { buildDelegationViews } from "./delegation-view.js";
import type { AgentTeamState } from "./agent-team.js";
import type { BackgroundSubtaskView } from "../plugins/subagent-state.js";
import type { BackgroundCommandView } from "../plugins/background-tasks-types.js";

describe("buildDelegationViews", () => {
  it("returns empty array when all inputs are empty/null", () => {
    const result = buildDelegationViews({
      team: null,
      subtasks: [],
      backgroundCommands: [],
    });
    expect(result).toEqual([]);
  });

  it("maps teammates from AgentTeamState correctly", () => {
    const team: AgentTeamState = {
      version: 4,
      cursors: {},
      teammates: [
        {
          name: "alice",
          role: "researcher",
          lead: "lead-agent",
          status: "working",
          workspaceRoot: "/workspace",
          systemPrompt: "",
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T01:00:00.000Z",
          depth: 1,
          sessionId: "session-123",
          goalId: "goal-456",
          executionProfile: {
            workspaceMode: "shared",
            memoryMode: "session",
            priority: "delegated",
          },
          memory: { messages: [] } as any,
          toolRuntime: {} as any,
        },
      ],
      shutdownRequests: [],
      planRequests: [],
    };

    const result = buildDelegationViews({
      team,
      subtasks: [],
      backgroundCommands: [],
    });

    expect(result).toHaveLength(1);
    const view = result[0];
    expect(view.kind).toBe("teammate");
    if (view.kind !== "teammate") return;

    expect(view.id).toBe("teammate:alice");
    expect(view.name).toBe("alice");
    expect(view.role).toBe("researcher");
    expect(view.lead).toBe("lead-agent");
    expect(view.status).toBe("working");
    expect(view.workspaceRoot).toBe("/workspace");
    expect(view.sessionId).toBe("session-123");
    expect(view.goalId).toBe("goal-456");
    expect(view.canReply).toBe(true);
    expect(view.canInterrupt).toBe(true);
  });

  it("sets canReply=false for shutdown teammates and canInterrupt=false for idle teammates", () => {
    const team: AgentTeamState = {
      version: 4,
      cursors: {},
      teammates: [
        {
          name: "bob",
          role: "helper",
          lead: "lead",
          status: "shutdown",
          workspaceRoot: "/ws",
          systemPrompt: "",
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T01:00:00.000Z",
          depth: 1,
          memory: { messages: [] } as any,
          toolRuntime: {} as any,
        },
        {
          name: "carol",
          role: "helper",
          lead: "lead",
          status: "idle",
          workspaceRoot: "/ws",
          systemPrompt: "",
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T01:00:00.000Z",
          depth: 1,
          memory: { messages: [] } as any,
          toolRuntime: {} as any,
        },
      ],
      shutdownRequests: [],
      planRequests: [],
    };

    const result = buildDelegationViews({
      team,
      subtasks: [],
      backgroundCommands: [],
    });

    expect(result).toHaveLength(2);

    const bobView = result.find(
      (v) => v.kind === "teammate" && "name" in v && v.name === "bob",
    );
    const carolView = result.find(
      (v) => v.kind === "teammate" && "name" in v && v.name === "carol",
    );

    expect(bobView).toBeDefined();
    expect(carolView).toBeDefined();

    // Shutdown teammate: canReply=false, canInterrupt=false
    if (bobView && bobView.kind === "teammate") {
      expect(bobView.canReply).toBe(false);
      expect(bobView.canInterrupt).toBe(false);
    }
    // Idle teammate: canReply=true, canInterrupt=false
    if (carolView && carolView.kind === "teammate") {
      expect(carolView.canReply).toBe(true);
      expect(carolView.canInterrupt).toBe(false);
    }
  });

  it("maps subtasks from BackgroundSubtaskView correctly", () => {
    const subtask: BackgroundSubtaskView = {
      id: "task-1",
      label: "Build feature",
      alias: "feat",
      group: "group-a",
      status: "running",
      queueDepth: 2,
      workspaceRoot: "/project",
      executionProfile: {
        workspaceMode: "isolated",
        memoryMode: "fresh",
        priority: "background",
      },
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T01:00:00.000Z",
      activePrompt: "Do the thing",
      lastSummary: "Halfway done",
      lastError: undefined,
      artifact: {
        relativePath: "output.txt",
        absolutePath: "/project/output.txt",
      } as any,
      warnings: ["slow disk"],
    };

    const result = buildDelegationViews({
      team: null,
      subtasks: [subtask],
      backgroundCommands: [],
    });

    expect(result).toHaveLength(1);
    const view = result[0];
    expect(view.kind).toBe("subtask");
    if (view.kind !== "subtask") return;

    expect(view.id).toBe("task-1");
    expect(view.taskId).toBe("task-1");
    expect(view.alias).toBe("feat");
    expect(view.group).toBe("group-a");
    expect(view.label).toBe("Build feature");
    expect(view.status).toBe("running");
    expect(view.workspaceRoot).toBe("/project");
    expect(view.queueDepth).toBe(2);
    expect(view.lastSummary).toBe("Halfway done");
    expect(view.activePrompt).toBe("Do the thing");
    expect(view.artifactPath).toBe("output.txt");
    expect(view.warnings).toEqual(["slow disk"]);
    expect(view.canReply).toBe(true);
    expect(view.canInterrupt).toBe(true);
    expect(view.canWaitReady).toBe(true);
  });

  it("maps background commands from BackgroundCommandView correctly", () => {
    const bgCmd: BackgroundCommandView = {
      id: "cmd-1",
      status: "completed",
      command: "npm test",
      cwd: "/project",
      startedAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:05:00.000Z",
      exitCode: 0,
      timedOut: false,
      outputPreview: "All tests passed",
    };

    const result = buildDelegationViews({
      team: null,
      subtasks: [],
      backgroundCommands: [bgCmd],
    });

    expect(result).toHaveLength(1);
    const view = result[0];
    expect(view.kind).toBe("background_command");
    if (view.kind !== "background_command") return;

    expect(view.id).toBe("cmd-1");
    expect(view.status).toBe("completed");
    expect(view.command).toBe("npm test");
    expect(view.workspaceRoot).toBe("/project");
    expect(view.exitCode).toBe(0);
    expect(view.timedOut).toBe(false);
    expect(view.outputPreview).toBe("All tests passed");
    expect(view.canReply).toBe(false);
    expect(view.canInterrupt).toBe(false);
    expect(view.canWaitReady).toBe(false);

    // Completed with exit code 0: lastSummary should contain output preview
    expect(view.lastSummary).toBe("All tests passed");
    expect(view.lastError).toBeUndefined();
  });

  it("sets lastError for background commands with error status", () => {
    const bgCmd: BackgroundCommandView = {
      id: "cmd-2",
      status: "error",
      command: "bad-command",
      cwd: "/project",
      startedAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:01:00.000Z",
      exitCode: 1,
      outputPreview: "Error: something failed",
    };

    const result = buildDelegationViews({
      team: null,
      subtasks: [],
      backgroundCommands: [bgCmd],
    });

    expect(result).toHaveLength(1);
    const view = result[0];
    if (view.kind !== "background_command") return;

    expect(view.lastError).toBe("Error: something failed");
    expect(view.lastSummary).toBeUndefined();
  });

  it("combines teammates, subtasks, and background commands in one call", () => {
    const team: AgentTeamState = {
      version: 4,
      cursors: {},
      teammates: [
        {
          name: "dave",
          role: "tester",
          lead: "lead",
          status: "idle",
          workspaceRoot: "/ws",
          systemPrompt: "",
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
          depth: 1,
          memory: { messages: [] } as any,
          toolRuntime: {} as any,
        },
      ],
      shutdownRequests: [],
      planRequests: [],
    };

    const subtask: BackgroundSubtaskView = {
      id: "sub-1",
      label: "Sub task",
      status: "queued",
      queueDepth: 0,
      workspaceRoot: "/ws",
      executionProfile: {
        workspaceMode: "shared",
        memoryMode: "session",
        priority: "delegated",
      },
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      warnings: [],
    };

    const bgCmd: BackgroundCommandView = {
      id: "bg-1",
      status: "running",
      command: "sleep 10",
      cwd: "/ws",
      startedAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };

    const result = buildDelegationViews({
      team,
      subtasks: [subtask],
      backgroundCommands: [bgCmd],
    });

    expect(result).toHaveLength(3);
    expect(result.filter((v) => v.kind === "teammate")).toHaveLength(1);
    expect(result.filter((v) => v.kind === "subtask")).toHaveLength(1);
    expect(result.filter((v) => v.kind === "background_command")).toHaveLength(
      1,
    );
  });
});
