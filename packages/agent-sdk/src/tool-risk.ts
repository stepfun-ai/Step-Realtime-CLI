import type { ToolRiskLevel } from "@step-cli/protocol";

/**
 * Risk classification for preset and built-in tool names. One source of truth
 * for both the canUseTool gate and the preset registration path so the three
 * places that previously hand-maintained the same data cannot drift.
 */
export const TOOL_RISK: Record<string, ToolRiskLevel> = {
  Read: "read",
  Glob: "read",
  Grep: "read",
  NotebookRead: "read",
  TaskGet: "read",
  TaskList: "read",
  ListMcpResources: "read",
  ReadMcpResource: "read",
  ExitPlanMode: "read",
  TodoWrite: "read",
  AskUserQuestion: "read",
  Task: "read",
  WebFetch: "read",
  WebSearch: "read",
  EnterWorktree: "read",
  ExitWorktree: "read",
  Edit: "write",
  Write: "write",
  MultiEdit: "write",
  NotebookEdit: "write",
  TaskCreate: "write",
  TaskUpdate: "write",
  Bash: "execute",
  BashOutput: "execute",
  KillBash: "execute",
};

const ACCEPT_EDITS_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

export function isAcceptEditsTool(toolName: string): boolean {
  return ACCEPT_EDITS_TOOLS.has(toolName);
}

export function riskForToolName(toolName: string): ToolRiskLevel {
  if (toolName.startsWith("mcp__")) return "write";
  return TOOL_RISK[toolName] ?? "read";
}
