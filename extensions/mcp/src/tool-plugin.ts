import type { ToolPlugin } from "@step-cli/core/plugins/types.js";
import type { ToolDependency, ToolSpec } from "@step-cli/protocol";

interface McpToolCatalog {
  getDependencies(): ToolDependency[];
  getToolSpecs(): ToolSpec[];
}

export function createMcpToolsPlugin(manager: McpToolCatalog): ToolPlugin {
  return {
    id: "mcp-tools",
    description: "Built-in MCP tools loaded from configured stdio servers",
    dependencies: manager.getDependencies(),
    register: () => manager.getToolSpecs(),
  };
}
