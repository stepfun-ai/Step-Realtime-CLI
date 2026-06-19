import { describe, expect, it } from "vitest";
import {
  buildCollapsedToolSummary,
  buildToolTranscriptLines,
} from "./tool-call-collapsible.js";
import type { StepCliTuiTranscriptEntry } from "./types.js";

function makeToolEntry(
  content: string,
  caption: string | null = "Bash",
): StepCliTuiTranscriptEntry {
  return {
    id: "test-tool-id",
    role: "tool",
    caption,
    content,
  };
}

describe("buildCollapsedToolSummary", () => {
  it("returns status and first detail in headline", () => {
    const entry = makeToolEntry(
      "[completed] completed\nargs ls -la\nresult line 1\nresult line 2",
    );
    const summary = buildCollapsedToolSummary(entry);
    expect(summary.headline).toBe("Bash · [completed] args ls -la");
    expect(summary.previewLines).toEqual(["result line 1", "result line 2"]);
    expect(summary.hiddenLineCount).toBe(0);
  });

  it("reports hidden line count when content exceeds preview", () => {
    const entry = makeToolEntry(
      "[completed] completed\nargs ls -la\nline 1\nline 2\nline 3\nline 4",
    );
    const summary = buildCollapsedToolSummary(entry);
    expect(summary.previewLines).toEqual(["line 1", "line 2"]);
    expect(summary.hiddenLineCount).toBe(2);
    expect(summary.expandHint).toBe("... (2 more lines, ctrl-o to expand)");
  });

  it("truncates very long first detail lines", () => {
    const longCommand = "x".repeat(120);
    const entry = makeToolEntry(`[completed] completed\n${longCommand}`);
    const summary = buildCollapsedToolSummary(entry);
    expect(summary.headline).toBe(`Bash · [completed] ${"x".repeat(77)}...`);
    expect(summary.previewLines).toEqual([]);
    expect(summary.hiddenLineCount).toBe(0);
  });

  it("does not show expand hint for a single-line result", () => {
    const entry = makeToolEntry("[completed] completed");
    const summary = buildCollapsedToolSummary(entry);
    expect(summary.headline).toBe("Bash · [completed]");
    expect(summary.previewLines).toEqual([]);
    expect(summary.hiddenLineCount).toBe(0);
  });

  it("falls back to 'completed' when no status tag is present", () => {
    const entry = makeToolEntry("plain output\nmore output\nthird line");
    const summary = buildCollapsedToolSummary(entry);
    expect(summary.headline).toBe("Bash · [completed] plain output");
    expect(summary.previewLines).toEqual(["more output", "third line"]);
    expect(summary.hiddenLineCount).toBe(0);
  });
});

describe("buildToolTranscriptLines", () => {
  it("collapses tool entries by default with preview lines and hint", () => {
    const entry = makeToolEntry(
      "[completed] completed\nargs ls -la\nline 1\nline 2\nline 3",
    );
    const lines = buildToolTranscriptLines(entry, false);
    expect(lines).toEqual([
      "Bash · [completed] args ls -la",
      "line 1",
      "line 2",
      "... (1 more line, ctrl-o to expand)",
    ]);
  });

  it("expands tool entries when requested", () => {
    const entry = makeToolEntry("[completed] completed\nline 1\nline 2");
    const lines = buildToolTranscriptLines(entry, true);
    expect(lines.join("\n")).toContain("line 1");
    expect(lines.join("\n")).toContain("line 2");
  });

  it("does not show expand hint when everything fits in preview", () => {
    const entry = makeToolEntry("[completed] completed\nargs ls -la\nline 1");
    const lines = buildToolTranscriptLines(entry, false);
    expect(lines).toEqual(["Bash · [completed] args ls -la", "line 1"]);
  });
});
