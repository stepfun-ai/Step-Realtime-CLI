export type AgentHarnessKind = "main" | "subagent" | "teammate";

export type AgentWorkspaceMode = "shared" | "isolated";

export type AgentMemoryMode = "session" | "fresh" | "persistent";

export type AgentPriority =
  | "interactive"
  | "delegated"
  | "background"
  | "maintenance";

export interface AgentExecutionProfile {
  workspaceMode: AgentWorkspaceMode;
  memoryMode: AgentMemoryMode;
  priority: AgentPriority;
}

export type AgentExecutionProfileOverrides = Partial<AgentExecutionProfile>;

export interface PersistedExecutionProfile {
  workspaceMode: AgentWorkspaceMode;
  memoryMode?: AgentMemoryMode;
  priority?: AgentPriority;
}
