import type { ToolExecutionResult } from "@step-cli/protocol";
import { truncateText } from "@step-cli/utils/text.js";

const TRUNCATED_SUMMARY_SUFFIX = " (truncated)";

const TRUNCATION_HINTS = {
  read_file: {
    banner:
      "WARNING: read_file output is truncated. This is not the full file content.",
    continuation:
      "To continue, narrow start_line/end_line or increase max_chars and call read_file again.",
  },
  run_command: {
    banner:
      "WARNING: run_command output is truncated. This is not the full command output.",
    continuation:
      "To continue, narrow the command output or increase max_output_chars and call run_command again.",
  },
} as const;

type SupportedTruncatedToolName = keyof typeof TRUNCATION_HINTS;

export function applyToolResultTruncationHint(input: {
  toolName: SupportedTruncatedToolName;
  summary: string;
  content: string;
  maxChars: number;
}): Pick<ToolExecutionResult, "summary" | "content" | "truncation"> {
  if (input.content.length <= input.maxChars) {
    return {
      summary: input.summary,
      content: input.content,
    };
  }

  const prefix = renderTruncatedPrefix(input.toolName);
  const hintedPayload = truncateText({
    text: input.content,
    maxChars: Math.max(0, input.maxChars - prefix.length),
    strategy: "head_tail",
    exactMaxChars: true,
  });

  return {
    summary: appendTruncatedSummary(input.summary),
    content:
      prefix.length >= input.maxChars
        ? prefix.slice(0, input.maxChars)
        : `${prefix}${hintedPayload.text}`,
    truncation: hintedPayload.truncation,
  };
}

function appendTruncatedSummary(summary: string): string {
  if (summary.includes(TRUNCATED_SUMMARY_SUFFIX.trim())) {
    return summary;
  }
  return `${summary}${TRUNCATED_SUMMARY_SUFFIX}`;
}

function renderTruncatedPrefix(toolName: SupportedTruncatedToolName): string {
  const hint = TRUNCATION_HINTS[toolName];
  return `${hint.banner}\n${hint.continuation}\n\n`;
}
