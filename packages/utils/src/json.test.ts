import { describe, it, expect } from "vitest";
import { safeParseJson } from "./json.js";

// ---------------------------------------------------------------------------
// json.ts
// ---------------------------------------------------------------------------

describe("safeParseJson", () => {
  const fallback = { default: true };

  it("returns fallback for null input", () => {
    expect(safeParseJson(null, fallback)).toBe(fallback);
  });

  it("returns fallback for undefined input", () => {
    expect(safeParseJson(undefined, fallback)).toBe(fallback);
  });

  it("returns fallback for empty string", () => {
    expect(safeParseJson("", fallback)).toBe(fallback);
  });

  it("returns fallback for whitespace-only string", () => {
    expect(safeParseJson("   \t\n  ", fallback)).toBe(fallback);
  });

  it("parses valid JSON object", () => {
    const result = safeParseJson('{"a":1}', fallback);
    expect(result).toEqual({ a: 1 });
  });

  it("parses valid JSON array", () => {
    const result = safeParseJson("[1,2,3]", fallback);
    expect(result).toEqual([1, 2, 3]);
  });

  it("parses valid JSON primitive", () => {
    expect(safeParseJson("42", fallback)).toBe(42);
    expect(safeParseJson('"hello"', fallback)).toBe("hello");
    expect(safeParseJson("true", fallback)).toBe(true);
    expect(safeParseJson("false", fallback)).toBe(false);
    expect(safeParseJson("null", fallback)).toBe(null);
  });

  it("returns fallback for invalid JSON", () => {
    expect(safeParseJson("{invalid", fallback)).toBe(fallback);
  });

  it("returns fallback for truncated JSON", () => {
    expect(safeParseJson('{"a":', fallback)).toBe(fallback);
  });

  it("returns fallback for random text", () => {
    expect(safeParseJson("not json at all", fallback)).toBe(fallback);
  });

  it("parses whitespace-padded valid JSON", () => {
    const result = safeParseJson('  \n  {"key": "value"}  \t  ', fallback);
    expect(result).toEqual({ key: "value" });
  });

  it("preserves the exact parsed value reference for objects", () => {
    const parsed = safeParseJson('{"x":1}', null);
    expect(parsed).toEqual({ x: 1 });
  });

  it("returns the fallback reference for invalid JSON", () => {
    const myFallback = [1, 2, 3];
    expect(safeParseJson("bad", myFallback)).toBe(myFallback);
  });
});
