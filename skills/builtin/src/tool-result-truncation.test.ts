import { describe, it, expect } from "vitest";
import { applyToolResultTruncationHint } from "./tool-result-truncation.js";

// ---------------------------------------------------------------------------
// tool-result-truncation.ts
// ---------------------------------------------------------------------------

describe("applyToolResultTruncationHint", () => {
  it("returns content unchanged when within maxChars", () => {
    const result = applyToolResultTruncationHint({
      toolName: "read_file",
      summary: "file content",
      content: "hello world",
      maxChars: 100,
    });

    expect(result.summary).toBe("file content");
    expect(result.content).toBe("hello world");
    expect(result.truncation).toBeUndefined();
  });

  it("truncates content exceeding maxChars and includes banner for read_file", () => {
    const content = "a".repeat(2000);
    const result = applyToolResultTruncationHint({
      toolName: "read_file",
      summary: "file content",
      content,
      maxChars: 500,
    });

    expect(result.summary).toBe("file content (truncated)");
    expect(result.content).toContain("read_file output is truncated");
    expect(result.content).toContain(
      "narrow start_line/end_line or increase max_chars",
    );
    expect(result.truncation).toBeDefined();
  });

  it("truncates content exceeding maxChars and includes banner for run_command", () => {
    const content = "a".repeat(2000);
    const result = applyToolResultTruncationHint({
      toolName: "run_command",
      summary: "command output",
      content,
      maxChars: 500,
    });

    expect(result.summary).toBe("command output (truncated)");
    expect(result.content).toContain("run_command output is truncated");
    expect(result.content).toContain(
      "narrow the command output or increase max_output_chars",
    );
    expect(result.truncation).toBeDefined();
  });

  it("does not double-append (truncated) to summary", () => {
    const content = "a".repeat(200);
    const result = applyToolResultTruncationHint({
      toolName: "read_file",
      summary: "file content (truncated)",
      content,
      maxChars: 50,
    });

    expect(result.summary).toBe("file content (truncated)");
  });

  it("produces content no longer than maxChars when prefix is too large", () => {
    const content = "a".repeat(200);
    const result = applyToolResultTruncationHint({
      toolName: "read_file",
      summary: "summary",
      content,
      maxChars: 5,
    });

    expect(result.content!.length).toBeLessThanOrEqual(5);
  });

  it("returns content unchanged when exactly at maxChars", () => {
    const content = "a".repeat(100);
    const result = applyToolResultTruncationHint({
      toolName: "read_file",
      summary: "summary",
      content,
      maxChars: 100,
    });

    expect(result.content).toBe(content);
    expect(result.truncation).toBeUndefined();
  });
});
