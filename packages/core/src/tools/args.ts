export function parseJsonObject(rawArgs: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    throw new Error(`Tool arguments must be a JSON object: ${rawArgs}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

export function readStringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function readRequiredStringField(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return value;
}

export function readIntegerField(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  throw new Error(`${field} must be an integer`);
}

export function readBooleanField(
  value: unknown,
  field: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  throw new Error(`${field} must be a boolean`);
}

export function readObjectField(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${field} must be an object`);
}
