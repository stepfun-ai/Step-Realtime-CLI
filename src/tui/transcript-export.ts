import type { StepCliTuiTranscriptEntry } from "./types.js";

export function buildTranscriptClipboardText(
  entries: readonly StepCliTuiTranscriptEntry[],
): string {
  return entries
    .map((entry) => formatTranscriptClipboardBlock(entry))
    .filter((block) => block.length > 0)
    .join("\n\n")
    .trim();
}

function formatTranscriptClipboardBlock(
  entry: StepCliTuiTranscriptEntry,
): string {
  const header = formatTranscriptClipboardHeader(entry);
  const content = entry.content.trimEnd();
  if (content.length === 0) {
    return header;
  }

  return `${header}\n${content}`;
}

function formatTranscriptClipboardHeader(
  entry: StepCliTuiTranscriptEntry,
): string {
  const caption = entry.caption?.trim();
  if (!caption) {
    return entry.role.toUpperCase();
  }

  return `${entry.role.toUpperCase()} ${caption}`;
}
