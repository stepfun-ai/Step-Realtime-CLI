import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// display-width.ts
import { visibleLength, truncateInlineText } from "../display-width.js";

// search.ts
import {
  scoreFuzzyMatch,
  normalizeSearchText,
  tokenizeSearchText,
} from "../search.js";

// json-schema.ts
import { canonicalizeJsonSchema, cloneJsonSchema } from "../json-schema.js";

// shell.ts
import { enforceOutputLimit } from "../shell.js";

// async-queue.ts
import { AsyncFifo } from "../async-queue.js";

// path.ts
import {
  uniquePaths,
  expandHomeDirectory,
  resolveStorageRootDirectory,
} from "../path.js";

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

// ---------------------------------------------------------------------------
// json-schema.ts
// ---------------------------------------------------------------------------
describe("canonicalizeJsonSchema / cloneJsonSchema", () => {
  it("returns an empty object for an empty schema", () => {
    const result = canonicalizeJsonSchema({});
    expect(result).toEqual({});
  });

  it("preserves all known fields", () => {
    const schema = {
      type: "object" as const,
      description: "test schema",
      required: ["name"],
      properties: { name: { type: "string" as const } },
      items: { type: "string" as const },
      enum: ["a", "b"],
      additionalProperties: false,
      minimum: 0,
      maximum: 100,
      minLength: 1,
      maxLength: 50,
      minItems: 0,
      maxItems: 10,
    };
    const result = canonicalizeJsonSchema(schema);
    expect(result).toEqual(schema);
  });

  it("clones arrays so mutations to the original do not affect the clone", () => {
    const original = { type: "object" as const, required: ["a", "b"] };
    const cloned = cloneJsonSchema(original);
    original.required!.push("c");
    expect(cloned.required).toEqual(["a", "b"]);
  });

  it("sorts extra unknown fields alphabetically", () => {
    const schema = {
      type: "object" as const,
      zebraField: "z",
      alphaField: "a",
    };
    const result = canonicalizeJsonSchema(schema);
    const keys = Object.keys(result);
    // known fields come first, then extras sorted
    const extraStart = keys.indexOf("alphaField");
    expect(extraStart).toBeLessThan(keys.indexOf("zebraField"));
  });

  it("handles type as an array", () => {
    const schema = { type: ["string", "null"] } as any;
    const result = canonicalizeJsonSchema(schema);
    expect(result.type).toEqual(["string", "null"]);
  });

  it("handles items as an array of schemas", () => {
    const schema = {
      type: "array" as const,
      items: [{ type: "string" as const }, { type: "number" as const }],
    };
    const result = canonicalizeJsonSchema(schema);
    expect(result.items).toEqual([{ type: "string" }, { type: "number" }]);
  });

  it("handles items as a single schema object", () => {
    const schema = {
      type: "array" as const,
      items: { type: "string" as const },
    };
    const result = canonicalizeJsonSchema(schema);
    expect(result.items).toEqual({ type: "string" });
  });

  it("deeply clones nested properties", () => {
    const original = {
      type: "object" as const,
      properties: {
        address: {
          type: "object" as const,
          properties: {
            city: { type: "string" as const },
          },
        },
      },
    };
    const cloned = cloneJsonSchema(original);
    // Mutating original should not affect clone
    (original.properties!.address.properties as Record<string, unknown>).city =
      {
        type: "number" as const,
      };
    expect(
      (cloned.properties!.address as Record<string, unknown>).properties,
    ).toEqual({
      city: { type: "string" },
    });
  });

  it("does not mutate the original schema", () => {
    const original = { type: "string" as const, description: "desc" };
    const copy = JSON.parse(JSON.stringify(original));
    canonicalizeJsonSchema(original);
    expect(original).toEqual(copy);
  });

  it("handles additionalProperties as a boolean", () => {
    const schema = { additionalProperties: true };
    const result = canonicalizeJsonSchema(schema);
    expect(result.additionalProperties).toBe(true);
  });

  it("handles additionalProperties as a schema object", () => {
    const schema = { additionalProperties: { type: "string" as const } };
    const result = canonicalizeJsonSchema(schema);
    expect(result.additionalProperties).toEqual({ type: "string" });
  });

  it("structuredClones unknown extra fields", () => {
    const schema = { type: "string" as const, default: { nested: true } };
    const result = canonicalizeJsonSchema(schema);
    expect((result as Record<string, unknown>).default).toEqual({
      nested: true,
    });
    // Ensure it is a clone, not the same reference
    expect((result as Record<string, unknown>).default).not.toBe(
      (schema as Record<string, unknown>).default,
    );
  });
});

