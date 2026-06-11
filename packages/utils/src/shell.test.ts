import { describe, it, expect } from "vitest";
import { enforceOutputLimit } from "./shell.js";

// ---------------------------------------------------------------------------
// shell.ts (from batch2)
// ---------------------------------------------------------------------------
describe("enforceOutputLimit", () => {
  it("returns the input unchanged when it is under the limit", () => {
    expect(enforceOutputLimit("hello", 100)).toBe("hello");
  });

  it("returns the input unchanged when length equals the limit", () => {
    const input = "a".repeat(50);
    expect(enforceOutputLimit(input, 50)).toBe(input);
  });

  it("truncates with head/tail split when over the limit", () => {
    const input = "a".repeat(200);
    const result = enforceOutputLimit(input, 100);
    expect(result.length).toBeGreaterThan(100); // marker adds chars
    expect(result).toContain("[truncated");
    // head is 40% of limit = 40 chars of 'a'
    const head = result.slice(0, 40);
    expect(head).toBe("a".repeat(40));
    // tail is 60% of limit = 60 chars of 'a'
    expect(result.endsWith("a".repeat(60))).toBe(true);
  });

  it("returns the input when limit is 0 and input is empty", () => {
    expect(enforceOutputLimit("", 0)).toBe("");
  });

  it("truncates when limit is 0 and input is non-empty", () => {
    const result = enforceOutputLimit("hello", 0);
    // head = max(0, 0 - 0) = 0, tail = floor(0 * 0.6) = 0
    // result = "" + marker + ""
    expect(result).toContain("[truncated");
  });

  it("truncates when limit is 1", () => {
    const input = "abcde";
    const result = enforceOutputLimit(input, 1);
    // head = max(0, 1 - floor(0.6)) = max(0, 1-0) = 1
    // tail = floor(1 * 0.6) = 0
    expect(result).toContain("[truncated");
    expect(result.startsWith("a")).toBe(true);
  });

  it("preserves beginning (head) and ending (tail) of output", () => {
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`line ${i.toString().padStart(3, "0")}`);
    }
    const input = lines.join("\n");
    const limit = 200;
    const result = enforceOutputLimit(input, limit);
    // Should contain first lines and last lines
    expect(result).toContain("line 000");
    expect(result).toContain("line 099");
    expect(result).not.toContain("line 050");
  });
});

// ---------------------------------------------------------------------------
// shell.ts (additional edge cases from batch4)
// ---------------------------------------------------------------------------
describe("enforceOutputLimit", () => {
  it("returns value unchanged when within limit", () => {
    expect(enforceOutputLimit("short", 100)).toBe("short");
  });

  it("returns value unchanged when exactly at limit", () => {
    const s = "a".repeat(50);
    expect(enforceOutputLimit(s, 50)).toBe(s);
  });

  it("truncates with head+tail when over limit", () => {
    const s = "a".repeat(200);
    const result = enforceOutputLimit(s, 100);
    expect(result).toContain("[truncated");
    // head = 40% of limit = 40 chars, tail = 60% = 60 chars
    expect(result.startsWith("a".repeat(40))).toBe(true);
    expect(result.endsWith("a".repeat(60))).toBe(true);
  });

  it("handles limit of 0", () => {
    const result = enforceOutputLimit("hello", 0);
    expect(result).toContain("[truncated");
  });

  it("handles empty string", () => {
    expect(enforceOutputLimit("", 10)).toBe("");
  });

  it("handles single-char limit", () => {
    const result = enforceOutputLimit("abcdef", 1);
    expect(result).toContain("[truncated");
  });
});
