/**
 * JSON.parse wrapper that returns a fallback value on parse failure instead of
 * throwing. Useful at boundaries where untrusted strings flow in (tool
 * arguments, MCP payloads, persisted snapshots) and the caller wants to keep
 * making progress rather than crash.
 *
 * The fallback is also returned for null / undefined / empty / whitespace-only
 * input so callers don't need a separate emptiness guard.
 */
export function safeParseJson<T = unknown>(
  raw: string | null | undefined,
  fallback: T,
): T {
  if (raw === null || raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return fallback;
  }
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

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortRecursively(value));
}

export function normalizeToolArguments(rawArgs: string): string {
  try {
    const parsed = JSON.parse(rawArgs) as unknown;
    return stableStringify(parsed);
  } catch {
    return rawArgs.replace(/\s+/g, " ").trim();
  }
}
