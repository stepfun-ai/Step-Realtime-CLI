import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentStateMachine } from "../agent/state-machine.js";
import { ToolPolicy } from "../policy/tool-policy.js";
import type { ToolSpec, ToolCallInspection } from "@step-cli/protocol";
import { buildDelegationViews } from "../agent/delegation-view.js";
import type { AgentTeamState } from "../agent/agent-team.js";
import type { BackgroundSubtaskView } from "../plugins/subagent-state.js";
import type { BackgroundCommandView } from "../plugins/background-tasks-types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../agent/harness-context.js", () => ({
  getHarnessContext: vi.fn(() => undefined),
}));

vi.mock("../tools/security.js", () => ({
  getToolSecurityIssue: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolSpec(overrides: {
  name: string;
  risk: "read" | "write" | "execute" | "meta";
  defaultMode?: "allow" | "confirm" | "deny";
}): ToolSpec {
  return {
    definition: {
      type: "function",
      function: { name: overrides.name, parameters: {} },
    },
    security: {
      risk: overrides.risk,
      defaultMode: overrides.defaultMode,
    },
    parseArgs: vi.fn(),
    execute: vi.fn(),
  } as unknown as ToolSpec;
}

// ===========================================================================
// 1. AgentStateMachine
// ===========================================================================

describe("AgentStateMachine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initial state is prepare_context", () => {
    const sm = new AgentStateMachine();
    expect(sm.getCurrentState()).toBe("prepare_context");
  });

  it("performs a single transition and returns the snapshot", () => {
    const sm = new AgentStateMachine();
    const snapshot = sm.transition({
      state: "model_request",
      step: 1,
      toolCalls: 0,
      note: "first step",
    });

    expect(snapshot.state).toBe("model_request");
    expect(snapshot.step).toBe(1);
    expect(snapshot.toolCalls).toBe(0);
    expect(snapshot.note).toBe("first step");
    expect(typeof snapshot.at).toBe("string");
    expect(snapshot.at.length).toBeGreaterThan(0);

    // Harness context is mocked to return undefined, so these should be undefined
    expect(snapshot.harnessId).toBeUndefined();
    expect(snapshot.sessionId).toBeUndefined();

    // currentState should reflect the transition
    expect(sm.getCurrentState()).toBe("model_request");

    // Timeline should have exactly 1 entry
    expect(sm.getTimeline()).toHaveLength(1);
  });

  it("accumulates multiple transitions in the timeline", () => {
    const sm = new AgentStateMachine();

    sm.transition({ state: "prepare_context", step: 1, toolCalls: 0 });
    sm.transition({ state: "model_request", step: 2, toolCalls: 0 });
    sm.transition({ state: "tool_execution", step: 3, toolCalls: 1 });

    expect(sm.getCurrentState()).toBe("tool_execution");

    const timeline = sm.getTimeline();
    expect(timeline).toHaveLength(3);
    expect(timeline[0].state).toBe("prepare_context");
    expect(timeline[1].state).toBe("model_request");
    expect(timeline[2].state).toBe("tool_execution");
  });

  it("trims timeline to 200 entries when exceeding the cap", () => {
    const sm = new AgentStateMachine();

    // Push 201 entries
    for (let i = 0; i < 201; i++) {
      sm.transition({ state: "model_request", step: i, toolCalls: 0 });
    }

    const timeline = sm.getTimeline();
    expect(timeline).toHaveLength(200);

    // The oldest entry should be dropped: first kept step is 1 (step 0 was dropped)
    expect(timeline[0].step).toBe(1);
    expect(timeline[timeline.length - 1].step).toBe(200);
  });

  it("trims timeline beyond 200 entries", () => {
    const sm = new AgentStateMachine();

    // Push 250 entries
    for (let i = 0; i < 250; i++) {
      sm.transition({ state: "model_request", step: i, toolCalls: 0 });
    }

    const timeline = sm.getTimeline();
    expect(timeline).toHaveLength(200);
    expect(timeline[0].step).toBe(50);
    expect(timeline[timeline.length - 1].step).toBe(249);
  });

  it("getTimeline returns a copy so mutations do not affect internal state", () => {
    const sm = new AgentStateMachine();
    sm.transition({ state: "model_request", step: 1, toolCalls: 0 });

    const timeline = sm.getTimeline();
    timeline.push({
      state: "goal_complete",
      step: 99,
      toolCalls: 0,
      at: "fake",
    });

    // Internal timeline should still have 1 entry
    expect(sm.getTimeline()).toHaveLength(1);
  });
});

// ===========================================================================
// 2. ToolPolicy
// ===========================================================================

describe("ToolPolicy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -- Constructor & getters --

  it("exposes mode and nonInteractiveBehavior from constructor config", () => {
    const policy = new ToolPolicy({
      mode: "confirm",
      nonInteractiveApproval: "deny",
    });
    expect(policy.getMode()).toBe("confirm");
    expect(policy.getNonInteractiveBehavior()).toBe("deny");
  });

  // -- setMode / getMode --

  it("reflects mode changes via setMode", () => {
    const policy = new ToolPolicy({
      mode: "confirm",
      nonInteractiveApproval: "deny",
    });
    policy.setMode("auto");
    expect(policy.getMode()).toBe("auto");
    policy.setMode("strict");
    expect(policy.getMode()).toBe("strict");
  });

  // -- Override management --

  it("manages overrides: set, clear, get copy, exportConfig round-trip", () => {
    const policy = new ToolPolicy({
      mode: "confirm",
      nonInteractiveApproval: "deny",
      overrides: { bash: "allow" },
    });

    // getOverrides returns a copy
    const overrides = policy.getOverrides();
    expect(overrides).toEqual({ bash: "allow" });
    overrides["read_file"] = "deny";
    expect(policy.getOverrides()).toEqual({ bash: "allow" });

    // setOverride adds new
    policy.setOverride("read_file", "deny");
    expect(policy.getOverrides()).toEqual({ bash: "allow", read_file: "deny" });

    // clearOverride removes
    policy.clearOverride("bash");
    expect(policy.getOverrides()).toEqual({ read_file: "deny" });

    // exportConfig round-trip
    const exported = policy.exportConfig();
    expect(exported).toEqual({
      mode: "confirm",
      nonInteractiveApproval: "deny",
      overrides: { read_file: "deny" },
    });
  });

  it("copies overrides in constructor so mutating the original config does not affect the policy", () => {
    const originalOverrides: Record<string, "allow" | "confirm" | "deny"> = {
      bash: "allow",
    };
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
      overrides: originalOverrides,
    });

    // Mutate the original
    originalOverrides["read_file"] = "deny";
    expect(policy.getOverrides()).toEqual({ bash: "allow" });
  });

  // -- evaluate: unregistered tool --

  it("returns deny for unregistered tools (spec=undefined)", () => {
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const decision = policy.evaluate("unknown_tool", "{}", undefined);
    expect(decision.mode).toBe("deny");
    expect(decision.reason).toContain("not registered");
  });

  // -- evaluate: security issue --

  it("returns deny when getToolSecurityIssue reports a problem", async () => {
    const { getToolSecurityIssue } = await import("../tools/security.js");
    vi.mocked(getToolSecurityIssue).mockReturnValueOnce(
      "dangerous tool detected",
    );

    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const spec = makeToolSpec({ name: "danger", risk: "write" });
    const decision = policy.evaluate("danger", "{}", spec);
    expect(decision.mode).toBe("deny");
    expect(decision.reason).toBe("dangerous tool detected");
  });

  // -- evaluate: dangerous command patterns --

  it("denies dangerous command: rm -rf /", () => {
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const inspection: ToolCallInspection = { command: "rm -rf /" };
    const decision = policy.evaluate("bash", "{}", spec, inspection);
    expect(decision.mode).toBe("deny");
    expect(decision.reason).toContain("dangerous command");
  });

  it("denies dangerous command: shutdown", () => {
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const inspection: ToolCallInspection = { command: "sudo shutdown now" };
    const decision = policy.evaluate("bash", "{}", spec, inspection);
    expect(decision.mode).toBe("deny");
  });

  it("denies dangerous command: reboot", () => {
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const inspection: ToolCallInspection = { command: "reboot" };
    const decision = policy.evaluate("bash", "{}", spec, inspection);
    expect(decision.mode).toBe("deny");
  });

  it("denies dangerous command: mkfs", () => {
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const inspection: ToolCallInspection = { command: "mkfs.ext4 /dev/sda1" };
    const decision = policy.evaluate("bash", "{}", spec, inspection);
    expect(decision.mode).toBe("deny");
  });

  it("denies dangerous command: dd if=", () => {
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const inspection: ToolCallInspection = {
      command: "dd if=/dev/zero of=/dev/sda",
    };
    const decision = policy.evaluate("bash", "{}", spec, inspection);
    expect(decision.mode).toBe("deny");
  });

  // -- Per-tool override precedence --

  it("per-tool override takes precedence over mode-based decision", () => {
    const policy = new ToolPolicy({
      mode: "strict",
      nonInteractiveApproval: "deny",
      overrides: { bash: "allow" },
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const decision = policy.evaluate("bash", "{}", spec);
    expect(decision.mode).toBe("allow");
    expect(decision.reason).toContain("override");
  });

  // -- "auto" mode --

  it('"auto" mode allows all tools after security check passes', () => {
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const decision = policy.evaluate("bash", "{}", spec);
    expect(decision.mode).toBe("allow");
    expect(decision.reason).toContain("Auto-approval");
  });

  // -- "strict" mode --

  it('"strict" mode denies write tools', () => {
    const policy = new ToolPolicy({
      mode: "strict",
      nonInteractiveApproval: "deny",
    });
    const spec = makeToolSpec({ name: "write_file", risk: "write" });
    const decision = policy.evaluate("write_file", "{}", spec);
    expect(decision.mode).toBe("deny");
    expect(decision.reason).toContain("Strict");
  });

  it('"strict" mode denies execute tools', () => {
    const policy = new ToolPolicy({
      mode: "strict",
      nonInteractiveApproval: "deny",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const decision = policy.evaluate("bash", "{}", spec);
    expect(decision.mode).toBe("deny");
  });

  it('"strict" mode allows read tools', () => {
    const policy = new ToolPolicy({
      mode: "strict",
      nonInteractiveApproval: "deny",
    });
    const spec = makeToolSpec({ name: "read_file", risk: "read" });
    const decision = policy.evaluate("read_file", "{}", spec);
    expect(decision.mode).toBe("allow");
  });

  it('"strict" mode allows meta tools', () => {
    const policy = new ToolPolicy({
      mode: "strict",
      nonInteractiveApproval: "deny",
    });
    const spec = makeToolSpec({ name: "list_tools", risk: "meta" });
    const decision = policy.evaluate("list_tools", "{}", spec);
    expect(decision.mode).toBe("allow");
  });

  // -- "confirm" mode --

  it('"confirm" mode uses tool defaultMode when set', () => {
    const policy = new ToolPolicy({
      mode: "confirm",
      nonInteractiveApproval: "deny",
    });
    const spec = makeToolSpec({
      name: "safe_read",
      risk: "read",
      defaultMode: "allow",
    });
    const decision = policy.evaluate("safe_read", "{}", spec);
    expect(decision.mode).toBe("allow");
    expect(decision.reason).toContain("default policy");
  });

  it('"confirm" mode confirms write tools when no defaultMode set', () => {
    const policy = new ToolPolicy({
      mode: "confirm",
      nonInteractiveApproval: "deny",
    });
    const spec = makeToolSpec({ name: "write_file", risk: "write" });
    const decision = policy.evaluate("write_file", "{}", spec);
    expect(decision.mode).toBe("confirm");
  });

  it('"confirm" mode confirms execute tools when no defaultMode set', () => {
    const policy = new ToolPolicy({
      mode: "confirm",
      nonInteractiveApproval: "deny",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const decision = policy.evaluate("bash", "{}", spec);
    expect(decision.mode).toBe("confirm");
  });

  it('"confirm" mode allows read tools when no defaultMode set', () => {
    const policy = new ToolPolicy({
      mode: "confirm",
      nonInteractiveApproval: "deny",
    });
    const spec = makeToolSpec({ name: "read_file", risk: "read" });
    const decision = policy.evaluate("read_file", "{}", spec);
    expect(decision.mode).toBe("allow");
  });

  it('"confirm" mode allows meta tools when no defaultMode set', () => {
    const policy = new ToolPolicy({
      mode: "confirm",
      nonInteractiveApproval: "deny",
    });
    const spec = makeToolSpec({ name: "list_tools", risk: "meta" });
    const decision = policy.evaluate("list_tools", "{}", spec);
    expect(decision.mode).toBe("allow");
  });
});

// ===========================================================================
// 3. buildDelegationViews (delegation-view)
// ===========================================================================

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
