import { describe, it, expect } from "vitest";
import {
  createEmptyCheckpoint,
  cloneCheckpoint,
  normalizeCheckpoint,
  mergeCheckpoints,
  createCheckpointItem,
  renderCheckpointText,
} from "./conversation-memory-checkpoint.js";

describe("createEmptyCheckpoint", () => {
  it("returns checkpoint with all empty arrays", () => {
    const cp = createEmptyCheckpoint();
    expect(cp.version).toBe(1);
    expect(cp.objective).toEqual([]);
    expect(cp.hardConstraints).toEqual([]);
    expect(cp.verifiedFacts).toEqual([]);
    expect(cp.attemptedActions).toEqual([]);
    expect(cp.openIssues).toEqual([]);
    expect(cp.nextSteps).toEqual([]);
    expect(cp.relevantPriors).toEqual([]);
  });
});

describe("cloneCheckpoint", () => {
  it("deep-clones all sections", () => {
    const original = createEmptyCheckpoint();
    original.objective.push({ text: "goal", status: "still_active" });
    original.hardConstraints.push({
      id: "hc-1",
      text: "must pass tests",
      confidence: "high",
      evidenceRefs: [],
    });

    const cloned = cloneCheckpoint(original);
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect(cloned.objective).not.toBe(original.objective);
    expect(cloned.hardConstraints[0]).not.toBe(original.hardConstraints[0]);
  });
});

describe("normalizeCheckpoint", () => {
  it("returns null for null or undefined", () => {
    expect(normalizeCheckpoint(null)).toBeNull();
    expect(normalizeCheckpoint(undefined)).toBeNull();
  });

  it("normalizes a valid checkpoint with deduplication", () => {
    const cp = normalizeCheckpoint({
      version: 1,
      objective: [
        { text: "build feature", status: "still_active" },
        { text: "build feature", status: "resolved" },
      ],
      hardConstraints: [],
      verifiedFacts: [],
      attemptedActions: [],
      openIssues: [],
      nextSteps: [],
      relevantPriors: [],
    });

    expect(cp).not.toBeNull();
    expect(cp!.objective).toHaveLength(1);
    expect(cp!.objective[0]!.status).toBe("resolved");
  });

  it("limits objective entries to 4", () => {
    const cp = normalizeCheckpoint({
      version: 1,
      objective: Array.from({ length: 6 }, (_, i) => ({
        text: `goal-${i}`,
        status: "still_active" as const,
      })),
      hardConstraints: [],
      verifiedFacts: [],
      attemptedActions: [],
      openIssues: [],
      nextSteps: [],
      relevantPriors: [],
    });

    expect(cp!.objective.length).toBeLessThanOrEqual(4);
  });

  it("normalizes unknown confidence to medium", () => {
    const cp = normalizeCheckpoint({
      version: 1,
      objective: [],
      hardConstraints: [
        {
          id: "hc-1",
          text: "constraint",
          confidence: "unknown" as never,
          evidenceRefs: [],
        },
      ],
      verifiedFacts: [],
      attemptedActions: [],
      openIssues: [],
      nextSteps: [],
      relevantPriors: [],
    });

    expect(cp!.hardConstraints[0]!.confidence).toBe("medium");
  });
});

describe("createCheckpointItem", () => {
  it("creates item with generated id and normalized text", () => {
    const item = createCheckpointItem(
      "verifiedFacts",
      "  tests pass  ",
      "high",
      [],
    );
    expect(item.id).toContain("verifiedFacts:");
    expect(item.text).toBe("tests pass");
    expect(item.confidence).toBe("high");
    expect(item.evidenceRefs).toEqual([]);
  });
});

describe("mergeCheckpoints", () => {
  it("merges update into base", () => {
    const base = createEmptyCheckpoint();
    base.objective.push({ text: "original goal", status: "still_active" });
    base.hardConstraints.push({
      id: "hc-1",
      text: "must compile",
      confidence: "high",
      evidenceRefs: [],
    });

    const merged = mergeCheckpoints(base, {
      verifiedFacts: [
        {
          id: "vf-1",
          text: "fact one",
          confidence: "medium",
          evidenceRefs: [],
        },
      ],
    });

    expect(merged.objective).toHaveLength(1);
    expect(merged.hardConstraints).toHaveLength(1);
    expect(merged.verifiedFacts).toHaveLength(1);
  });

  it("deduplicates items with same text", () => {
    const base = createEmptyCheckpoint();
    base.verifiedFacts.push({
      id: "vf-1",
      text: "duplicate fact",
      confidence: "low",
      evidenceRefs: [],
    });

    const merged = mergeCheckpoints(base, {
      verifiedFacts: [
        {
          id: "vf-2",
          text: "duplicate fact",
          confidence: "high",
          evidenceRefs: [],
        },
      ],
    });

    expect(merged.verifiedFacts).toHaveLength(1);
    expect(merged.verifiedFacts[0]!.confidence).toBe("high");
  });
});

describe("renderCheckpointText", () => {
  it("renders non-empty checkpoint as markdown sections", () => {
    const cp = createEmptyCheckpoint();
    cp.objective.push({ text: "ship feature", status: "still_active" });
    cp.verifiedFacts.push({
      id: "vf-1",
      text: "tests pass",
      confidence: "high",
      evidenceRefs: [],
    });

    const text = renderCheckpointText(cp);
    expect(text).toContain("ship feature");
    expect(text).toContain("tests pass");
  });

  it("returns empty string for empty checkpoint", () => {
    const text = renderCheckpointText(createEmptyCheckpoint());
    expect(text).toBe("");
  });
});
