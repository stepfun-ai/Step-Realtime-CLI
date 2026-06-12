import { describe, it, expect } from "vitest";
import {
  cloneStepCliVerifierVerdict,
  isStepCliVerifierVerdict,
} from "./verifier.js";

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
});
