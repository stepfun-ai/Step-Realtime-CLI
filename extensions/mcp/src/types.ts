import type { ToolPermissionMode, ToolRiskLevel } from "@step-cli/protocol";

export type StepCliMcpTransportType = "stdio";

export interface StepCliMcpServerConfig {
  type?: StepCliMcpTransportType;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled?: boolean;
  timeoutMs?: number;
  toolPrefix?: string;
  includeTools?: string[];
  excludeTools?: string[];
  risk?: ToolRiskLevel;
  defaultMode?: ToolPermissionMode;
}
