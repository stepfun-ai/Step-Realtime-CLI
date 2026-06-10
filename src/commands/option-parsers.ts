import {
  describeToolPresentationProfileInputs,
  parseToolPresentationProfile as parseNormalizedToolPresentationProfile,
} from "@step-cli/core/tools/presentation-profile.js";
import type {
  AgentOperatingMode,
  SystemPromptProfile,
  ToolDescriptionStyle,
  ToolPermissionMode,
  ToolPresentationProfile,
  ToolSearchIndexProfile,
} from "@step-cli/protocol";
import { MIN_ANTHROPIC_THINKING_BUDGET_TOKENS } from "../bootstrap/config/defaults.js";

export class InvalidArgumentError extends Error {}

export function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, got: ${value}`);
  }
  return parsed;
}

export function parseOperatingMode(value: string): AgentOperatingMode {
  if (value === "normal" || value === "plan") {
    return value;
  }
  throw new InvalidArgumentError(
    `Unsupported operating mode: ${value}. Expected normal or plan.`,
  );
}

export function parseNonNegativeInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected non-negative integer, got: ${value}`);
  }
  return parsed;
}

export function parseAnthropicThinkingBudgetTokens(value: string): number {
  const parsed = parsePositiveInt(value);
  if (parsed < MIN_ANTHROPIC_THINKING_BUDGET_TOKENS) {
    throw new InvalidArgumentError(
      `Expected a value >= ${MIN_ANTHROPIC_THINKING_BUDGET_TOKENS}, received: ${value}`,
    );
  }
  return parsed;
}

export function parseOpenAIReasoningEffort(
  value: string,
): "minimal" | "low" | "medium" | "high" {
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
  ) {
    return value;
  }
  throw new InvalidArgumentError(
    `Expected one of: minimal, low, medium, high. Received: ${value}`,
  );
}

export function parseSystemPromptProfile(value: string): SystemPromptProfile {
  if (value === "default" || value === "minimal") {
    return value;
  }
  throw new InvalidArgumentError(
    `Expected one of: default, minimal. Received: ${value}`,
  );
}

export function parseToolPresentationProfile(
  value: string,
): ToolPresentationProfile {
  const parsed = parseNormalizedToolPresentationProfile(value);
  if (parsed) {
    return parsed;
  }
  throw new InvalidArgumentError(
    `Expected ${describeToolPresentationProfileInputs()}. Received: ${value}`,
  );
}

export function parseToolDescriptionStyle(value: string): ToolDescriptionStyle {
  if (value === "canonical" || value === "simple") {
    return value;
  }
  throw new InvalidArgumentError(
    `Expected one of: canonical, simple. Received: ${value}`,
  );
}

export function parseToolSearchIndexProfile(
  value: string,
): ToolSearchIndexProfile {
  if (value === "presented" || value === "canonical") {
    return value;
  }
  throw new InvalidArgumentError(
    `Expected one of: presented, canonical. Received: ${value}`,
  );
}

export function parseNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected number, got: ${value}`);
  }
  return parsed;
}

export function parseApprovalMode(
  value: string,
): "confirm" | "auto" | "strict" {
  if (value === "confirm" || value === "auto" || value === "strict") {
    return value;
  }
  throw new Error(
    `Unsupported approval mode: ${value}. Expected one of: confirm, auto, strict`,
  );
}

export function parseNonInteractiveApproval(value: string): "allow" | "deny" {
  if (value === "allow" || value === "deny") {
    return value;
  }
  throw new Error(
    `Unsupported non-interactive approval mode: ${value}. Expected one of: allow, deny`,
  );
}

export function parseConfigScope(value: string): "user" | "workspace" {
  if (value === "user" || value === "workspace") {
    return value;
  }
  throw new Error(
    `Unsupported config scope: ${value}. Expected one of: user, workspace`,
  );
}

export function collectToolOverride(
  value: string,
  previous: Record<string, ToolPermissionMode>,
): Record<string, ToolPermissionMode> {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator >= value.length - 1) {
    throw new Error(
      `Invalid --tool-override format: ${value}. Expected <tool=allow|confirm|deny>`,
    );
  }

  const tool = value.slice(0, separator).trim();
  const mode = value.slice(separator + 1).trim();

  if (!tool) {
    throw new Error(`Invalid tool name in --tool-override: ${value}`);
  }

  if (mode !== "allow" && mode !== "confirm" && mode !== "deny") {
    throw new Error(`Invalid tool permission mode in --tool-override: ${mode}`);
  }

  return {
    ...previous,
    [tool]: mode,
  };
}

export function collectRepeatedString(
  value: string,
  previous: string[] | undefined,
): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidArgumentError("Expected a non-empty value");
  }

  return [...(previous ?? []), trimmed];
}
