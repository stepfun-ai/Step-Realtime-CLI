/**
 * Tiny hand-rolled runtime validators used by the native preset tool specs.
 * Keeps `packages/core` zero-extra-dep (no zod) while still removing the
 * `args as { ... }` casts that previously sat at the top of every execute().
 */

export class ToolArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgError";
  }
}

export function asObject(
  raw: unknown,
  toolName: string,
): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ToolArgError(`${toolName}: expected an object payload`);
  }
  return raw as Record<string, unknown>;
}

export function requireString(
  obj: Record<string, unknown>,
  key: string,
  toolName: string,
): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolArgError(
      `${toolName}: required string field "${key}" is missing or empty`,
    );
  }
  return value;
}

export function optionalString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ToolArgError(`field "${key}" must be a string when present`);
  }
  return value;
}

export function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolArgError(
      `field "${key}" must be a finite number when present`,
    );
  }
  return value;
}

export function optionalBoolean(
  obj: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ToolArgError(`field "${key}" must be a boolean when present`);
  }
  return value;
}
