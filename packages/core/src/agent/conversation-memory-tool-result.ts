import type { ChatMessage } from "@step-cli/protocol";
import { normalizeWhitespace, shortenLine } from "@step-cli/utils/text.js";
import type { ContextRotIssue } from "./conversation-memory.js";

interface ParsedToolResult {
  ok?: boolean;
  summary: string;
  error?: string;
  errorCode?: string;
  primaryPath?: string;
}

export function parseToolResult(raw: string): ParsedToolResult {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const summary =
      typeof parsed.summary === "string"
        ? parsed.summary
        : shortenLine(raw, 180);
    const ok = typeof parsed.ok === "boolean" ? parsed.ok : undefined;
    const errorMessage = extractErrorMessage(parsed.error);
    const errorCode = extractErrorCode(parsed.error);
    const primaryPath = extractPrimaryPath(parsed.data);

    return {
      ok,
      summary,
      error: errorMessage,
      errorCode,
      primaryPath,
    };
  } catch {
    return {
      summary: shortenLine(raw, 180),
    };
  }
}

export function extractToolSummary(raw: string): string {
  const parsed = parseToolResult(raw);
  if (parsed.summary.trim().length > 0) {
    return parsed.summary;
  }

  return shortenLine(raw, 180);
}

export function findRepeatedIssue(
  messages: ChatMessage[],
): ContextRotIssue | undefined {
  const counts = new Map<string, ContextRotIssue>();
  const recentMessages = messages.slice(Math.max(0, messages.length - 40));

  for (const message of recentMessages) {
    if (message.role !== "tool") {
      continue;
    }

    const parsed = parseToolResult(message.content);
    if (parsed.ok !== false && !parsed.error) {
      continue;
    }

    const signature = normalizeIssueSignature(parsed);
    if (!signature) {
      continue;
    }

    const existing = counts.get(signature);
    if (existing) {
      existing.count += 1;
      continue;
    }

    counts.set(signature, {
      signature,
      count: 1,
    });
  }

  let best: ContextRotIssue | undefined;
  for (const issue of counts.values()) {
    if (!best || issue.count > best.count) {
      best = issue;
    }
  }

  return best;
}

export function normalizeIssueSignature(parsed: {
  summary: string;
  error?: string;
  errorCode?: string;
}): string {
  const raw = parsed.errorCode ?? parsed.error ?? parsed.summary;
  return normalizeWhitespace(raw).toLowerCase().slice(0, 160);
}

export function isAlreadyCompactedToolResult(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed.compacted_tool_result === true;
  } catch {
    return false;
  }
}

export function extractPathFromToolArguments(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pathValue = parsed.path;
    return typeof pathValue === "string" ? pathValue : undefined;
  } catch {
    return undefined;
  }
}

export function extractPathCandidatesFromText(text: string): string[] {
  const matches = text.match(/[A-Za-z0-9._/-]*\/[A-Za-z0-9._/-]+/g) ?? [];
  return dedupeStringsKeepingNewest(matches.map((match) => match.trim())).slice(
    -6,
  );
}

function extractErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const message = candidate.message;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : undefined;
}

function extractErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const code = candidate.code;
  return typeof code === "string" && code.trim().length > 0 ? code : undefined;
}

function extractPrimaryPath(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const pathValue = candidate.path;
  if (typeof pathValue === "string") {
    return pathValue;
  }

  return undefined;
}

function dedupeStringsKeepingNewest(values: string[]): string[] {
  const seen = new Set<string>();
  const dedupedReversed: string[] = [];

  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (!value) {
      continue;
    }

    const key = normalizeWhitespace(value);
    if (key.length === 0 || seen.has(key)) {
      continue;
    }

    seen.add(key);
    dedupedReversed.push(value);
  }

  return dedupedReversed.reverse();
}
