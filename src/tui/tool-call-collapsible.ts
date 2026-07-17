import type { StepCliTuiTranscriptEntry } from "./types.js";

const COLLAPSED_TOOL_DETAIL_MAX_LENGTH = 80;
const TOOL_PREVIEW_LINES = 2;
const STATUS_LINE_RE = /^\[(\w+)\]\s*(.*)$/;

// Tool output on Windows can carry CRLF/CR line endings; normalize before
// splitting so no stray \r reaches the renderer.
function splitContentLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

export interface CollapsedToolSummary {
  headline: string;
  previewLines: string[];
  hiddenLineCount: number;
  expandHint: string;
}

export function buildCollapsedToolSummary(
  entry: StepCliTuiTranscriptEntry,
): CollapsedToolSummary {
  const caption = entry.caption ?? "tool";
  const lines = splitContentLines(entry.content);
  const firstLine = lines[0]?.trim() ?? "";
  const statusMatch = STATUS_LINE_RE.exec(firstLine);
  const status = statusMatch?.[1] ?? "completed";

  // Detail lines are everything after the status line, skipping empty lines.
  const detailStartIndex = statusMatch ? 1 : 0;
  const detailLines = lines
    .slice(detailStartIndex)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const firstDetail = detailLines[0]?.trim() ?? "";
  const trimmedFirstDetail =
    firstDetail.length > COLLAPSED_TOOL_DETAIL_MAX_LENGTH
      ? `${firstDetail.slice(0, COLLAPSED_TOOL_DETAIL_MAX_LENGTH - 3)}...`
      : firstDetail;

  const headline = trimmedFirstDetail
    ? `${caption} · [${status}] ${trimmedFirstDetail}`
    : `${caption} · [${status}]`;

  // Show the next N detail lines after the one already used in the headline.
  const previewLines = detailLines.slice(1, 1 + TOOL_PREVIEW_LINES);
  const hiddenLineCount = Math.max(
    0,
    detailLines.length - 1 - previewLines.length,
  );

  const expandHint =
    hiddenLineCount === 1
      ? "... (1 more line, ctrl-o to expand)"
      : `... (${hiddenLineCount} more lines, ctrl-o to expand)`;

  return {
    headline,
    previewLines,
    hiddenLineCount,
    expandHint,
  };
}

export function buildToolTranscriptLines(
  entry: StepCliTuiTranscriptEntry,
  expanded: boolean,
): string[] {
  if (expanded) {
    return splitContentLines(entry.content);
  }

  const summary = buildCollapsedToolSummary(entry);
  const collapsedLines = [summary.headline, ...summary.previewLines];
  if (summary.hiddenLineCount > 0) {
    collapsedLines.push(summary.expandHint);
  }
  return collapsedLines;
}
