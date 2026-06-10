export const UNLIMITED_MAX_STEPS: number = Number.POSITIVE_INFINITY;

const UNLIMITED_MAX_STEP_ALIASES: ReadonlySet<string> = new Set([
  "unlimited",
  "infinite",
  "infinity",
  "none",
]);

export function isUnlimitedMaxSteps(value: number): boolean {
  return !Number.isFinite(value);
}

export function formatMaxSteps(value: number): string {
  return isUnlimitedMaxSteps(value) ? "unlimited" : String(value);
}

export function parseMaxSteps(value: string): number {
  const normalized = value.trim().toLowerCase();
  if (UNLIMITED_MAX_STEP_ALIASES.has(normalized)) {
    return UNLIMITED_MAX_STEPS;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer or 'unlimited', got: ${value}`);
  }
  return parsed;
}

export function readConfiguredMaxSteps(
  value: unknown,
  fieldPath: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return parseMaxSteps(value);
  }
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  throw new Error(
    `Expected ${fieldPath} to be a positive integer or 'unlimited'`,
  );
}
