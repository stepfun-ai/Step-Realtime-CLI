import { describe, it, expect } from "vitest";
import { visibleLength, truncateInlineText } from "./display-width.js";

// ---------------------------------------------------------------------------
// display-width.ts
// ---------------------------------------------------------------------------
describe("visibleLength", () => {
  it("returns the length of plain ASCII text", () => {
    expect(visibleLength("hello")).toBe(5);
  });

  it("returns 0 for an empty string", () => {
    expect(visibleLength("")).toBe(0);
  });

  it("counts CJK characters as width 2", () => {
    // Two han characters, each occupying 2 columns
    expect(visibleLength("你好")).toBe(4);
  });

  it("strips ANSI escape codes and counts only visible characters", () => {
    // Red-colored "hi" -- the escape sequences should not count
    const withAnsi = "\x1b[31mhi\x1b[0m";
    expect(visibleLength(withAnsi)).toBe(2);
  });

  it("handles mixed ASCII and CJK", () => {
    // "ab" (2) + two CJK chars (4) = 6
    expect(visibleLength("ab你好")).toBe(6);
  });
});

describe("truncateInlineText", () => {
  it("returns the original text when it fits within maxChars", () => {
    expect(truncateInlineText("hello", 10)).toBe("hello");
  });

  it("returns the original text when visible length equals maxChars", () => {
    expect(truncateInlineText("hello", 5)).toBe("hello");
  });

  it("truncates with ellipsis when text exceeds maxChars", () => {
    const result = truncateInlineText("hello world", 8);
    expect(visibleLength(result)).toBeLessThanOrEqual(8);
    expect(result.endsWith("…")).toBe(true);
  });

  it("returns empty string when maxChars <= 0", () => {
    expect(truncateInlineText("hello", 0)).toBe("");
    expect(truncateInlineText("hello", -5)).toBe("");
  });

  it("returns a single grapheme when maxChars === 1", () => {
    expect(truncateInlineText("abc", 1)).toBe("a");
  });

  it("handles CJK truncation within maxChars", () => {
    // Each CJK char has width 2.  With maxChars=5 we expect truncation.
    const input = "你好世界"; // 4 CJK chars = width 8
    const result = truncateInlineText(input, 5);
    expect(visibleLength(result)).toBeLessThanOrEqual(5);
    expect(result.endsWith("…")).toBe(true);
  });

  it("preserves emoji / grapheme clusters when truncating", () => {
    // Family emoji is a single grapheme cluster with visible width 2
    const family = "👨‍👩‍👦";
    const result = truncateInlineText(`aa${family}bb`, 4);
    expect(visibleLength(result)).toBeLessThanOrEqual(4);
  });

  it("truncates a very long string correctly", () => {
    const long = "a".repeat(200);
    const result = truncateInlineText(long, 50);
    expect(visibleLength(result)).toBeLessThanOrEqual(50);
    expect(result.endsWith("…")).toBe(true);
  });
});
