import { describe, it, expect } from "vitest";
import {
  UNLIMITED_MAX_STEPS,
  isUnlimitedMaxSteps,
  formatMaxSteps,
  parseMaxSteps,
  readConfiguredMaxSteps,
} from "./max-steps.js";

describe("isUnlimitedMaxSteps", () => {
  it("returns true for positive infinity", () => {
    expect(isUnlimitedMaxSteps(Number.POSITIVE_INFINITY)).toBe(true);
  });

  it("returns true for negative infinity", () => {
    expect(isUnlimitedMaxSteps(Number.NEGATIVE_INFINITY)).toBe(true);
  });

  it("returns false for finite positive integers", () => {
    expect(isUnlimitedMaxSteps(10)).toBe(false);
    expect(isUnlimitedMaxSteps(1)).toBe(false);
  });
});

describe("formatMaxSteps", () => {
  it('returns "unlimited" for non-finite values', () => {
    expect(formatMaxSteps(UNLIMITED_MAX_STEPS)).toBe("unlimited");
  });

  it("returns stringified integer for finite values", () => {
    expect(formatMaxSteps(42)).toBe("42");
  });
});

describe("parseMaxSteps", () => {
  it("parses positive integer strings", () => {
    expect(parseMaxSteps("10")).toBe(10);
    expect(parseMaxSteps("  25  ")).toBe(25);
  });

  it("accepts unlimited aliases case-insensitively", () => {
    expect(parseMaxSteps("unlimited")).toBe(UNLIMITED_MAX_STEPS);
    expect(parseMaxSteps("INFINITE")).toBe(UNLIMITED_MAX_STEPS);
    expect(parseMaxSteps(" infinity ")).toBe(UNLIMITED_MAX_STEPS);
    expect(parseMaxSteps("none")).toBe(UNLIMITED_MAX_STEPS);
  });

  it("throws for zero", () => {
    expect(() => parseMaxSteps("0")).toThrow(
      "Expected positive integer or 'unlimited'",
    );
  });

  it("throws for negative integers", () => {
    expect(() => parseMaxSteps("-5")).toThrow(
      "Expected positive integer or 'unlimited'",
    );
  });

  it("throws for non-numeric strings", () => {
    expect(() => parseMaxSteps("abc")).toThrow(
      "Expected positive integer or 'unlimited'",
    );
  });

  it("parseInt truncates decimal strings to integer", () => {
    expect(parseMaxSteps("3.5")).toBe(3);
  });
});

describe("readConfiguredMaxSteps", () => {
  it("returns undefined for null and undefined", () => {
    expect(readConfiguredMaxSteps(undefined, "agent.maxSteps")).toBeUndefined();
    expect(readConfiguredMaxSteps(null, "agent.maxSteps")).toBeUndefined();
  });

  it("parses string values via parseMaxSteps", () => {
    expect(readConfiguredMaxSteps("15", "agent.maxSteps")).toBe(15);
    expect(readConfiguredMaxSteps("unlimited", "agent.maxSteps")).toBe(
      UNLIMITED_MAX_STEPS,
    );
  });

  it("accepts positive integer numbers", () => {
    expect(readConfiguredMaxSteps(8, "agent.maxSteps")).toBe(8);
  });

  it("throws for invalid types and non-positive numbers", () => {
    expect(() => readConfiguredMaxSteps(0, "agent.maxSteps")).toThrow(
      "Expected agent.maxSteps to be a positive integer or 'unlimited'",
    );
    expect(() => readConfiguredMaxSteps(-1, "agent.maxSteps")).toThrow(
      "Expected agent.maxSteps to be a positive integer or 'unlimited'",
    );
    expect(() => readConfiguredMaxSteps(true, "agent.maxSteps")).toThrow(
      "Expected agent.maxSteps to be a positive integer or 'unlimited'",
    );
  });
});
