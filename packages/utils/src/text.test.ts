import { describe, it, expect } from "vitest";
import {
  truncateText,
  normalizeWhitespace,
  shortenLine,
  toLineLimitedPreview,
} from "./text.js";

// ---------------------------------------------------------------------------
// text.ts
// ---------------------------------------------------------------------------

describe("truncateText", () => {
  // ---- no-op (text within limit) ----

  it("returns text unchanged when within normalized limit", () => {
    const result = truncateText({ text: "hello", maxChars: 64 });
    expect(result.text).toBe("hello");
    expect(result.truncation).toBeUndefined();
  });

  it("returns text unchanged when exactly at normalized limit", () => {
    const text = "a".repeat(64);
    const result = truncateText({ text, maxChars: 64 });
    expect(result.text).toBe(text);
    expect(result.truncation).toBeUndefined();
  });

  // ---- maxChars < 64 normalization ----

  it("normalizes maxChars below 64 up to 64 (default strategy = head)", () => {
    const text = "a".repeat(100);
    const result = truncateText({ text, maxChars: 10 });
    // limit normalized to 64, so head is first 64 chars
    expect(result.text).toBe(`${"a".repeat(64)}\n...[truncated]`);
    expect(result.truncation).toBeDefined();
    expect(result.truncation!.originalChars).toBe(100);
    expect(result.truncation!.retainedChars).toBe(64);
  });

  it("normalizes maxChars 0 up to 64", () => {
    const text = "b".repeat(200);
    const result = truncateText({ text, maxChars: 0 });
    // normalized to 64
    expect(result.text).toBe(`${"b".repeat(64)}\n...[truncated]`);
  });

  // ---- strategy: head (default) ----

  it("truncates from the head with default strategy", () => {
    const text = "a".repeat(200);
    const result = truncateText({ text, maxChars: 100 });
    expect(result.text).toBe(`${"a".repeat(100)}\n...[truncated]`);
    expect(result.truncation).toEqual({
      strategy: "head",
      originalChars: 200,
      retainedChars: 100,
    });
  });

  it("truncates with explicit head strategy", () => {
    const text = "abcdef".repeat(50); // 300 chars
    const result = truncateText({ text, maxChars: 80, strategy: "head" });
    expect(result.text).toBe(`${text.slice(0, 80)}\n...[truncated]`);
    expect(result.truncation!.strategy).toBe("head");
    expect(result.truncation!.retainedChars).toBe(80);
  });

  // ---- strategy: tail ----

  it("truncates from the tail", () => {
    const text = "a".repeat(200);
    const result = truncateText({ text, maxChars: 100, strategy: "tail" });
    const expectedTail = "a".repeat(100);
    expect(result.text).toBe(`...[truncated]\n${expectedTail}`);
    expect(result.truncation).toEqual({
      strategy: "tail",
      originalChars: 200,
      retainedChars: 100,
    });
  });

  it("tail strategy returns last normalizedLimit chars", () => {
    const text = "abcdefghij".repeat(20); // 200 chars
    const result = truncateText({ text, maxChars: 50, strategy: "tail" });
    // maxChars 50 is below 64 so normalized to 64
    const normalizedLimit = 64;
    const expectedTail = text.slice(text.length - normalizedLimit);
    expect(result.text).toBe(`...[truncated]\n${expectedTail}`);
    expect(result.truncation!.retainedChars).toBe(normalizedLimit);
  });

  // ---- strategy: head_tail ----

  it("truncates with head_tail strategy", () => {
    const text = "a".repeat(200);
    const result = truncateText({
      text,
      maxChars: 100,
      strategy: "head_tail",
    });
    const headSize = Math.floor(100 * 0.6); // 60
    const tailSize = 100 - headSize; // 40
    const omittedChars = 200 - headSize - tailSize; // 100
    const head = "a".repeat(headSize);
    const tail = "a".repeat(tailSize);
    expect(result.text).toBe(
      `${head}\n...[truncated ${omittedChars} chars]...\n${tail}`,
    );
    expect(result.truncation).toEqual({
      strategy: "head_tail",
      originalChars: 200,
      retainedChars: headSize + tailSize,
    });
  });

  it("head_tail splits 60/40 at normalized limit", () => {
    const text = "X".repeat(300);
    const maxChars = 150;
    const headSize = Math.floor(maxChars * 0.6); // 90
    const tailSize = maxChars - headSize; // 60
    const result = truncateText({ text, maxChars, strategy: "head_tail" });
    const omittedChars = 300 - headSize - tailSize; // 150
    expect(result.text).toContain(`...[truncated ${omittedChars} chars]...`);
    expect(result.truncation!.retainedChars).toBe(headSize + tailSize);
  });

  // ---- exactMaxChars ----

  describe("exactMaxChars = true", () => {
    it("returns text unchanged when within limit", () => {
      const result = truncateText({
        text: "short",
        maxChars: 10,
        exactMaxChars: true,
      });
      expect(result.text).toBe("short");
      expect(result.truncation).toBeUndefined();
    });

    it("returns text unchanged when exactly at limit", () => {
      const text = "abcde";
      const result = truncateText({
        text,
        maxChars: 5,
        exactMaxChars: true,
      });
      expect(result.text).toBe("abcde");
      expect(result.truncation).toBeUndefined();
    });

    it("truncates head exactly to maxChars", () => {
      const text = "a".repeat(200);
      const maxChars = 50;
      const marker = "\n...[truncated]";
      const result = truncateText({
        text,
        maxChars,
        exactMaxChars: true,
        strategy: "head",
      });
      expect(result.text.length).toBe(maxChars);
      expect(result.text).toBe(
        `${"a".repeat(maxChars - marker.length)}${marker}`,
      );
      expect(result.truncation!.retainedChars).toBe(maxChars - marker.length);
    });

    it("truncates tail exactly to maxChars", () => {
      const text = "a".repeat(200);
      const maxChars = 50;
      const marker = "...[truncated]\n";
      const result = truncateText({
        text,
        maxChars,
        exactMaxChars: true,
        strategy: "tail",
      });
      expect(result.text.length).toBe(maxChars);
      expect(result.text).toBe(
        `${marker}${"a".repeat(maxChars - marker.length)}`,
      );
      expect(result.truncation!.retainedChars).toBe(maxChars - marker.length);
    });

    it("truncates head_tail exactly to maxChars", () => {
      const text = "a".repeat(200);
      const maxChars = 80;
      const result = truncateText({
        text,
        maxChars,
        exactMaxChars: true,
        strategy: "head_tail",
      });
      expect(result.text.length).toBeLessThanOrEqual(maxChars);
      expect(result.truncation!.strategy).toBe("head_tail");
      expect(result.truncation!.originalChars).toBe(200);
    });

    it("returns empty string and marker info when maxChars is 0", () => {
      const text = "hello";
      const result = truncateText({
        text,
        maxChars: 0,
        exactMaxChars: true,
      });
      expect(result.text).toBe("");
      expect(result.truncation).toEqual({
        strategy: "head",
        originalChars: 5,
        retainedChars: 0,
      });
    });

    it("handles negative maxChars by clamping to 0 (exactMaxChars)", () => {
      const text = "hello";
      const result = truncateText({
        text,
        maxChars: -5,
        exactMaxChars: true,
      });
      expect(result.text).toBe("");
      expect(result.truncation).toBeDefined();
      expect(result.truncation!.retainedChars).toBe(0);
    });

    it("returns only partial marker when maxChars < marker length (head)", () => {
      const text = "abcdefghij";
      const result = truncateText({
        text,
        maxChars: 5,
        exactMaxChars: true,
        strategy: "head",
      });
      // marker is "\n...[truncated]" (15 chars), only first 5 fit
      expect(result.text).toBe("\n...[");
      expect(result.text.length).toBe(5);
    });

    it("returns only partial marker when maxChars < marker length (tail)", () => {
      const text = "abcdefghij";
      const result = truncateText({
        text,
        maxChars: 5,
        exactMaxChars: true,
        strategy: "tail",
      });
      // marker is "...[truncated]\n" (16 chars), only first 5 fit
      expect(result.text).toBe("...[t");
      expect(result.text.length).toBe(5);
    });
  });

  // ---- empty string edge case ----

  it("handles empty string input", () => {
    const result = truncateText({ text: "", maxChars: 100 });
    expect(result.text).toBe("");
    expect(result.truncation).toBeUndefined();
  });

  it("handles empty string with exactMaxChars", () => {
    const result = truncateText({ text: "", maxChars: 0, exactMaxChars: true });
    expect(result.text).toBe("");
    expect(result.truncation).toBeUndefined();
  });
});

