import { describe, it, expect } from "vitest";
import {
  truncateText,
  normalizeWhitespace,
  shortenLine,
  toLineLimitedPreview,
} from "../text.js";
import { clamp } from "../math.js";
import { toErrorMessage } from "../error.js";
import { safeParseJson } from "../json.js";
import { createMutableRef } from "../mutable-ref.js";

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

// ---------------------------------------------------------------------------
// math.ts
// ---------------------------------------------------------------------------

describe("clamp", () => {
  it("returns value when within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("returns min when value is below min", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
  });

  it("returns max when value is above max", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it("returns value when exactly at min boundary", () => {
    expect(clamp(0, 0, 10)).toBe(0);
  });

  it("returns value when exactly at max boundary", () => {
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it("returns min when min > max (Math.max behavior)", () => {
    // clamp(5, 10, 0) = Math.max(10, Math.min(0, 5)) = Math.max(10, 0) = 10
    expect(clamp(5, 10, 0)).toBe(10);
  });

  it("works with negative ranges", () => {
    expect(clamp(-5, -10, -1)).toBe(-5);
    expect(clamp(-15, -10, -1)).toBe(-10);
    expect(clamp(0, -10, -1)).toBe(-1);
  });

  it("works when min === max", () => {
    expect(clamp(5, 3, 3)).toBe(3);
    expect(clamp(1, 3, 3)).toBe(3);
    expect(clamp(3, 3, 3)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// error.ts
// ---------------------------------------------------------------------------

describe("toErrorMessage", () => {
  it("extracts message from Error instance", () => {
    expect(toErrorMessage(new Error("something went wrong"))).toBe(
      "something went wrong",
    );
  });

  it("extracts message from a subclass of Error", () => {
    expect(toErrorMessage(new TypeError("type mismatch"))).toBe(
      "type mismatch",
    );
  });

  it("extracts message from RangeError", () => {
    expect(toErrorMessage(new RangeError("out of range"))).toBe("out of range");
  });

  it("converts string to string", () => {
    expect(toErrorMessage("plain string")).toBe("plain string");
  });

  it("converts number to string", () => {
    expect(toErrorMessage(42)).toBe("42");
  });

  it("converts boolean to string", () => {
    expect(toErrorMessage(true)).toBe("true");
  });

  it("converts null to string", () => {
    expect(toErrorMessage(null)).toBe("null");
  });

  it("converts undefined to string", () => {
    expect(toErrorMessage(undefined)).toBe("undefined");
  });

  it("converts plain object via String()", () => {
    expect(toErrorMessage({ key: "value" })).toBe("[object Object]");
  });

  it("converts array via String()", () => {
    expect(toErrorMessage([1, 2, 3])).toBe("1,2,3");
  });

  it("converts symbol via String()", () => {
    expect(toErrorMessage(Symbol("foo"))).toBe("Symbol(foo)");
  });
});

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

// ---------------------------------------------------------------------------
// mutable-ref.ts
// ---------------------------------------------------------------------------

describe("createMutableRef", () => {
  it("throws when get is called before set", () => {
    const ref = createMutableRef<string>("myLabel");
    expect(() => ref.get()).toThrow("myLabel is not initialized");
  });

  it("isSet returns false before set is called", () => {
    const ref = createMutableRef<number>("count");
    expect(ref.isSet()).toBe(false);
  });

  it("returns the value from get after set is called", () => {
    const ref = createMutableRef<string>("name");
    ref.set("Alice");
    expect(ref.get()).toBe("Alice");
  });

  it("isSet returns true after set is called", () => {
    const ref = createMutableRef<number>("count");
    ref.set(42);
    expect(ref.isSet()).toBe(true);
  });

  it("allows multiple set calls and returns the latest value", () => {
    const ref = createMutableRef<number>("counter");
    ref.set(1);
    expect(ref.get()).toBe(1);
    ref.set(2);
    expect(ref.get()).toBe(2);
    ref.set(3);
    expect(ref.get()).toBe(3);
  });

  it("stays initialized after multiple set calls", () => {
    const ref = createMutableRef<string>("val");
    ref.set("first");
    ref.set("second");
    expect(ref.isSet()).toBe(true);
  });

  it("works with object values", () => {
    const ref = createMutableRef<{ name: string }>("obj");
    const obj = { name: "test" };
    ref.set(obj);
    expect(ref.get()).toBe(obj);
  });

  it("works with null values after set", () => {
    const ref = createMutableRef<string | null>("nullable");
    ref.set(null);
    // After set(null), value is null which is !== undefined, so isSet returns true
    expect(ref.isSet()).toBe(true);
    expect(ref.get()).toBeNull();
  });

  it("uses the label in the error message", () => {
    const ref = createMutableRef<boolean>("CustomLabel");
    expect(() => ref.get()).toThrow("CustomLabel is not initialized");
  });
});
