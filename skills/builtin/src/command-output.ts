import { sanitizeTerminalText } from "@step-cli/utils/terminal-text.js";

export interface RenderCommandOutputInput {
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  timeoutMs?: number;
  sanitize?: boolean;
}

export function renderCommandOutput(input: RenderCommandOutputInput): string {
  const lines: string[] = [];
  lines.push(`exit_code: ${input.exitCode}`);
  lines.push(`timed_out: ${input.timedOut}`);

  const stdout = input.sanitize
    ? sanitizeTerminalText(input.stdout, {
        preserveNewlines: true,
        preserveTabs: true,
      })
    : input.stdout;
  const stderr = input.sanitize
    ? sanitizeTerminalText(input.stderr, {
        preserveNewlines: true,
        preserveTabs: true,
      })
    : input.stderr;

  if (stdout.trim().length > 0) {
    lines.push("stdout:");
    lines.push(stdout);
  }

  if (stderr.trim().length > 0) {
    lines.push("stderr:");
    lines.push(stderr);
  }

  if (input.timedOut && typeof input.timeoutMs === "number") {
    lines.push(`note: Process killed after timeout (${input.timeoutMs}ms).`);
  }

  return lines.join("\n");
}

export function enforceOutputLimit(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  const tail = Math.floor(limit * 0.6);
  const head = Math.max(0, limit - tail);
  return `${value.slice(0, head)}\n...[truncated ${value.length - limit} chars]...\n${value.slice(value.length - tail)}`;
}
