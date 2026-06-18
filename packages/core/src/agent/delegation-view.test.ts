import { describe, it, expect } from "vitest";
import {
  buildDelegationViews,
  buildTeammatesOverlaySnapshot,
  type DelegationView,
} from "./delegation-view.js";
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

  it("shortens long background command labels and falls back to command id", () => {
    const longCommand = "x".repeat(80);
    const result = buildDelegationViews({
      team: null,
      subtasks: [],
      backgroundCommands: [
        {
          id: "cmd-long",
          status: "running",
          command: longCommand,
          cwd: "/ws",
          startedAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
        {
          id: "cmd-empty",
          status: "running",
          command: "   ",
          cwd: "/ws",
          startedAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    });

    const longView = result.find((v) => v.id === "cmd-long");
    const emptyView = result.find((v) => v.id === "cmd-empty");
    expect(longView?.label.endsWith("...")).toBe(true);
    expect(longView?.label.length).toBe(52);
    // Blank command falls back to `command <id>` label
    expect(emptyView?.label).toBe("command cmd-empty");
  });

  it("derives lastSummary from status when no output preview (completed)", () => {
    const result = buildDelegationViews({
      team: null,
      subtasks: [],
      backgroundCommands: [
        {
          id: "cmd-c",
          status: "completed",
          command: "make",
          cwd: "/ws",
          startedAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
          exitCode: 0,
        },
      ],
    });
    const view = result[0];
    if (view?.kind !== "background_command") return;
    expect(view.lastSummary).toBe("completed (exit 0)");
  });

  it("uses status message for lastError when timeout has no preview", () => {
    const result = buildDelegationViews({
      team: null,
      subtasks: [],
      backgroundCommands: [
        {
          id: "cmd-t",
          status: "timeout",
          command: "sleep 999",
          cwd: "/ws",
          startedAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
          timedOut: true,
        },
      ],
    });
    const view = result[0];
    if (view?.kind !== "background_command") return;
    expect(view.lastError).toBe("timed out");
    expect(view.lastSummary).toBeUndefined();
  });

  it("marks lost commands as a problem with status message", () => {
    const result = buildDelegationViews({
      team: null,
      subtasks: [],
      backgroundCommands: [
        {
          id: "cmd-l",
          status: "lost",
          command: "ghost",
          cwd: "/ws",
          startedAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    });
    const view = result[0];
    if (view?.kind !== "background_command") return;
    expect(view.lastError).toBe("restored after a previously running command");
  });

  it("sets failed (exit N) status message for error without preview", () => {
    const result = buildDelegationViews({
      team: null,
      subtasks: [],
      backgroundCommands: [
        {
          id: "cmd-e",
          status: "error",
          command: "boom",
          cwd: "/ws",
          startedAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
          exitCode: 7,
        },
      ],
    });
    const view = result[0];
    if (view?.kind !== "background_command") return;
    expect(view.lastError).toBe("failed (exit 7)");
  });

  it("computes subtask interrupt/wait affordances from queue depth and prompt", () => {
    const subtask: BackgroundSubtaskView = {
      id: "idle-sub",
      label: "Idle subtask",
      status: "completed",
      queueDepth: 0,
      workspaceRoot: "/ws",
      executionProfile: {
        workspaceMode: "shared",
        memoryMode: "session",
        priority: "delegated",
      },
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      warnings: undefined as never,
    };

    const result = buildDelegationViews({
      team: null,
      subtasks: [subtask],
      backgroundCommands: [],
    });
    const view = result[0];
    if (view?.kind !== "subtask") return;
    // Completed, no queue, no prompt -> cannot interrupt/wait
    expect(view.canInterrupt).toBe(false);
    expect(view.canWaitReady).toBe(false);
    // Missing warnings normalized to empty array
    expect(view.warnings).toEqual([]);
  });
});

describe("buildTeammatesOverlaySnapshot", () => {
  it("reports unavailable when team is null", () => {
    const snapshot = buildTeammatesOverlaySnapshot({
      team: null,
      delegations: [],
    });
    expect(snapshot.unavailable).toEqual([
      "persistent teammate orchestration is unavailable in this session",
    ]);
    expect(snapshot.emptyState).toBeNull();
    expect(snapshot.teammates).toEqual([]);
  });

  it("reports empty state when team exists but has no delegations", () => {
    const team = makeTeam([]);
    const snapshot = buildTeammatesOverlaySnapshot({
      team,
      delegations: [],
    });
    expect(snapshot.unavailable).toEqual([]);
    expect(snapshot.emptyState).toBe("no persistent teammates yet");
  });

  it("summarizes teammates by status and formats fields", () => {
    const team = makeTeam([]);
    const delegations = buildDelegationViews({
      team: makeTeam([
        teammate("working-one", "working"),
        teammate("idle-one", "idle"),
        teammate("error-one", "error"),
        teammate("shutdown-one", "shutdown"),
      ]),
      subtasks: [],
      backgroundCommands: [],
    });

    const snapshot = buildTeammatesOverlaySnapshot({ team, delegations });
    expect(snapshot.summary.teammates).toBe(4);
    expect(snapshot.summary.working).toBe(1);
    expect(snapshot.summary.idle).toBe(1);
    expect(snapshot.summary.error).toBe(1);
    expect(snapshot.summary.shutdown).toBe(1);
    expect(snapshot.teammates).toHaveLength(4);
    // working teammate exposes interrupt action
    const working = snapshot.teammates.find((t) => t.name === "working-one");
    expect(working?.actions.interrupt).toBe(true);
    expect(working?.actions.reply).toBe(true);
  });

  it("formats unknown session/goal/timestamp values", () => {
    const delegations: DelegationView[] = [
      {
        kind: "teammate",
        id: "teammate:nameless",
        name: "nameless",
        label: "nameless",
        role: "r",
        lead: "l",
        status: "idle",
        workspaceRoot: "/ws",
        updatedAt: "",
        sessionId: undefined,
        goalId: undefined,
        canReply: true,
        canInterrupt: false,
      },
    ];
    const snapshot = buildTeammatesOverlaySnapshot({
      team: makeTeam([]),
      delegations,
    });
    const entry = snapshot.teammates[0]!;
    expect(entry.session).toBe("unknown");
    expect(entry.goal).toBe("unknown");
    expect(entry.updated).toBe("unknown");
  });

  it("truncates long goal ids and shortens session ids", () => {
    const longGoal = "g".repeat(50);
    const delegations: DelegationView[] = [
      {
        kind: "teammate",
        id: "teammate:x",
        name: "x",
        label: "x",
        role: "r",
        lead: "l",
        status: "idle",
        workspaceRoot: "/ws",
        updatedAt: "2025-01-01T00:00:00.000Z",
        sessionId: "abcdef0123456789",
        goalId: longGoal,
        canReply: true,
        canInterrupt: false,
      },
    ];
    const snapshot = buildTeammatesOverlaySnapshot({
      team: makeTeam([]),
      delegations,
    });
    const entry = snapshot.teammates[0]!;
    expect(entry.session).toBe("abcdef01");
    expect(entry.goal).toContain("…");
    expect(entry.goal.length).toBeLessThan(longGoal.length);
    // ISO timestamp normalized to "YYYY-MM-DD HH:MM:SSZ"
    expect(entry.updated).toBe("2025-01-01 00:00:00Z");
  });

  it("formats home-directory workspace as ~", () => {
    const home = process.env.HOME ?? "";
    const delegations: DelegationView[] = [
      {
        kind: "teammate",
        id: "teammate:h",
        name: "h",
        label: "h",
        role: "r",
        lead: "l",
        status: "idle",
        workspaceRoot: home ? `${home}/projects/app` : "/ws",
        updatedAt: "2025-01-01T00:00:00.000Z",
        canReply: true,
        canInterrupt: false,
      },
    ];
    const snapshot = buildTeammatesOverlaySnapshot({
      team: makeTeam([]),
      delegations,
    });
    if (home) {
      expect(snapshot.teammates[0]!.workspace).toBe("~/projects/app");
    } else {
      expect(snapshot.teammates[0]!.workspace).toBe("/ws");
    }
  });

  it("keeps invalid timestamp string verbatim", () => {
    const delegations: DelegationView[] = [
      {
        kind: "teammate",
        id: "teammate:bad",
        name: "bad",
        label: "bad",
        role: "r",
        lead: "l",
        status: "idle",
        workspaceRoot: "/ws",
        updatedAt: "not-a-date",
        canReply: true,
        canInterrupt: false,
      },
    ];
    const snapshot = buildTeammatesOverlaySnapshot({
      team: makeTeam([]),
      delegations,
    });
    expect(snapshot.teammates[0]!.updated).toBe("not-a-date");
  });

  it("maps subtask and background command overlay entries with summaries", () => {
    const delegations = buildDelegationViews({
      team: makeTeam([]),
      subtasks: [
        {
          id: "sub-x",
          label: "Subtask X",
          alias: "sx",
          group: "grp",
          status: "running",
          queueDepth: 3,
          workspaceRoot: "/ws",
          executionProfile: {
            workspaceMode: "isolated",
            memoryMode: "fresh",
            priority: "background",
          },
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
          activePrompt: "do   stuff\nnow",
          lastSummary: "partial",
          lastError: "",
          artifact: { relativePath: "a.txt" } as never,
          warnings: ["  warn  one ", "   "],
        },
      ],
      backgroundCommands: [
        {
          id: "bg-x",
          status: "running",
          command: "echo hi",
          cwd: "/ws",
          startedAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
          outputPreview: "hi   there",
        },
      ],
    });

    const snapshot = buildTeammatesOverlaySnapshot({
      team: makeTeam([]),
      delegations,
    });

    expect(snapshot.summary.subtasks).toBe(1);
    expect(snapshot.summary.runningSubtasks).toBe(1);
    expect(snapshot.summary.backgroundCommands).toBe(1);
    expect(snapshot.summary.runningBackgroundCommands).toBe(1);
    expect(snapshot.summary.backgroundTotal).toBe(2);

    const sub = snapshot.subtasks[0]!;
    expect(sub.alias).toBe("sx");
    expect(sub.group).toBe("grp");
    expect(sub.queue).toBe(3);
    // Whitespace collapsed in inline normalization
    expect(sub.active).toBe("do stuff now");
    expect(sub.artifact).toBe("a.txt");
    // Blank warning filtered out, valid one normalized
    expect(sub.warnings).toEqual(["warn one"]);
    expect(sub.kind).toBe("background subtask");

    const bg = snapshot.backgroundCommands[0]!;
    expect(bg.command).toBe("echo hi");
    expect(bg.summary).toBe("hi there");
    expect(bg.kind).toBe("background command");
  });

  it("includes only pending plan and shutdown protocol requests", () => {
    const team = makeTeam([]);
    team.planRequests = [
      protocolRequest("p1", "pending"),
      protocolRequest("p2", "approved"),
    ];
    team.shutdownRequests = [
      protocolRequest("s1", "pending"),
      protocolRequest("s2", "rejected"),
    ];

    const snapshot = buildTeammatesOverlaySnapshot({
      team,
      delegations: [],
    });

    expect(snapshot.summary.planRequests).toBe(1);
    expect(snapshot.summary.shutdownRequests).toBe(1);
    expect(snapshot.planRequests).toHaveLength(1);
    expect(snapshot.planRequests[0]!.requestId).toBe("p1");
    expect(snapshot.shutdownRequests).toHaveLength(1);
    expect(snapshot.shutdownRequests[0]!.requestId).toBe("s1");
    expect(snapshot.shutdownRequests[0]!.updated).toBe("2025-01-01 00:00:00Z");
  });
});

function makeTeam(teammates: AgentTeamState["teammates"]): AgentTeamState {
  return {
    version: 4,
    cursors: {},
    teammates,
    shutdownRequests: [],
    planRequests: [],
  };
}

function teammate(
  name: string,
  status: string,
): AgentTeamState["teammates"][number] {
  return {
    name,
    role: "role",
    lead: "lead",
    status: status as never,
    workspaceRoot: "/ws",
    systemPrompt: "",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    depth: 1,
    memory: { messages: [] } as never,
    toolRuntime: {} as never,
  };
}

function protocolRequest(requestId: string, status: string) {
  return {
    requestId,
    kind: "plan_approval" as const,
    from: "alice",
    to: "bob",
    status: status as "pending" | "approved" | "rejected",
    content: "please review",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}
