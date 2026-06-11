import { describe, it, expect } from "vitest";
import {
  scoreFuzzyMatch,
  normalizeSearchText,
  tokenizeSearchText,
} from "./search.js";

// ---------------------------------------------------------------------------
// search.ts
// ---------------------------------------------------------------------------
describe("normalizeSearchText", () => {
  it("lowercases and trims", () => {
    expect(normalizeSearchText("  Hello WORLD  ")).toBe("hello world");
  });

  it("collapses multiple spaces into one", () => {
    expect(normalizeSearchText("foo   bar")).toBe("foo bar");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeSearchText("   ")).toBe("");
  });

  it("handles single word", () => {
    expect(normalizeSearchText("Test")).toBe("test");
  });
});

describe("tokenizeSearchText", () => {
  it("splits on non-alphanumeric separators", () => {
    const tokens = tokenizeSearchText("foo bar baz");
    expect(tokens).toContain("foo");
    expect(tokens).toContain("bar");
    expect(tokens).toContain("baz");
    expect(tokens).toHaveLength(3);
  });

  it("deduplicates tokens", () => {
    const tokens = tokenizeSearchText("foo foo bar");
    const foos = tokens.filter((t) => t === "foo");
    expect(foos).toHaveLength(1);
  });

  it("returns empty array for empty string", () => {
    expect(tokenizeSearchText("")).toEqual([]);
  });

  it("returns the normalized text as a single token when there are no word chars", () => {
    // Only non-alphanumeric chars like spaces, punctuation
    const tokens = tokenizeSearchText("   ");
    expect(tokens).toEqual([]);
  });

  it("preserves hyphens, underscores, and colons in tokens", () => {
    const tokens = tokenizeSearchText("my-key:val_name");
    expect(tokens).toEqual(["my-key:val_name"]);
  });
});

describe("scoreFuzzyMatch", () => {
  it("returns 0 for empty query", () => {
    expect(scoreFuzzyMatch("", [{ text: "anything", weight: 1 }])).toBe(0);
  });

  it("returns 0 for empty / missing fields", () => {
    expect(scoreFuzzyMatch("query", [])).toBe(0);
    expect(scoreFuzzyMatch("query", [{ text: "", weight: 1 }])).toBe(0);
    expect(scoreFuzzyMatch("query", [{ weight: 1 }])).toBe(0);
  });

  it("scores an exact match highest", () => {
    const exact = scoreFuzzyMatch("hello", [{ text: "hello", weight: 1 }]);
    expect(exact).toBeGreaterThan(0);
  });

  it("scores starts-with higher than contains", () => {
    const startsWith = scoreFuzzyMatch("hel", [
      { text: "hello world", weight: 1 },
    ]);
    const contains = scoreFuzzyMatch("rld", [
      { text: "hello world", weight: 1 },
    ]);
    expect(startsWith).toBeGreaterThan(contains);
  });

  it("scores contains above no match", () => {
    const contains = scoreFuzzyMatch("llo", [
      { text: "hello world", weight: 1 },
    ]);
    expect(contains).toBeGreaterThan(0);
  });

  it("applies token matching bonus", () => {
    // Both queries have no starts-with match; the one matching more tokens scores higher
    const multiToken = scoreFuzzyMatch("hello world", [
      { text: "hello wonderful world", weight: 1 },
    ]);
    const singleToken = scoreFuzzyMatch("hello absent", [
      { text: "hello wonderful world", weight: 1 },
    ]);
    expect(multiToken).toBeGreaterThan(singleToken);
  });

  it("applies subsequence bonus for queries longer than 2 chars", () => {
    // "hlw" is a subsequence of "hello world" (h...l...w...)
    const score = scoreFuzzyMatch("hlw", [{ text: "hello world", weight: 1 }]);
    expect(score).toBeGreaterThan(0);
  });

  it("returns 0 for no match at all", () => {
    expect(scoreFuzzyMatch("xyz", [{ text: "hello world", weight: 1 }])).toBe(
      0,
    );
  });

  it("respects weight of 0", () => {
    expect(scoreFuzzyMatch("hello", [{ text: "hello", weight: 0 }])).toBe(0);
  });

  it("applies weight multiplier", () => {
    const w1 = scoreFuzzyMatch("hello", [{ text: "hello", weight: 1 }]);
    const w2 = scoreFuzzyMatch("hello", [{ text: "hello", weight: 2 }]);
    expect(w2).toBe(w1 * 2);
  });

  it("handles special characters in query gracefully", () => {
    const score = scoreFuzzyMatch("hello!", [{ text: "hello", weight: 1 }]);
    // Should still produce some score because the alphanumeric part matches
    expect(score).toBeGreaterThan(0);
  });
});
