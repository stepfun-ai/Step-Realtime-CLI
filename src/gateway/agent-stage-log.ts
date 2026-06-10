import type { AgentLoopAction } from "@step-cli/core/agent/agent-loop.js";
import type { AgentStateSnapshot } from "@step-cli/core/agent/state-machine.js";
import type { AgentLoopOptions } from "@step-cli/core/agent/agent-loop.js";
import type { LogEntry } from "@step-cli/core/logging/logger.js";

type AgentStepInfo =
  NonNullable<AgentLoopOptions["hooks"]> extends {
    onStep?: (info: infer T) => void;
  }
    ? T
    : never;

export function createAgentStepLogRecord(info: AgentStepInfo): LogEntry {
  return {
    level: "info",
    event: "agent.step",
    fields: {
      step: info.step,
      promptTokens: info.promptTokens,
      contextMessages: info.contextMessages,
      maxTokens: info.maxTokens,
    },
  };
}

export function createAgentStateLogRecord(
  snapshot: AgentStateSnapshot,
): LogEntry {
  return {
    level: snapshot.state === "failed" ? "error" : "info",
    event: "agent.state",
    fields: {
      state: snapshot.state,
      step: snapshot.step,
      toolCalls: snapshot.toolCalls,
      ...(snapshot.sessionId ? { sessionId: snapshot.sessionId } : undefined),
      ...(snapshot.goalId ? { goalId: snapshot.goalId } : undefined),
      ...(snapshot.attemptId ? { attemptId: snapshot.attemptId } : undefined),
      ...(snapshot.harnessName
        ? { harnessName: snapshot.harnessName }
        : undefined),
      ...(snapshot.note ? { note: snapshot.note } : undefined),
    },
  };
}

export function createAgentActionLogRecord(action: AgentLoopAction): LogEntry {
  return {
    level:
      action.kind === "goal_complete" && action.success === false
        ? "error"
        : "info",
    event: "agent.action",
    message: action.summary,
    fields: {
      kind: action.kind,
      step: action.step,
      toolCalls: action.toolCalls,
      ...(action.sessionId ? { sessionId: action.sessionId } : undefined),
      ...(action.goalId ? { goalId: action.goalId } : undefined),
      ...(action.attemptId ? { attemptId: action.attemptId } : undefined),
      ...(action.harnessName ? { harnessName: action.harnessName } : undefined),
      ...(action.kind === "goal_complete"
        ? { status: action.success ? "success" : "failed" }
        : undefined),
    },
  };
}
