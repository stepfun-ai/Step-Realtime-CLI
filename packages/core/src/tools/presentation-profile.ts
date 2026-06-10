import type { ToolPresentationProfile } from "@step-cli/protocol";

export function parseToolPresentationProfile(
  value: string | null | undefined,
): ToolPresentationProfile | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (value === "grouped" || value === "compact") {
    return "grouped";
  }

  if (value === "raw" || value === "canonical") {
    return "raw";
  }

  if (value === "obfuscated") {
    return value;
  }

  return undefined;
}

export function normalizeToolPresentationProfile(
  value: string | null | undefined,
): ToolPresentationProfile {
  return parseToolPresentationProfile(value) ?? "grouped";
}

export function describeToolPresentationProfileOptions(): string {
  return "grouped, raw, or obfuscated";
}

export function describeToolPresentationProfileInputs(): string {
  return "grouped, raw, obfuscated (legacy aliases: compact, canonical)";
}
