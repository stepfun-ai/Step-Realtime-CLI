import { describe, it, expect } from "vitest";
import {
  applyVerifierCompletionGate,
  cloneStepCliVerifierVerdict,
  isStepCliVerifierVerdict,
} from "./verifier.js";
import {
  resolveStorageLayout,
  type StepCliResolvedStorageLayout,
} from "./storage/layout.js";

function createLayout(rootDir = "/root"): StepCliResolvedStorageLayout {
  return resolveStorageLayout(rootDir, {
    workspaceTrustFile: "workspace-trust.json",
    teamInboxDir: "team/inbox",
    themesDir: "themes",
    sessionAssetsDir: "assets",
    sessionProgressDir: "progress",
    sessionProgressFile: "progress.md",
    sessionArtifactsDir: "artifacts",
    sessionTranscriptsDir: "transcripts",
    sessionTeamInboxDir: "team/inbox",
    sessionTraceDir: "trace",
  });
}

describe("cloneStepCliVerifierVerdict", () => {
  it("returns undefined for undefined input", () => {
    expect(cloneStepCliVerifierVerdict(undefined)).toBeUndefined();
  });

  it("deep-clones a complete verdict", () => {
    const original = {
      verdict: "PASS" as const,
      summary: "All checks passed",
      evidencePath: "/tmp/evidence.json",
      tracePath: "/tmp/trace.json",
      environmentLimits: ["limit1"],
    };
    const cloned = cloneStepCliVerifierVerdict(original);
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect(cloned!.environmentLimits).not.toBe(original.environmentLimits);
  });

  it("omits optional fields when not present", () => {
    const cloned = cloneStepCliVerifierVerdict({
      verdict: "FAIL",
      summary: "Failed",
    });
    expect(cloned).toEqual({ verdict: "FAIL", summary: "Failed" });
    expect(cloned!.evidencePath).toBeUndefined();
  });
});

describe("isStepCliVerifierVerdict", () => {
  it("returns true for valid PASS verdict", () => {
    expect(isStepCliVerifierVerdict({ verdict: "PASS", summary: "ok" })).toBe(
      true,
    );
  });

  it("returns true for valid FAIL verdict", () => {
    expect(isStepCliVerifierVerdict({ verdict: "FAIL", summary: "nope" })).toBe(
      true,
    );
  });

  it("returns true for valid PARTIAL verdict", () => {
    expect(
      isStepCliVerifierVerdict({ verdict: "PARTIAL", summary: "half" }),
    ).toBe(true);
  });

  it("returns false for invalid verdict value", () => {
    expect(isStepCliVerifierVerdict({ verdict: "UNKNOWN", summary: "?" })).toBe(
      false,
    );
  });

  it("returns false for non-object", () => {
    expect(isStepCliVerifierVerdict(null)).toBe(false);
    expect(isStepCliVerifierVerdict("string")).toBe(false);
  });

  it("returns false for missing summary", () => {
    expect(isStepCliVerifierVerdict({ verdict: "PASS" })).toBe(false);
  });

  it("returns false for arrays", () => {
    expect(isStepCliVerifierVerdict([])).toBe(false);
    expect(isStepCliVerifierVerdict([{ verdict: "PASS" }])).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isStepCliVerifierVerdict(undefined)).toBe(false);
  });

  it("returns false when summary is not a string", () => {
    expect(isStepCliVerifierVerdict({ verdict: "PASS", summary: 42 })).toBe(
      false,
    );
  });

  it("returns false when evidencePath is the wrong type", () => {
    expect(
      isStepCliVerifierVerdict({
        verdict: "PASS",
        summary: "ok",
        evidencePath: 123,
      }),
    ).toBe(false);
  });

  it("returns false when tracePath is the wrong type", () => {
    expect(
      isStepCliVerifierVerdict({
        verdict: "PASS",
        summary: "ok",
        tracePath: {},
      }),
    ).toBe(false);
  });

  it("accepts undefined optional path fields", () => {
    expect(
      isStepCliVerifierVerdict({
        verdict: "PASS",
        summary: "ok",
        evidencePath: undefined,
        tracePath: undefined,
      }),
    ).toBe(true);
  });

  it("returns false when environmentLimits is not an array", () => {
    expect(
      isStepCliVerifierVerdict({
        verdict: "FAIL",
        summary: "nope",
        environmentLimits: "limit",
      }),
    ).toBe(false);
  });

  it("returns false when environmentLimits contains non-strings", () => {
    expect(
      isStepCliVerifierVerdict({
        verdict: "FAIL",
        summary: "nope",
        environmentLimits: ["ok", 7],
      }),
    ).toBe(false);
  });

  it("accepts a valid environmentLimits array", () => {
    expect(
      isStepCliVerifierVerdict({
        verdict: "PARTIAL",
        summary: "half",
        environmentLimits: ["a", "b"],
      }),
    ).toBe(true);
  });
});

describe("applyVerifierCompletionGate", () => {
  it("returns a clone of an explicitly supplied verifier verdict", () => {
    const verifier = {
      verdict: "PASS" as const,
      summary: "done",
      environmentLimits: ["x"],
    };
    const result = applyVerifierCompletionGate({
      result: { steps: 3, toolCalls: 2 },
      sessionId: "s1",
      storageLayout: createLayout(),
      sessionTraceEnabled: true,
      verifier,
    });
    expect(result).toEqual(verifier);
    expect(result).not.toBe(verifier);
    expect(result!.environmentLimits).not.toBe(verifier.environmentLimits);
  });

  it("returns undefined for a trivial turn with no verifier", () => {
    const result = applyVerifierCompletionGate({
      result: { steps: 0, toolCalls: 0 },
      sessionId: "s1",
      storageLayout: createLayout(),
      sessionTraceEnabled: true,
    });
    expect(result).toBeUndefined();
  });

  it("produces a PARTIAL verdict with trace path when tracing is enabled", () => {
    const result = applyVerifierCompletionGate({
      result: { steps: 2, toolCalls: 1 },
      sessionId: "session-x",
      storageLayout: createLayout(),
      sessionTraceEnabled: true,
    });
    expect(result?.verdict).toBe("PARTIAL");
    expect(result?.summary).toMatch(/Verification pending/);
    expect(result?.evidencePath).toBeDefined();
    expect(result?.tracePath).toBeDefined();
    expect(result?.environmentLimits).toBeUndefined();
    // Relative to the storage root.
    expect(result?.evidencePath).not.toMatch(/^\//);
  });

  it("produces a PARTIAL verdict with environment limits when tracing is disabled", () => {
    const result = applyVerifierCompletionGate({
      result: { steps: 1, toolCalls: 0 },
      sessionId: "session-y",
      storageLayout: createLayout(),
      sessionTraceEnabled: false,
    });
    expect(result?.verdict).toBe("PARTIAL");
    expect(result?.evidencePath).toBeDefined();
    expect(result?.tracePath).toBeUndefined();
    expect(result?.environmentLimits).toEqual([
      "trace_path unavailable because session tracing is disabled.",
    ]);
  });

  it("treats a turn with tool calls but zero steps as non-trivial", () => {
    const result = applyVerifierCompletionGate({
      result: { steps: 0, toolCalls: 1 },
      sessionId: "s2",
      storageLayout: createLayout(),
      sessionTraceEnabled: false,
    });
    expect(result?.verdict).toBe("PARTIAL");
  });
});
