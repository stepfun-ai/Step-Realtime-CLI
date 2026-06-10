import type { StepCliTuiTranscriptEntry } from "./types.js";

export const MAX_TOOL_RESULT_PREVIEW_LINES = 3;

export function compactToolTranscriptContent(
  entry: Pick<StepCliTuiTranscriptEntry, "role" | "content">,
): string {
  if (entry.role !== "tool") {
    return entry.content;
  }

  const lines = entry.content
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
  let resultLineIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? "").trim() === "Result:") {
      resultLineIndex = index;
      break;
    }
  }

  if (resultLineIndex < 0) {
    return entry.content;
  }

  const resultLines = lines.slice(resultLineIndex + 1);
  if (resultLines.length <= MAX_TOOL_RESULT_PREVIEW_LINES) {
    return entry.content;
  }

  const hiddenLineCount = resultLines.length - MAX_TOOL_RESULT_PREVIEW_LINES;
  const hiddenLineLabel =
    hiddenLineCount === 1
      ? "... 1 more line"
      : `... ${hiddenLineCount} more lines`;

  return [
    ...lines.slice(0, resultLineIndex + 1),
    ...resultLines.slice(0, MAX_TOOL_RESULT_PREVIEW_LINES),
    hiddenLineLabel,
  ].join("\n");
}
