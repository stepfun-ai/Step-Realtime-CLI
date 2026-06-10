import type { ConversationMemoryState } from "@step-cli/core/agent/conversation-memory.js";
import {
  type AgentExecutionProfile,
  isPersistedExecutionProfile,
  persistExecutionProfile,
  type PersistedExecutionProfile,
} from "@step-cli/core/agent/harness-context.js";
import type {
  OpenAIToolDefinition,
  StepCliActiveGoal,
  StepCliContextAssembly,
  StepCliVerifierVerdict,
  UserClarificationRuntimeState,
} from "@step-cli/protocol";
import type { AgentOperatingMode } from "@step-cli/protocol";
import { isUserClarificationRuntimeState } from "@step-cli/utils/clarification.js";
import { cloneContextAssembly } from "@step-cli/core/agent/context-assembly.js";
import {
  cloneStepCliVerifierVerdict,
  isStepCliVerifierVerdict,
} from "../verifier.js";

export interface SessionSnapshotV1 {
  schemaVersion: 1;
  savedAt: string;
  workspaceRoot: string;
  provider: "openai" | "response" | "anthropic";
  model: string;
  systemPrompt: string;
  pluginIds: string[];
  memory: ConversationMemoryState;
}

export interface SessionSnapshotV2 {
  schemaVersion: 2;
  savedAt: string;
  workspaceRoot: string;
  provider: "openai" | "response" | "anthropic";
  model: string;
  systemPrompt: string;
  pluginIds: string[];
  memory: ConversationMemoryState;

  toolPolicy?: unknown;
  toolRuntime?: unknown;
  pluginStates?: unknown;
}

export interface SessionRuntimeSnapshot {
  sessionId: string;
  goalId: string;
  activeGoal?: StepCliActiveGoal | null;
  executionProfile?: PersistedExecutionProfile;
  contextAssembly?: StepCliContextAssembly;
  verifier?: StepCliVerifierVerdict;
}

export interface BuildSessionRuntimeSnapshotInput {
  sessionId: string;
  goalId: string;
  activeGoal?: StepCliActiveGoal | null;
  executionProfile?: AgentExecutionProfile;
  contextAssembly?: StepCliContextAssembly;
  verifier?: StepCliVerifierVerdict;
}

export interface SessionSnapshotV3 {
  schemaVersion: 3;
  savedAt: string;
  workspaceRoot: string;
  provider: "openai" | "response" | "anthropic";
  model: string;
  systemPrompt: string;
  pluginIds: string[];
  memory: ConversationMemoryState;
  runtime: SessionRuntimeSnapshot;
  toolPolicy?: unknown;
  toolRuntime?: unknown;
  pluginStates?: unknown;
}

export interface SessionSnapshotV4 {
  schemaVersion: 4;
  savedAt: string;
  workspaceRoot: string;
  provider: "openai" | "response" | "anthropic";
  model: string;
  mode: AgentOperatingMode;
  systemPrompt: string;
  pluginIds: string[];
  memory: ConversationMemoryState;
  runtime: SessionRuntimeSnapshot;
  activeGoal?: StepCliActiveGoal | null;
  tools?: OpenAIToolDefinition[];
  clarification?: UserClarificationRuntimeState;
  toolPolicy?: unknown;
  toolRuntime?: unknown;
  pluginStates?: unknown;
}

export type SessionSnapshot =
  | SessionSnapshotV1
  | SessionSnapshotV2
  | SessionSnapshotV3
  | SessionSnapshotV4;

export interface BuildSessionSnapshotV4Input {
  savedAt: string;
  workspaceRoot: string;
  provider: "openai" | "response" | "anthropic";
  model: string;
  mode: AgentOperatingMode;
  systemPrompt: string;
  pluginIds: string[];
  memory: ConversationMemoryState;
  runtime: BuildSessionRuntimeSnapshotInput;
  activeGoal?: StepCliActiveGoal | null;
  tools?: OpenAIToolDefinition[];
  clarification?: UserClarificationRuntimeState;
  toolPolicy?: unknown;
  toolRuntime?: unknown;
  pluginStates?: unknown;
}

export function buildSessionSnapshotV4(
  input: BuildSessionSnapshotV4Input,
): SessionSnapshotV4 {
  return {
    schemaVersion: 4,
    savedAt: input.savedAt,
    workspaceRoot: input.workspaceRoot,
    provider: input.provider,
    model: input.model,
    mode: input.mode,
    systemPrompt: input.systemPrompt,
    pluginIds: [...input.pluginIds],
    memory: input.memory,
    runtime: {
      sessionId: input.runtime.sessionId,
      goalId: input.runtime.goalId,
      activeGoal: cloneActiveGoal(input.runtime.activeGoal),
      executionProfile: persistExecutionProfile(input.runtime.executionProfile),
      contextAssembly: cloneContextAssembly(input.runtime.contextAssembly),
      verifier: cloneStepCliVerifierVerdict(input.runtime.verifier),
    },
    activeGoal: cloneActiveGoal(input.activeGoal ?? input.runtime.activeGoal),
    tools: input.tools ? [...input.tools] : [],
    clarification: input.clarification,
    toolPolicy: input.toolPolicy,
    toolRuntime: input.toolRuntime,
    pluginStates: input.pluginStates,
  };
}

