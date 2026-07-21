import { describe, expect, it } from "vitest";
import {
  buildCollapsedReasoningSummary,
  buildReasoningTranscriptLines,
} from "./reasoning-collapsible.js";
import type { StepCliTuiTranscriptEntry } from "./types.js";

function makeReasoningEntry(content: string): StepCliTuiTranscriptEntry {
  return {
    id: "test-reasoning-id",
    role: "reasoning",
    caption: null,
    content,
  };
}

describe("buildCollapsedReasoningSummary", () => {
  it("shows all lines when content is within preview limit", () => {
    const entry = makeReasoningEntry("line 1\nline 2");
    const summary = buildCollapsedReasoningSummary(entry);
    expect(summary.previewLines).toEqual(["line 1", "line 2"]);
    expect(summary.hiddenLineCount).toBe(0);
  });

  it("reports hidden line count when content exceeds preview", () => {
    const entry = makeReasoningEntry("line 1\nline 2\nline 3\nline 4");
    const summary = buildCollapsedReasoningSummary(entry);
    expect(summary.previewLines).toEqual(["line 1", "line 2"]);
    expect(summary.hiddenLineCount).toBe(2);
    expect(summary.expandHint).toBe("... (2 more lines, ctrl-o to expand)");
  });

  it("uses singular hint when exactly one line is hidden", () => {
    const entry = makeReasoningEntry("line 1\nline 2\nline 3");
    const summary = buildCollapsedReasoningSummary(entry);
    expect(summary.hiddenLineCount).toBe(1);
    expect(summary.expandHint).toBe("... (1 more line, ctrl-o to expand)");
  });

  it("ignores empty lines when counting hidden lines", () => {
    const entry = makeReasoningEntry("line 1\nline 2\n\n\nline 3");
    const summary = buildCollapsedReasoningSummary(entry);
    expect(summary.previewLines).toEqual(["line 1", "line 2"]);
    expect(summary.hiddenLineCount).toBe(1);
  });
});

describe("buildReasoningTranscriptLines", () => {
  it("collapses reasoning entries by default with preview lines and hint", () => {
    const entry = makeReasoningEntry("line 1\nline 2\nline 3\nline 4");
    const lines = buildReasoningTranscriptLines(entry, false);
    expect(lines).toEqual([
      "line 1",
      "line 2",
      "... (2 more lines, ctrl-o to expand)",
    ]);
  });

  it("expands reasoning entries when requested", () => {
    const entry = makeReasoningEntry("line 1\nline 2\nline 3");
    const lines = buildReasoningTranscriptLines(entry, true);
    expect(lines).toEqual(["line 1", "line 2", "line 3"]);
  });

  it("normalizes CRLF line endings when expanded", () => {
    const entry = makeReasoningEntry("line 1\r\nline 2\r\nline 3");
    const lines = buildReasoningTranscriptLines(entry, true);
    expect(lines).toEqual(["line 1", "line 2", "line 3"]);
  });

  it("does not show expand hint when everything fits in preview", () => {
    const entry = makeReasoningEntry("line 1\nline 2");
    const lines = buildReasoningTranscriptLines(entry, false);
    expect(lines).toEqual(["line 1", "line 2"]);
  });
});
