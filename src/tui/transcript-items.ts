import { visibleLength } from "@step-cli/utils/display-width.js";
import type { StepCliTuiThemeColors } from "./theme.js";
import { compactToolTranscriptContent } from "./transcript-preview.js";
import { buildReasoningTranscriptLines } from "./reasoning-collapsible.js";
import { buildToolTranscriptLines } from "./tool-call-collapsible.js";
import type { StepCliTuiTone, StepCliTuiTranscriptEntry } from "./types.js";

export interface TranscriptItem {
  id: string;
  badge: string;
  caption: string | null;
  tone: StepCliTuiTone;
  backgroundColor: string | null;
  border: boolean;
  lines: string[];
  content: string;
  useMarkdown: boolean;
  streaming: boolean;
  truncated: boolean;
  collapsible?: boolean;
  expanded?: boolean;
}

export function buildTranscriptItems(
  entries: StepCliTuiTranscriptEntry[],
  width: number,
  theme: StepCliTuiThemeColors,
  toolOutputExpanded: boolean,
): TranscriptItem[] {
  return [
    buildWelcomeTranscriptItem(width),
    ...entries
      .filter((entry) => !entry.hidden)
      .map((entry, index) => {
        const identity = resolveTranscriptIdentity(entry);
        const body = compactToolTranscriptContent(entry);
        const markdown = entry.role === "assistant";
        const isTool = entry.role === "tool";
        const isReasoning = entry.role === "reasoning";
        const collapsible = isTool || isReasoning;
        const contentWidth = Math.max(12, width - 4);
        const lines = markdown
          ? []
          : (collapsible
              ? isTool
                ? buildToolTranscriptLines(entry, toolOutputExpanded)
                : buildReasoningTranscriptLines(entry, toolOutputExpanded)
              : [body]
            ).flatMap((line) => wrapMultiline(line, contentWidth));
        return {
          id:
            entry.id ||
            `message:${index}:${identity.badge}:${identity.caption ?? ""}`,
          ...identity,
          backgroundColor: resolveTranscriptBackground(entry, theme),
          border: false,
          lines,
          content: body,
          useMarkdown: markdown,
          streaming: markdown && entry.streaming === true,
          truncated: false,
          collapsible,
          expanded: collapsible ? toolOutputExpanded : undefined,
        };
      }),
  ];
}

export function buildWelcomeTranscriptItem(width: number): TranscriptItem {
  const welcomeLines = [
    "Welcome to STEP.",
    "Start with a prompt, or use /attach to queue an image.",
    "Enter send · Shift+Enter newline · Ctrl+Y or /copy copy selection/full transcript · Ctrl+O expand/collapse tool & reasoning output · Esc quit",
    "/goal /attach /copy /detach /status /refresh /theme [name] /resume <session_id> /exit",
  ].flatMap((line) => wrapMultiline(line, Math.max(12, width - 4)));

  return {
    id: "welcome",
    badge: "STEP",
    caption: "welcome",
    tone: "brand",
    lines: welcomeLines,
    content: "",
    useMarkdown: false,
    streaming: false,
    truncated: false,
    backgroundColor: null,
    border: true,
  };
}

export function resolveTranscriptIdentity(
  entry: StepCliTuiTranscriptEntry,
): Pick<TranscriptItem, "badge" | "caption" | "tone"> {
  switch (entry.role) {
    case "assistant":
      return {
        badge: "STEP",
        caption: entry.caption,
        tone: "brand",
      };
    case "user":
      return {
        badge: "YOU",
        caption: entry.caption,
        tone: "accent",
      };
    case "tool":
      return {
        badge: "TOOL",
        caption: entry.caption,
        tone: "success",
      };
    case "reasoning":
      return {
        badge: "THINK",
        caption: entry.caption,
        tone: "muted",
      };
    case "system":
      return {
        badge: "SYSTEM",
        caption: entry.caption,
        tone: "muted",
      };
  }
}

export function resolveTranscriptBackground(
  entry: StepCliTuiTranscriptEntry,
  theme: StepCliTuiThemeColors,
): string | null {
  return entry.role === "user" ? theme.inputBackground : null;
}

export function wrapMultiline(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length === 0) {
      lines.push("");
      continue;
    }

    let remaining = rawLine;
    while (visibleLength(remaining) > width) {
      const line = sliceByDisplayWidth(remaining, width);
      lines.push(line);
      remaining = remaining.slice(line.length);
    }
    lines.push(remaining);
  }

  return lines;
}

export function sliceByDisplayWidth(value: string, width: number): string {
  if (visibleLength(value) <= width) {
    return value;
  }

  let end = 0;
  for (const symbol of value) {
    if (visibleLength(value.slice(0, end + symbol.length)) > width) {
      break;
    }
    end += symbol.length;
  }

  return value.slice(0, Math.max(1, end));
}
