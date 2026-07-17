import { getHarnessContext } from "./harness-context.js";
import type {
  AgentPriority,
  AgentWorkspaceMode,
  AgentMemoryMode,
  AgentHarnessKind,
} from "../runtime-context-types.js";

export type AgentState =
  | "goal_start"
  | "prepare_context"
  | "before_model_request_hooks"
  | "context_compaction"
  | "model_request"
  | "tool_execution"
  | "apply_tool_results"
  | "final_response"
  | "goal_complete"
  | "failed";

export interface AgentStateSnapshot {
  state: AgentState;
  step: number;
  toolCalls: number;
  at: string;
  note?: string;
  harnessId?: string;
  harnessType?: AgentHarnessKind;
  harnessName?: string;
  sessionId?: string;
  goalId?: string;
  attemptId?: string;
  workspaceMode?: AgentWorkspaceMode;
  memoryMode?: AgentMemoryMode;
  priority?: AgentPriority;
}

const ALLOWED_TRANSITIONS: Record<AgentState, AgentState[]> = {
  goal_start: ["prepare_context", "failed"],
  prepare_context: ["model_request", "goal_complete", "failed"],
  before_model_request_hooks: ["model_request", "failed"],
  context_compaction: ["model_request", "failed"],
  model_request: ["tool_execution", "final_response", "goal_complete", "failed"],
  tool_execution: ["apply_tool_results", "model_request", "failed"],
  apply_tool_results: ["model_request", "final_response", "goal_complete", "failed"],
  final_response: ["goal_complete", "failed"],
  goal_complete: [],
  failed: [],
};

export class AgentStateMachine {
  private currentState: AgentState = "prepare_context";
  private readonly timeline: AgentStateSnapshot[] = [];
  private readonly maxTimelineSize: number;

  constructor(maxTimelineSize = 200) {
    this.maxTimelineSize = maxTimelineSize;
  }

  transition(input: {
    state: AgentState;
    step: number;
    toolCalls: number;
    note?: string;
  }): AgentStateSnapshot {
    if (input.state !== this.currentState) {
      const allowed = ALLOWED_TRANSITIONS[this.currentState];
      if (allowed && !allowed.includes(input.state)) {
        throw new Error(
          `Invalid state transition: ${this.currentState} -> ${input.state}`,
        );
      }
    }
    this.currentState = input.state;
    this.currentState = input.state;
    const context = getHarnessContext();
    const snapshot: AgentStateSnapshot = {
      state: input.state,
      step: input.step,
      toolCalls: input.toolCalls,
      note: input.note,
      at: new Date().toISOString(),
      harnessId: context?.id,
      harnessType: context?.kind,
      harnessName: context?.name,
      sessionId: context?.sessionId,
      goalId: context?.goalId,
      attemptId: context?.attemptId,
      workspaceMode: context?.executionProfile.workspaceMode,
      memoryMode: context?.executionProfile.memoryMode,
      priority: context?.executionProfile.priority,
    };
    this.timeline.push(snapshot);
    if (this.timeline.length > 200) {
      this.timeline.splice(0, this.timeline.length - 200);
    }
    return snapshot;
  }

  getCurrentState(): AgentState {
    return this.currentState;
  }

  getTimeline(): AgentStateSnapshot[] {
    return [...this.timeline];
  }
}