// ---------------------------------------------------------------------------
// shell.ts
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
// async-queue.ts
// ---------------------------------------------------------------------------
describe("AsyncFifo", () => {
  it("buffers values pushed before pull", async () => {
    const fifo = new AsyncFifo<number>();
    fifo.push(1);
    fifo.push(2);
    fifo.push(3);
    expect(await fifo.next()).toBe(1);
    expect(await fifo.next()).toBe(2);
    expect(await fifo.next()).toBe(3);
  });

  it("parks a pull and resolves when a value is pushed", async () => {
    const fifo = new AsyncFifo<number>();
    const promise = fifo.next();
    fifo.push(42);
    expect(await promise).toBe(42);
  });

  it("resolves a waiting pull with null when close() is called", async () => {
    const fifo = new AsyncFifo<number>();
    const promise = fifo.next();
    fifo.close();
    expect(await promise).toBeNull();
  });

  it("returns null immediately from next() after close", async () => {
    const fifo = new AsyncFifo<number>();
    fifo.close();
    expect(await fifo.next()).toBeNull();
  });

  it("rejects a waiting pull when fail() is called", async () => {
    const fifo = new AsyncFifo<number>();
    const promise = fifo.next();
    const error = new Error("boom");
    fifo.fail(error);
    await expect(promise).rejects.toThrow("boom");
  });

  it("rejects next() immediately after fail()", async () => {
    const fifo = new AsyncFifo<number>();
    fifo.fail(new Error("fail-fast"));
    await expect(fifo.next()).rejects.toThrow("fail-fast");
  });

  it("push returns false after close", () => {
    const fifo = new AsyncFifo<number>();
    fifo.close();
    expect(fifo.push(1)).toBe(false);
  });

  it("push returns false after fail", () => {
    const fifo = new AsyncFifo<number>();
    fifo.fail(new Error("err"));
    expect(fifo.push(1)).toBe(false);
  });

  it("isOpen returns true initially, false after close", () => {
    const fifo = new AsyncFifo<number>();
    expect(fifo.isOpen()).toBe(true);
    fifo.close();
    expect(fifo.isOpen()).toBe(false);
  });

  it("isOpen returns false after fail", () => {
    const fifo = new AsyncFifo<number>();
    fifo.fail(new Error("x"));
    expect(fifo.isOpen()).toBe(false);
  });

  it("close() is idempotent", () => {
    const fifo = new AsyncFifo<number>();
    fifo.close();
    fifo.close(); // second call should be a no-op
    expect(fifo.isOpen()).toBe(false);
  });

  it("iterator protocol yields values then done on close", async () => {
    const fifo = new AsyncFifo<string>();
    fifo.push("a");
    fifo.push("b");
    fifo.close();

    const iter = fifo.iterator();
    const r1 = await iter.next();
    expect(r1).toEqual({ value: "a", done: false });
    const r2 = await iter.next();
    expect(r2).toEqual({ value: "b", done: false });
    const r3 = await iter.next();
    expect(r3).toEqual({ value: undefined, done: true });
  });

  it("iterator return() closes the fifo", async () => {
    const fifo = new AsyncFifo<number>();
    const iter = fifo.iterator();
    const result = await iter.return!();
    expect(result).toEqual({ value: undefined, done: true });
    expect(fifo.isOpen()).toBe(false);
  });

  it("drains buffer before parking on next()", async () => {
    const fifo = new AsyncFifo<number>();
    fifo.push(10);
    fifo.push(20);
    // First two should come from the buffer
    expect(await fifo.next()).toBe(10);
    expect(await fifo.next()).toBe(20);
    // Third should park, then resolve
    const p = fifo.next();
    fifo.push(30);
    expect(await p).toBe(30);
  });

  it("preserves FIFO ordering with interleaved push and pull", async () => {
    const fifo = new AsyncFifo<string>();
    const results: (string | null)[] = [];

    const p1 = fifo.next(); // parks
    fifo.push("first");
    results.push(await p1);

    fifo.push("second");
    results.push(await fifo.next());

    const p3 = fifo.next(); // parks
    fifo.push("third");
    results.push(await p3);

    expect(results).toEqual(["first", "second", "third"]);
  });
});

// ---------------------------------------------------------------------------
// path.ts
// ---------------------------------------------------------------------------
describe("uniquePaths", () => {
  it("deduplicates identical paths", () => {
    const result = uniquePaths(["/a/b", "/a/b", "/a/b"]);
    expect(result).toHaveLength(1);
  });

  it("resolves relative paths to absolute and deduplicates", () => {
    const cwd = process.cwd();
    const result = uniquePaths(["foo", "./foo", `${cwd}/foo`]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(path.resolve(cwd, "foo"));
  });

  it("keeps distinct paths separate", () => {
    const result = uniquePaths(["/a/b", "/c/d"]);
    expect(result).toHaveLength(2);
  });
});

describe("expandHomeDirectory", () => {
  it("expands ~/ to home directory", () => {
    const home = os.homedir();
    expect(expandHomeDirectory("~/projects")).toBe(path.join(home, "projects"));
  });

  it("expands bare ~ to home directory", () => {
    expect(expandHomeDirectory("~")).toBe(os.homedir());
  });

  it("passes through paths that do not start with ~", () => {
    expect(expandHomeDirectory("/absolute/path")).toBe("/absolute/path");
    expect(expandHomeDirectory("relative/path")).toBe("relative/path");
  });

  it("handles ~\\ style paths (Windows backslash)", () => {
    const home = os.homedir();
    expect(expandHomeDirectory("~\\projects")).toBe(
      path.join(home, "projects"),
    );
  });

  it("does not expand ~user style paths", () => {
    // Only bare ~ and ~/ are expanded
    expect(expandHomeDirectory("~otheruser/file")).toBe("~otheruser/file");
  });
});

describe("resolveStorageRootDirectory", () => {
  it("resolves an absolute path as-is", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "step-test-resolve-"),
    );
    try {
      const result = resolveStorageRootDirectory(tmpDir, "/absolute/storage");
      expect(result).toBe(path.resolve("/absolute/storage"));
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it("resolves a relative path against workspaceRoot", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "step-test-relative-"),
    );
    try {
      const result = resolveStorageRootDirectory(tmpDir, "storage/data");
      expect(result).toBe(path.resolve(tmpDir, "storage/data"));
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it("expands ~ and resolves against home", () => {
    const home = os.homedir();
    const result = resolveStorageRootDirectory(
      "/some/workspace",
      "~/mystorage",
    );
    expect(result).toBe(path.resolve(path.join(home, "mystorage")));
  });

  it("resolves . as workspace root for relative path", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "step-test-dot-"));
    try {
      const result = resolveStorageRootDirectory(tmpDir, ".");
      expect(result).toBe(path.resolve(tmpDir));
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});