export function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  const schemaVersion = candidate.schemaVersion;
  if (
    schemaVersion !== 1 &&
    schemaVersion !== 2 &&
    schemaVersion !== 3 &&
    schemaVersion !== 4
  ) {
    return false;
  }

  if (typeof candidate.savedAt !== "string") {
    return false;
  }

  if (typeof candidate.workspaceRoot !== "string") {
    return false;
  }

  if (
    candidate.provider !== "openai" &&
    candidate.provider !== "response" &&
    candidate.provider !== "anthropic"
  ) {
    return false;
  }

  if (typeof candidate.model !== "string") {
    return false;
  }

  if (typeof candidate.systemPrompt !== "string") {
    return false;
  }

  if (
    !Array.isArray(candidate.pluginIds) ||
    !candidate.pluginIds.every((entry) => typeof entry === "string")
  ) {
    return false;
  }

  const memory = candidate.memory;
  if (!memory || typeof memory !== "object") {
    return false;
  }

  if (candidate.tools !== undefined && !isToolDefinitionList(candidate.tools)) {
    return false;
  }

  if (
    candidate.clarification !== undefined &&
    !isUserClarificationRuntimeState(candidate.clarification)
  ) {
    return false;
  }

  if (
    candidate.activeGoal !== undefined &&
    !isPersistedActiveGoal(candidate.activeGoal)
  ) {
    return false;
  }

  if (schemaVersion === 4) {
    if (candidate.mode !== "normal" && candidate.mode !== "plan") {
      return false;
    }
  }

  if (schemaVersion === 3 || schemaVersion === 4) {
    const runtime = candidate.runtime;
    if (!isSessionRuntimeSnapshot(runtime)) {
      return false;
    }
  }

  return true;
}

function isSessionRuntimeSnapshot(
  value: unknown,
): value is SessionRuntimeSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.sessionId !== "string" ||
    typeof candidate.goalId !== "string"
  ) {
    return false;
  }

  const executionProfile = candidate.executionProfile;
  if (
    candidate.activeGoal !== undefined &&
    !isPersistedActiveGoal(candidate.activeGoal)
  ) {
    return false;
  }
  if (
    candidate.contextAssembly !== undefined &&
    (typeof candidate.contextAssembly !== "object" ||
      candidate.contextAssembly === null ||
      Array.isArray(candidate.contextAssembly))
  ) {
    return false;
  }

  if (
    executionProfile !== undefined &&
    !isPersistedExecutionProfile(executionProfile)
  ) {
    return false;
  }

  return (
    candidate.verifier === undefined ||
    isStepCliVerifierVerdict(candidate.verifier)
  );
}

function cloneActiveGoal(
  goal: StepCliActiveGoal | null | undefined,
): StepCliActiveGoal | null | undefined {
  if (!goal) {
    return goal;
  }

  return {
    ...goal,
    limits: goal.limits ? { ...goal.limits } : undefined,
    counters: goal.counters ? { ...goal.counters } : undefined,
  };
}

function isPersistedActiveGoal(
  value: unknown,
): value is StepCliActiveGoal | null {
  if (value === null) {
    return true;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.sessionId !== "string" ||
    typeof candidate.text !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.updatedAt !== "string" ||
    typeof candidate.iteration !== "number"
  ) {
    return false;
  }

  if (!isGoalStatus(candidate.status)) {
    return false;
  }

  if (
    candidate.limits !== undefined &&
    (candidate.limits === null ||
      typeof candidate.limits !== "object" ||
      Array.isArray(candidate.limits))
  ) {
    return false;
  }

  if (candidate.counters !== undefined) {
    const counters = candidate.counters;
    if (!counters || typeof counters !== "object" || Array.isArray(counters)) {
      return false;
    }
    const record = counters as Record<string, unknown>;
    if (
      typeof record.consecutiveFailures !== "number" ||
      typeof record.totalRuns !== "number" ||
      typeof record.totalFailures !== "number"
    ) {
      return false;
    }
  }

  return true;
}

function isGoalStatus(value: unknown): value is StepCliActiveGoal["status"] {
  return (
    value === "active" ||
    value === "paused" ||
    value === "completed" ||
    value === "failed" ||
    value === "stopped" ||
    value === "waiting_for_user"
  );
}
function isToolDefinitionList(value: unknown): value is OpenAIToolDefinition[] {
  return (
    Array.isArray(value) && value.every((entry) => isToolDefinition(entry))
  );
}

function isToolDefinition(value: unknown): value is OpenAIToolDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "function") {
    return false;
  }

  const fn = candidate.function;
  if (!fn || typeof fn !== "object" || Array.isArray(fn)) {
    return false;
  }

  const functionCandidate = fn as Record<string, unknown>;
  return (
    typeof functionCandidate.name === "string" &&
    typeof functionCandidate.description === "string" &&
    !!functionCandidate.parameters &&
    typeof functionCandidate.parameters === "object" &&
    !Array.isArray(functionCandidate.parameters)
  );
}
