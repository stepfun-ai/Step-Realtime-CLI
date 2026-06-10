import type {
  AgentExecutionProfileOverrides,
  AgentHarnessKind,
} from "./runtime-context-types.js";

export interface StepCliAgentPresetConfig {
  name: string;
  description?: string;
  targetHarnessKind: Exclude<AgentHarnessKind, "main">;
  promptAppendix?: string;
  allowedTools?: string[];
  executionProfileOverride?: AgentExecutionProfileOverrides;
  hidden?: boolean;
  defaultRole?: string;
}
