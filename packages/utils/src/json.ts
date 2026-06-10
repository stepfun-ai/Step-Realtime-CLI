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
