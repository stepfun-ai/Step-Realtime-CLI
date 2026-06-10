import { AsyncLocalStorage } from "node:async_hooks";
import type { ConversationMemoryState } from "./conversation-memory.js";
import type {
  AgentExecutionProfile,
  AgentExecutionProfileOverrides,
  AgentHarnessKind,
  PersistedExecutionProfile,
} from "../runtime-context-types.js";
export type {
  AgentExecutionProfile,
  AgentExecutionProfileOverrides,
  AgentHarnessKind,
  AgentMemoryMode,
  AgentPriority,
  AgentWorkspaceMode,
  PersistedExecutionProfile,
} from "../runtime-context-types.js";

export type AgentHarnessLifecycleState =
  | "unconfigured"
  | "inactive"
  | "active"
  | "finalized";

export interface AgentHarnessIdentity {
  id: string;
  kind: AgentHarnessKind;
  name: string;
  depth: number;
  workspaceRoot: string;
  parentId?: string;
  sessionId: string;
  goalId: string;
  executionProfile: AgentExecutionProfile;
  lifecycleState: AgentHarnessLifecycleState;
  attemptCount: number;
}

export interface AgentHarnessContext extends AgentHarnessIdentity {
  attemptId: string;
  runStartedAt: string;
  delegationSnapshotProvider?: AgentDelegationSnapshotProvider;
}

export interface AgentDelegationSnapshot {
  memoryState: ConversationMemoryState;
}

export type AgentDelegationSnapshotProvider = () =>
  | AgentDelegationSnapshot
  | undefined;

const DEFAULT_EXECUTION_PROFILES = {
  main: {
    workspaceMode: "shared",
    memoryMode: "session",
    priority: "interactive",
  },
  subagent: {
    workspaceMode: "shared",
    memoryMode: "fresh",
    priority: "delegated",
  },
  teammate: {
    workspaceMode: "shared",
    memoryMode: "persistent",
    priority: "background",
  },
} satisfies Record<AgentHarnessKind, AgentExecutionProfile>;

interface ExecutionProfileFormatFallback {
  workspaceMode?: string;
  memoryMode?: string;
  priority?: string;
}

const DEFAULT_EXECUTION_PROFILE_FALLBACK: ExecutionProfileFormatFallback = {
  workspaceMode: "unknown",
  memoryMode: "unknown",
  priority: "unknown",
};

const harnessContextStorage = new AsyncLocalStorage<AgentHarnessContext>();

export function runWithHarnessContext<T>(
  context: AgentHarnessContext,
  callback: () => Promise<T>,
): Promise<T> {
  return harnessContextStorage.run(context, callback);
}

export function getHarnessContext(): AgentHarnessContext | undefined {
  return harnessContextStorage.getStore();
}

export function resolveExecutionProfile(
  kind: AgentHarnessKind,
  overrides?: AgentExecutionProfileOverrides,
): AgentExecutionProfile {
  return {
    ...DEFAULT_EXECUTION_PROFILES[kind],
    ...overrides,
  };
}

export function cloneExecutionProfile(
  profile: AgentExecutionProfile,
): AgentExecutionProfile {
  return { ...profile };
}

export function isExecutionProfile(
  value: unknown,
): value is AgentExecutionProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    (candidate.workspaceMode === "shared" ||
      candidate.workspaceMode === "isolated") &&
    (candidate.memoryMode === "session" ||
      candidate.memoryMode === "fresh" ||
      candidate.memoryMode === "persistent") &&
    (candidate.priority === "interactive" ||
      candidate.priority === "delegated" ||
      candidate.priority === "background" ||
      candidate.priority === "maintenance")
  );
}

export function isPersistedExecutionProfile(
  value: unknown,
): value is PersistedExecutionProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    (candidate.workspaceMode === "shared" ||
      candidate.workspaceMode === "isolated") &&
    (candidate.memoryMode === undefined ||
      candidate.memoryMode === "session" ||
      candidate.memoryMode === "fresh" ||
      candidate.memoryMode === "persistent") &&
    (candidate.priority === undefined ||
      candidate.priority === "interactive" ||
      candidate.priority === "delegated" ||
      candidate.priority === "background" ||
      candidate.priority === "maintenance")
  );
}

export function persistExecutionProfile(
  profile: AgentExecutionProfile | undefined,
): PersistedExecutionProfile | undefined {
  if (!profile) {
    return undefined;
  }

  return {
    workspaceMode: profile.workspaceMode,
  };
}

export function formatExecutionProfile(
  value: unknown,
  fallback: ExecutionProfileFormatFallback = DEFAULT_EXECUTION_PROFILE_FALLBACK,
): string {
  const profile =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;

  return [
    readProfileSegment(profile?.workspaceMode) ??
      fallback.workspaceMode ??
      "unknown",
    readProfileSegment(profile?.memoryMode) ?? fallback.memoryMode ?? "unknown",
    readProfileSegment(profile?.priority) ?? fallback.priority ?? "unknown",
  ].join("/");
}

export function formatExecutionProfileForHarness(
  kind: AgentHarnessKind,
  value: unknown,
): string {
  return formatExecutionProfile(value, DEFAULT_EXECUTION_PROFILES[kind]);
}

function readProfileSegment(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
