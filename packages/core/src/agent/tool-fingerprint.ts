import { createHash } from "node:crypto";

// Numeric arguments above this threshold collapse to a single placeholder in
// the fingerprint, so runaway escalation loops (e.g. timeout_ms 2e10 -> 2e37 ->
// 2e76 after each failure) count as repeated calls instead of fresh ones.
// Legitimate numeric arguments (timeouts, offsets, limits) stay far below it.
const HUGE_NUMBER_THRESHOLD = 1_000_000_000;
const HUGE_NUMBER_PLACEHOLDER = "__HUGE_NUMBER__";

export function createToolCallFingerprint(
  toolName: string,
  rawArgs: string,
): string {
  const normalizedArgs = normalizeToolArguments(rawArgs);
  const hash = createHash("sha1").update(normalizedArgs).digest("hex");
  return `${toolName}:${hash}`;
}

export function normalizeToolArguments(rawArgs: string): string {
  try {
    const parsed = JSON.parse(rawArgs) as unknown;
    return stableStringify(normalizeHugeNumbers(parsed));
  } catch {
    return rawArgs.replace(/\s+/g, " ").trim();
  }
}

function normalizeHugeNumbers(value: unknown): unknown {
  if (typeof value === "number") {
    return Number.isFinite(value) && Math.abs(value) > HUGE_NUMBER_THRESHOLD
      ? HUGE_NUMBER_PLACEHOLDER
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeHugeNumbers(entry));
  }
  if (value && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      normalized[key] = normalizeHugeNumbers(child);
    }
    return normalized;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortRecursively(value));
}

function sortRecursively(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortRecursively(entry));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    const sorted: Record<string, unknown> = {};
    for (const [key, child] of entries) {
      sorted[key] = sortRecursively(child);
    }
    return sorted;
  }

  return value;
}
