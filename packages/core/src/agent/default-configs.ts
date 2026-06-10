import type { AgentRunConfig } from "@step-cli/protocol";
import type { MemoryConfig } from "./conversation-memory.js";

/**
 * Process-wide defaults shared by gateway-style hosts (StepCli runtime) and
 * standalone in-process consumers (agent-sdk). Lives here so the two
 * call sites cannot drift on context-token budgets or compaction ratios.
 */

export const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
export const DEFAULT_MIN_OUTPUT_TOKENS = 256;
export const DEFAULT_OUTPUT_TOKEN_SAFETY_MARGIN = 512;
export const DEFAULT_MAX_STEPS = 32;
export const DEFAULT_MAX_TOOL_CALLS_PER_STEP = 16;
export const DEFAULT_REPEATED_TOOL_CALL_LIMIT = 6;
export const DEFAULT_MAX_TOOL_RESULT_CHARS_IN_CONTEXT = 8_000;
export const DEFAULT_MODEL_REQUEST_RETRIES = 2;
export const DEFAULT_TOOL_EXECUTION_RETRIES = 1;
export const DEFAULT_TEMPERATURE = 0;
export const DEFAULT_PARALLEL_TOOL_CALLS = false;

export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
export const DEFAULT_COMMAND_OUTPUT_LIMIT = 64_000;

/**
 * Build an AgentRunConfig with sensible defaults. Pass only the fields you
 * want to override; everything else picks up the DEFAULT_* constants above.
 */
export function buildDefaultRunConfig(
  overrides: Partial<AgentRunConfig> = {},
): AgentRunConfig {
  return {
    maxSteps: DEFAULT_MAX_STEPS,
    temperature: DEFAULT_TEMPERATURE,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    minOutputTokens: DEFAULT_MIN_OUTPUT_TOKENS,
    outputTokenSafetyMargin: DEFAULT_OUTPUT_TOKEN_SAFETY_MARGIN,
    parallelToolCalls: DEFAULT_PARALLEL_TOOL_CALLS,
    maxToolCallsPerStep: DEFAULT_MAX_TOOL_CALLS_PER_STEP,
    repeatedToolCallLimit: DEFAULT_REPEATED_TOOL_CALL_LIMIT,
    maxToolResultCharsInContext: DEFAULT_MAX_TOOL_RESULT_CHARS_IN_CONTEXT,
    modelRequestRetries: DEFAULT_MODEL_REQUEST_RETRIES,
    toolExecutionRetries: DEFAULT_TOOL_EXECUTION_RETRIES,
    ...overrides,
  };
}

/**
 * Derive a MemoryConfig from a resolved AgentRunConfig. The ratios and caps
 * here mirror the gateway-side defaults that have shipped with the CLI for
 * months; agent-sdk and gateway should never diverge on these numbers.
 */
export function buildDefaultMemoryConfig(
  runConfig: AgentRunConfig,
): MemoryConfig {
  return {
    maxContextTokens: runConfig.maxContextTokens,
    reserveOutputTokens:
      runConfig.maxOutputTokens + runConfig.outputTokenSafetyMargin,
    minRecentMessages: 10,
    compressionTriggerRatio: 0.85,
    compressionTargetRatio: 0.55,
    emergencyCompressionTriggerRatio: 0.95,
    emergencyCompressionTargetRatio: 0.2,
    maxSummaryChars: 16_000,
    maxSummaryTokens: 4_000,
    compactedUserMessageTokenBudget: Math.max(
      2_000,
      Math.min(20_000, Math.floor(runConfig.maxContextTokens * 0.16)),
    ),
    maxCompactedUserMessages: 16,
    compactedUserMessageMaxChars: 6_000,
    maxDecisionEntries: 80,
    decisionEntryMaxChars: 220,
    microCompactKeepRecentToolMessages: 8,
    microCompactToolContentChars: Math.max(
      1_200,
      Math.floor(runConfig.maxToolResultCharsInContext * 0.8),
    ),
  };
}
