import type { StepCliTuiTranscriptEntry } from "./types.js";

export const REASONING_PREVIEW_LINES = 2;

// Reasoning content can carry CRLF/CR line endings; normalize before
// splitting so no stray \r reaches the renderer.
function splitContentLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

export interface CollapsedReasoningSummary {
  previewLines: string[];
  hiddenLineCount: number;
  expandHint: string;
}

export function buildCollapsedReasoningSummary(
  entry: StepCliTuiTranscriptEntry,
): CollapsedReasoningSummary {
  const lines = splitContentLines(entry.content)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const previewLines = lines.slice(0, REASONING_PREVIEW_LINES);
  const hiddenLineCount = Math.max(0, lines.length - REASONING_PREVIEW_LINES);

  const expandHint =
    hiddenLineCount === 1
      ? "... (1 more line, ctrl-o to expand)"
      : `... (${hiddenLineCount} more lines, ctrl-o to expand)`;

  return {
    previewLines,
    hiddenLineCount,
    expandHint,
  };
}

export function buildReasoningTranscriptLines(
  entry: StepCliTuiTranscriptEntry,
  expanded: boolean,
): string[] {
  if (expanded) {
    return splitContentLines(entry.content);
  }

  const summary = buildCollapsedReasoningSummary(entry);
  const collapsedLines = [...summary.previewLines];
  if (summary.hiddenLineCount > 0) {
    collapsedLines.push(summary.expandHint);
  }
  return collapsedLines;
}
