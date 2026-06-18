import { describe, it, expect } from "vitest";
import {
  DEFAULT_MODEL,
  DEFAULT_BASE_URL,
  BUILTIN_CLI_DEFAULTS,
  BUILTIN_STORAGE_LAYOUT_DEFAULTS,
  BUILTIN_SERVICE_DEFAULTS,
  MIN_ANTHROPIC_THINKING_BUDGET_TOKENS,
} from "./defaults.js";

describe("defaults", () => {
  it("DEFAULT_MODEL is set", () => {
    expect(DEFAULT_MODEL).toBe("step/native");
  });

  it("DEFAULT_BASE_URL points to stepfun", () => {
    expect(DEFAULT_BASE_URL).toContain("stepfun.com");
  });

  it("BUILTIN_CLI_DEFAULTS has reasonable values", () => {
    expect(BUILTIN_CLI_DEFAULTS.maxContextTokens).toBeGreaterThan(0);
    expect(BUILTIN_CLI_DEFAULTS.maxOutputTokens).toBeGreaterThan(0);
    expect(BUILTIN_CLI_DEFAULTS.temperature).toBeGreaterThanOrEqual(0);
    expect(BUILTIN_CLI_DEFAULTS.approvalMode).toBe("confirm");
    expect(BUILTIN_CLI_DEFAULTS.nonInteractiveApproval).toBe("deny");
    expect(BUILTIN_CLI_DEFAULTS.parallelToolCalls).toBe(true);
  });

  it("BUILTIN_STORAGE_LAYOUT_DEFAULTS is fully populated", () => {
    expect(BUILTIN_STORAGE_LAYOUT_DEFAULTS.workspaceTrustFile).toBeDefined();
    expect(BUILTIN_STORAGE_LAYOUT_DEFAULTS.sessionAssetsDir).toBeDefined();
    expect(BUILTIN_STORAGE_LAYOUT_DEFAULTS.sessionTranscriptsDir).toBeDefined();
  });

  it("BUILTIN_SERVICE_DEFAULTS has host and port", () => {
    expect(BUILTIN_SERVICE_DEFAULTS.host).toBe("127.0.0.1");
    expect(BUILTIN_SERVICE_DEFAULTS.port).toBe(47123);
  });

  it("MIN_ANTHROPIC_THINKING_BUDGET_TOKENS is 1024", () => {
    expect(MIN_ANTHROPIC_THINKING_BUDGET_TOKENS).toBe(1024);
  });
});
