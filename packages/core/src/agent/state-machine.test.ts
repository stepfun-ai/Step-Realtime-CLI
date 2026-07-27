import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentStateMachine } from "./state-machine.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("./harness-context.js", () => ({
  getHarnessContext: vi.fn(() => undefined),
}));

vi.mock("../tools/security.js", () => ({
  getToolSecurityIssue: vi.fn(() => null),
}));

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

  it("rejects invalid transitions", () => {
    const sm = new AgentStateMachine();

    expect(() =>
      sm.transition({ state: "final_response", step: 1, toolCalls: 0 }),
    ).toThrow("Invalid state transition: prepare_context -> final_response");
  });

  it("accepts the AgentLoop state transition sequence", () => {
    const sm = new AgentStateMachine();
    const states = [
      "goal_start",
      "prepare_context",
      "before_model_request_hooks",
      "context_compaction",
      "model_request",
      "tool_execution",
      "apply_tool_results",
      "prepare_context",
      "context_compaction",
      "model_request",
      "final_response",
      "goal_complete",
    ] as const;

    expect(() => {
      for (const [step, state] of states.entries()) {
        sm.transition({ state, step, toolCalls: 0 });
      }
    }).not.toThrow();
  });

  it("accepts the AgentLoop failure completion sequence", () => {
    const sm = new AgentStateMachine();
    const states = [
      "goal_start",
      "prepare_context",
      "context_compaction",
      "model_request",
      "failed",
      "goal_complete",
    ] as const;

    expect(() => {
      for (const [step, state] of states.entries()) {
        sm.transition({ state, step, toolCalls: 0 });
      }
    }).not.toThrow();
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
