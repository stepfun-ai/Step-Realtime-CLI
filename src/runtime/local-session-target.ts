import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import type { StepCliConfig } from "../gateway/runtime.js";
import { BUILTIN_CLI_DEFAULTS } from "../bootstrap/config/defaults.js";
import { readOptionalString } from "../commands/command-utils.js";

export function deriveSessionTarget(sessionFile: string | undefined): {
  sessionId: string;
} {
  const rawSessionFile =
    readOptionalString(sessionFile) ?? BUILTIN_CLI_DEFAULTS.sessionFile;
  const sessionId =
    path.basename(rawSessionFile, path.extname(rawSessionFile)) || "session";

  return {
    sessionId,
  };
}

export async function resolveLocalSessionTarget(
  config: Pick<StepCliConfig, "sessionFile" | "sessionId">,
): Promise<{
  sessionId: string;
}> {
  if (config.sessionId?.trim()) {
    return { sessionId: config.sessionId.trim() };
  }

  const selector =
    readOptionalString(config.sessionFile) ?? BUILTIN_CLI_DEFAULTS.sessionFile;
  if (selector !== BUILTIN_CLI_DEFAULTS.sessionFile) {
    return deriveSessionTarget(selector);
  }

  return {
    sessionId: buildDefaultLocalSessionId(),
  };
}

export function buildResumeCommand(
  config: Pick<StepCliConfig, "sessionId" | "workspaceRoot">,
): string {
  const sessionId = config.sessionId?.trim();
  if (!sessionId) {
    throw new Error("Resume command requires a session id");
  }

  const parts = ["step", "resume", quoteShellArg(sessionId)];

  const workspaceRoot = path.resolve(config.workspaceRoot);
  if (workspaceRoot !== process.cwd()) {
    parts.push("--workspace", quoteShellArg(workspaceRoot));
  }

  return parts.join(" ");
}

function buildDefaultLocalSessionId(): string {
  return randomUUID();
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
