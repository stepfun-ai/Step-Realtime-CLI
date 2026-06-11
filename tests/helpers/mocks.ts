import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared mock factories for test suites
// ---------------------------------------------------------------------------

/**
 * Creates a mock LLM chat-completion client that cycles through `responses`.
 * Each call to `createChatCompletion` returns the next response in order.
 */
export function createMockClient(responses: any[] = []) {
  let index = 0;
  return {
    createChatCompletion: vi.fn(async () => {
      const response = responses[index % responses.length];
      index++;
      return response;
    }),
    recordUsage: vi.fn(),
  };
}

/**
 * Creates a mock tool runtime with configurable tool definitions and results.
 */
export function createMockToolRuntime(
  toolResults: Map<string, any> = new Map(),
) {
  return {
    getDefinitions: vi.fn(() => []),
    executeTool: vi.fn(async (name: string, args: any) => {
      const result = toolResults.get(name);
      if (result) return result;
      return { ok: true, summary: `mock result for ${name}` };
    }),
    inspectTool: vi.fn(() => ({ command: "" })),
    listToolNames: vi.fn(() => []),
    getCatalog: vi.fn(() => []),
    searchTools: vi.fn(() => []),
    getCodeModeToolBindings: vi.fn(() => []),
  };
}

/**
 * Returns a minimal default config object for agent setup.
 */
export function createMockConfig(overrides: Record<string, any> = {}) {
  return {
    model: "test-model",
    provider: "anthropic",
    maxSteps: 50,
    mode: "auto",
    nonInteractiveApproval: "deny",
    workspaceRoot: "/tmp/test-workspace",
    storageRoot: "/tmp/test-storage",
    ...overrides,
  };
}