describe("normalizeWhitespace", () => {
  it("returns a single space unchanged", () => {
    expect(normalizeWhitespace(" ")).toBe("");
  });

  it("collapses multiple spaces into one", () => {
    expect(normalizeWhitespace("hello   world")).toBe("hello world");
  });

  it("collapses tabs into spaces", () => {
    expect(normalizeWhitespace("hello\t\tworld")).toBe("hello world");
  });

  it("collapses newlines into spaces", () => {
    expect(normalizeWhitespace("hello\n\nworld")).toBe("hello world");
  });

  it("collapses mixed whitespace", () => {
    expect(normalizeWhitespace("hello \t\n \r\n world")).toBe("hello world");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeWhitespace("  hello  ")).toBe("hello");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeWhitespace("   \t\n  ")).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeWhitespace("")).toBe("");
  });

  it("handles a string with no whitespace", () => {
    expect(normalizeWhitespace("hello")).toBe("hello");
  });
});

describe("shortenLine", () => {
  it("returns text unchanged when within limit", () => {
    expect(shortenLine("hello", 10)).toBe("hello");
  });

  it("returns text unchanged when exactly at limit", () => {
    expect(shortenLine("hello", 5)).toBe("hello");
  });

  it("truncates and appends ellipsis when over limit", () => {
    expect(shortenLine("hello world", 8)).toBe("hello...");
  });

  it("normalizes whitespace before truncating", () => {
    expect(shortenLine("hello   world", 10)).toBe("hello w...");
  });

  it("handles maxChars = 3 (just enough for ellipsis)", () => {
    expect(shortenLine("hello", 3)).toBe("...");
  });

  it("handles maxChars < 3 (ellipsis gets truncated)", () => {
    const result = shortenLine("hello", 2);
    // maxChars - 3 = -1, Math.max(0, -1) = 0, so slice(0,0) = "" then "..."
    // but "..." is 3 chars and maxChars is 2, but the function doesn't re-trim
    expect(result).toBe("...");
  });

  it("handles maxChars = 0", () => {
    const result = shortenLine("hello", 0);
    expect(result).toBe("...");
  });

  it("handles empty string", () => {
    expect(shortenLine("", 10)).toBe("");
  });

  it("handles text that only becomes short after normalization", () => {
    expect(shortenLine("  hello  ", 5)).toBe("hello");
  });
});

