import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// tool-plugin.ts
// ---------------------------------------------------------------------------
import { createMcpToolsPlugin } from "./tool-plugin.js";

// ===========================================================================
// createMcpToolsPlugin
// ===========================================================================
describe("createMcpToolsPlugin", () => {
  it("returns a plugin with correct id", () => {
    const mockManager = {
      getDependencies: vi.fn(() => []),
      getToolSpecs: vi.fn(() => []),
    };
    const plugin = createMcpToolsPlugin(mockManager);
    expect(plugin.id).toBe("mcp-tools");
  });

  it("returns a plugin with correct description", () => {
    const mockManager = {
      getDependencies: vi.fn(() => []),
      getToolSpecs: vi.fn(() => []),
    };
    const plugin = createMcpToolsPlugin(mockManager);
    expect(plugin.description).toBe(
      "Built-in MCP tools loaded from configured stdio servers",
    );
  });

  it("returns dependencies from the manager", () => {
    const deps = [{ type: "mcp", value: "server1", description: "stdio:cmd" }];
    const mockManager = {
      getDependencies: vi.fn(() => deps),
      getToolSpecs: vi.fn(() => []),
    };
    const plugin = createMcpToolsPlugin(mockManager);
    expect(plugin.dependencies).toEqual(deps);
    expect(mockManager.getDependencies).toHaveBeenCalledOnce();
  });

  it("register returns tool specs from the manager", () => {
    const specs = [
      {
        definition: {
          type: "function" as const,
          function: {
            name: "test__tool",
            description: "A test tool",
            parameters: { type: "object", properties: {} },
          },
        },
      },
    ];
    const mockManager = {
      getDependencies: vi.fn(() => []),
      getToolSpecs: vi.fn(() => specs as any),
    };
    const plugin = createMcpToolsPlugin(mockManager);
    const result = plugin.register({} as any);
    expect(result).toEqual(specs);
    expect(mockManager.getToolSpecs).toHaveBeenCalledOnce();
  });

  it("handles empty dependencies", () => {
    const mockManager = {
      getDependencies: vi.fn(() => []),
      getToolSpecs: vi.fn(() => []),
    };
    const plugin = createMcpToolsPlugin(mockManager);
    expect(plugin.dependencies).toEqual([]);
  });

  it("handles empty tool specs", () => {
    const mockManager = {
      getDependencies: vi.fn(() => []),
      getToolSpecs: vi.fn(() => []),
    };
    const plugin = createMcpToolsPlugin(mockManager);
    const result = plugin.register({} as any);
    expect(result).toEqual([]);
  });
});
