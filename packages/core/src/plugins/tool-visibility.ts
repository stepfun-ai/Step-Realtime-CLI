import type { ToolPluginContext } from "./types.js";

export function isTopLevelMainHarness(context: ToolPluginContext): boolean {
  return context.harness.kind === "main" && context.harness.depth === 0;
}

export function isTeammateHarness(context: ToolPluginContext): boolean {
  return context.harness.kind === "teammate";
}
