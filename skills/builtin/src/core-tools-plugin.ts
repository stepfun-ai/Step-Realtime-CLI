import type { ToolPlugin } from "@step-cli/core/plugins/types.js";
import { createApplyPatchTool } from "./apply-patch-tool.js";
import { createCommandTool } from "./command-tool.js";
import { createFindToolsTool } from "./discovery-tool.js";
import { createFileTools } from "./file-tools.js";

export interface CoreToolsPluginOptions {}

export function createCoreToolsPlugin(
  _options: CoreToolsPluginOptions = {},
): ToolPlugin {
  return {
    id: "core-tools",
    description: "Built-in file and command tools",
    register: () => [
      ...createFileTools(),
      createApplyPatchTool(),
      createCommandTool(),
      createFindToolsTool(),
    ],
  };
}

export const coreToolsPlugin = createCoreToolsPlugin();
