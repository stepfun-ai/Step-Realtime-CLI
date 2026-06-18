import { describe, it, expect } from "vitest";
import type { StepCliActiveGoal } from "@step-cli/protocol";
import { formatGoalSummary } from "./goal-status.js";

describe("formatGoalSummary", () => {
  it("returns Goal: none for null or undefined", () => {
    expect(formatGoalSummary(null)).toBe("Goal: none");
    expect(formatGoalSummary(undefined)).toBe("Goal: none");
  });

  it("formats active goal with status, iteration, runs, and text", () => {
    const goal: StepCliActiveGoal = {
      id: "goal-1",
      sessionId: "session-1",
      text: "Ship the feature",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      iteration: 3,
      counters: { consecutiveFailures: 0, totalRuns: 5, totalFailures: 0 },
    };

    expect(formatGoalSummary(goal)).toBe(
      "Goal: active | iteration 3 | runs 5 | Ship the feature",
    );
  });

  it("includes the first available reason field", () => {
    const goal: StepCliActiveGoal = {
      id: "goal-2",
      sessionId: "session-1",
      text: "Retry later",
      status: "paused",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      iteration: 1,
      waitingReason: "blocked on review",
      counters: { consecutiveFailures: 0, totalRuns: 1, totalFailures: 0 },
    };

    expect(formatGoalSummary(goal)).toBe(
      "Goal: paused | iteration 1 | runs 1 | reason: blocked on review | Retry later",
    );
  });
});
