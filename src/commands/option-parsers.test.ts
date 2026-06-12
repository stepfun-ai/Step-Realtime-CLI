import { describe, it, expect } from "vitest";
import {
  parsePositiveInt,
  parseOperatingMode,
  parseApprovalMode,
  parseNonNegativeInt,
  parseNumber,
  parseNonInteractiveApproval,
  parseConfigScope,
  collectToolOverride,
  collectRepeatedString,
  InvalidArgumentError,
} from "./option-parsers.js";

describe("parsePositiveInt", () => {
  it("parses valid positive integers", () => {
    expect(parsePositiveInt("5")).toBe(5);
    expect(parsePositiveInt("100")).toBe(100);
  });

  it("throws for zero", () => {
    expect(() => parsePositiveInt("0")).toThrow("positive integer");
  });

  it("throws for negative", () => {
    expect(() => parsePositiveInt("-3")).toThrow("positive integer");
  });

  it("throws for non-numeric strings", () => {
    expect(() => parsePositiveInt("abc")).toThrow("positive integer");
  });
});

describe("parseNonNegativeInt", () => {
  it("accepts zero", () => {
    expect(parseNonNegativeInt("0")).toBe(0);
  });

  it("throws for negative", () => {
    expect(() => parseNonNegativeInt("-1")).toThrow("non-negative");
  });
});

describe("parseNumber", () => {
  it("parses floats", () => {
    expect(parseNumber("3.14")).toBeCloseTo(3.14);
  });

  it("throws for non-numeric", () => {
    expect(() => parseNumber("xyz")).toThrow("Expected number");
  });
});

describe("parseOperatingMode", () => {
  it("accepts normal and plan", () => {
    expect(parseOperatingMode("normal")).toBe("normal");
    expect(parseOperatingMode("plan")).toBe("plan");
  });

  it("throws for unknown mode", () => {
    expect(() => parseOperatingMode("debug")).toThrow(InvalidArgumentError);
  });
});

describe("parseApprovalMode", () => {
  it("accepts confirm, auto, strict", () => {
    expect(parseApprovalMode("confirm")).toBe("confirm");
    expect(parseApprovalMode("auto")).toBe("auto");
    expect(parseApprovalMode("strict")).toBe("strict");
  });

  it("throws for unknown mode", () => {
    expect(() => parseApprovalMode("manual")).toThrow("Unsupported");
  });
});

describe("parseNonInteractiveApproval", () => {
  it("accepts allow and deny", () => {
    expect(parseNonInteractiveApproval("allow")).toBe("allow");
    expect(parseNonInteractiveApproval("deny")).toBe("deny");
  });

  it("throws for unknown", () => {
    expect(() => parseNonInteractiveApproval("maybe")).toThrow("Unsupported");
  });
});

describe("parseConfigScope", () => {
  it("accepts user and workspace", () => {
    expect(parseConfigScope("user")).toBe("user");
    expect(parseConfigScope("workspace")).toBe("workspace");
  });

  it("throws for unknown", () => {
    expect(() => parseConfigScope("global")).toThrow("Unsupported");
  });
});

describe("collectToolOverride", () => {
  it("accumulates overrides", () => {
    const result = collectToolOverride("my_tool=allow", {});
    expect(result).toEqual({ my_tool: "allow" });
  });

  it("adds to previous overrides", () => {
    const result = collectToolOverride("b=deny", { a: "allow" });
    expect(result).toEqual({ a: "allow", b: "deny" });
  });

  it("throws for missing separator", () => {
    expect(() => collectToolOverride("no_equals", {})).toThrow(
      "Invalid --tool-override",
    );
  });

  it("throws for invalid permission mode", () => {
    expect(() => collectToolOverride("tool=maybe", {})).toThrow(
      "Invalid tool permission mode",
    );
  });
});

describe("collectRepeatedString", () => {
  it("accumulates trimmed values", () => {
    const result = collectRepeatedString("hello", undefined);
    expect(result).toEqual(["hello"]);
    const result2 = collectRepeatedString("world", result);
    expect(result2).toEqual(["hello", "world"]);
  });

  it("throws for empty value", () => {
    expect(() => collectRepeatedString("  ", undefined)).toThrow(
      InvalidArgumentError,
    );
  });
});