describe("toLineLimitedPreview", () => {
  it("returns text unchanged when within line limit", () => {
    expect(toLineLimitedPreview("a\nb\nc", 5)).toBe("a\nb\nc");
  });

  it("returns text unchanged when exactly at line limit", () => {
    expect(toLineLimitedPreview("a\nb\nc", 3)).toBe("a\nb\nc");
  });

  it("truncates lines and shows omitted count", () => {
    const text = "a\nb\nc\nd\ne";
    const result = toLineLimitedPreview(text, 3);
    expect(result).toBe("a\nb\nc\n...[2 lines omitted]");
  });

  it("handles single line within limit", () => {
    expect(toLineLimitedPreview("hello", 1)).toBe("hello");
  });

  it("handles single line exceeding limit with maxLines = 0", () => {
    const result = toLineLimitedPreview("hello", 0);
    // kept = lines.slice(0, 0) = [], join gives "" then "\n..." prefix
    expect(result).toBe("\n...[1 lines omitted]");
  });

  it("handles empty string", () => {
    expect(toLineLimitedPreview("", 1)).toBe("");
  });

  it("handles CRLF line endings (normalizes to LF in output)", () => {
    const text = "a\r\nb\r\nc\r\nd";
    const result = toLineLimitedPreview(text, 2);
    // split(/\r?\n/) removes \r, join("\n") uses \n
    expect(result).toBe("a\nb\n...[2 lines omitted]");
  });

  it("omits correct number of lines", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const text = lines.join("\n");
    const result = toLineLimitedPreview(text, 5);
    expect(result).toBe(
      "line1\nline2\nline3\nline4\nline5\n...[15 lines omitted]",
    );
  });
});
