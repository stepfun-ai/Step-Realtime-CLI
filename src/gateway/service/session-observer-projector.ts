import type {
  StepCliSessionHookEventPayload,
  StepCliSessionObserverEventPayload,
} from "@step-cli/protocol";

const HIGH_SIGNAL_IMPORTANCE = new Set(["high"]);
const HIGH_SIGNAL_AGENT_STATES = new Set([
  "tool_execution",
  "context_compaction",
  "goal_complete",
  "failed",
  "blocked",
  "error",
]);
const HIGH_SIGNAL_ACTION_KINDS = new Set([
  "context_compaction",
  "fresh_attempt_restart",
  "goal_complete",
]);
const HIGH_SIGNAL_SUBAGENT_STATUSES = new Set([
  "running",
  "completed",
  "interrupted",
  "error",
  "lost",
]);

type HookEnvelopeFields = {
  actionKind?: unknown;
  dedupeKey?: unknown;
  detail?: unknown;
  harnessName?: unknown;
  lane?: unknown;
  toolName?: unknown;
};

export interface SessionObserverProjector {
  consume(
    hook: StepCliSessionHookEventPayload,
  ): StepCliSessionObserverEventPayload | null;
  reset(lineageKey?: string): void;
}

export function createSessionObserverProjector(): SessionObserverProjector {
  const seenDedupeKeys = new Map<string, Set<string>>();

  return {
    consume(hook) {
      const observer = buildObserver(hook);
      if (!observer) {
        return null;
      }

      const lineageKey = deriveLineageKey(hook);
      const dedupeKey = observer.dedupeKey ?? observer.observerId;
      const lineageCache = seenDedupeKeys.get(lineageKey) ?? new Set<string>();
      if (lineageCache.has(dedupeKey)) {
        return null;
      }

      lineageCache.add(dedupeKey);
      seenDedupeKeys.set(lineageKey, lineageCache);
      return observer;
    },
    reset(lineageKey) {
      if (!lineageKey || lineageKey.trim().length === 0) {
        seenDedupeKeys.clear();
        return;
      }

      const normalizedPrefix = lineageKey.trim();
      for (const key of Array.from(seenDedupeKeys.keys())) {
        if (
          key === normalizedPrefix ||
          key.startsWith(`${normalizedPrefix}|`)
        ) {
          seenDedupeKeys.delete(key);
        }
      }
    },
  };
}

function buildObserver(
  hook: StepCliSessionHookEventPayload,
): StepCliSessionObserverEventPayload | null {
  if (!hook.hookId) {
    return null;
  }
  if (!HIGH_SIGNAL_IMPORTANCE.has(String(hook.importance ?? ""))) {
    return null;
  }

  if (hook.hookKind === "subagent.status") {
    return projectSubagentStatusObserver(hook);
  }

  if (hook.hookKind === "agent.state.changed") {
    return projectStateObserver(hook);
  }

  const actionKind = deriveActionKind(hook);
  if (actionKind) {
    return projectActionObserver(hook, actionKind);
  }

  return null;
}

function projectSubagentStatusObserver(
  hook: StepCliSessionHookEventPayload,
): StepCliSessionObserverEventPayload | null {
  const status = deriveSubagentStatus(hook);
  if (!status || !HIGH_SIGNAL_SUBAGENT_STATUSES.has(status)) {
    return null;
  }

  const lane = deriveLane(hook);
  return {
    observerId: `observer:${hook.hookId}`,
    recordedAt: hook.recordedAt,
    title: normalizeSentence(hook.title) || `Subagent ${status}`,
    summary: normalizeSentence(hook.summary) || `${lane} is ${status}`,
    severity: deriveSubagentSeverity(status),
    lane,
    sourceHookId: hook.hookId,
    dedupeKey:
      deriveExplicitDedupeKey(hook) ??
      `observer:subagent.status:${lane}:${status}`,
    data: buildObserverData(hook, {
      status,
      lineageKey: deriveLineageKey(hook),
    }),
  };
}

function projectStateObserver(
  hook: StepCliSessionHookEventPayload,
): StepCliSessionObserverEventPayload | null {
  const normalizedState = normalizeToken(hook.state);
  if (!normalizedState || !HIGH_SIGNAL_AGENT_STATES.has(normalizedState)) {
    return null;
  }

  const lane = deriveLane(hook);
  return {
    observerId: `observer:${hook.hookId}`,
    recordedAt: hook.recordedAt,
    title: `Agent state changed: ${normalizedState}`,
    summary:
      normalizeSentence(hook.summary) ||
      `${lane} agent moved into ${normalizedState} state`,
    severity: deriveStateSeverity(normalizedState),
    lane,
    sourceHookId: hook.hookId,
    dedupeKey:
      deriveExplicitDedupeKey(hook) ??
      `observer:agent.state.changed:${lane}:${normalizedState}`,
    data: buildObserverData(hook, {
      lineageKey: deriveLineageKey(hook),
    }),
  };
}

function projectActionObserver(
  hook: StepCliSessionHookEventPayload,
  actionKind: string,
): StepCliSessionObserverEventPayload | null {
  if (!HIGH_SIGNAL_ACTION_KINDS.has(actionKind)) {
    return null;
  }

  const lane = deriveLane(hook);
  return {
    observerId: `observer:${hook.hookId}`,
    recordedAt: hook.recordedAt,
    title: normalizeSentence(hook.title) || humanizeActionKind(actionKind),
    summary:
      normalizeSentence(hook.summary) ||
      `${lane} reported ${humanizeActionKind(actionKind).toLowerCase()}`,
    severity: deriveActionSeverity(actionKind, hook),
    lane,
    sourceHookId: hook.hookId,
    dedupeKey:
      deriveExplicitDedupeKey(hook) ??
      `observer:agent.action:${lane}:${actionKind}`,
    data: buildObserverData(hook, {
      actionKind,
      lineageKey: deriveLineageKey(hook),
    }),
  };
}

function deriveSubagentStatus(
  hook: StepCliSessionHookEventPayload,
): string | null {
  const explicitState = normalizeToken(hook.state);
  if (explicitState.length > 0) {
    return explicitState;
  }

  const status = getStringMetadata(hook, "status");
  return status ? normalizeToken(status) : null;
}

function deriveStateSeverity(
  state: string,
): StepCliSessionObserverEventPayload["severity"] {
  if (state === "failed" || state === "error") {
    return "critical";
  }
  if (state === "blocked") {
    return "warning";
  }
  return "info";
}

function deriveSubagentSeverity(
  status: string,
): StepCliSessionObserverEventPayload["severity"] {
  if (status === "error") {
    return "critical";
  }
  if (status === "interrupted" || status === "lost") {
    return "warning";
  }
  return "info";
}

function deriveActionSeverity(
  actionKind: string,
  hook: StepCliSessionHookEventPayload,
): StepCliSessionObserverEventPayload["severity"] {
  if (actionKind === "goal_complete" && hook.data?.success === false) {
    return "critical";
  }
  if (actionKind === "fresh_attempt_restart") {
    return "warning";
  }
  return "info";
}

function buildObserverData(
  hook: StepCliSessionHookEventPayload,
  extras: Record<string, unknown> = {},
): StepCliSessionObserverEventPayload["data"] {
  const actionKind = deriveActionKind(hook);

  return {
    hookKind: hook.hookKind,
    source: hook.source,
    harnessType: hook.harnessType,
    harnessId: hook.harnessId,
    parentHarnessId: hook.parentHarnessId,
    goalId: hook.goalId ?? null,
    attemptId: hook.attemptId ?? null,
    depth: hook.depth ?? null,
    state: hook.state ?? null,
    title: hook.title,
    summary: hook.summary,
    actionKind,
    data: hook.data ?? null,
    ...extras,
  };
}

function deriveLineageKey(hook: StepCliSessionHookEventPayload): string {
  const parts = [
    hook.attemptId ? `attempt:${hook.attemptId}` : null,
    hook.goalId ? `goal:${hook.goalId}` : null,
    hook.harnessId ? `harness:${hook.harnessId}` : null,
    hook.parentHarnessId ? `parent:${hook.parentHarnessId}` : null,
    hook.depth !== undefined ? `depth:${hook.depth}` : null,
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join("|") : "lineage:global";
}

function deriveLane(hook: StepCliSessionHookEventPayload): string {
  const fields = hook as StepCliSessionHookEventPayload & HookEnvelopeFields;
  const explicitLane = normalizeToken(readStringField(fields.lane));
  if (explicitLane.length > 0) {
    return explicitLane;
  }

  const dataLane = normalizeToken(getStringMetadata(hook, "lane"));
  if (dataLane.length > 0) {
    return dataLane;
  }

  const harnessName = normalizeToken(readStringField(fields.harnessName));
  if (harnessName.length > 0) {
    return harnessName;
  }

  const source = normalizeToken(hook.source);
  if (source.length > 0 && source !== "subagent") {
    return source;
  }

  const harnessId = normalizeToken(hook.harnessId);
  if (harnessId.length > 0) {
    return harnessId.includes(":")
      ? harnessId.slice(harnessId.lastIndexOf(":") + 1)
      : harnessId;
  }

  const harnessType = normalizeToken(hook.harnessType);
  if (harnessType.length > 0) {
    return harnessType;
  }

  return "main";
}

function deriveActionKind(hook: StepCliSessionHookEventPayload): string | null {
  const fields = hook as StepCliSessionHookEventPayload & HookEnvelopeFields;
  const explicit = normalizeToken(readStringField(fields.actionKind));
  if (explicit.length > 0) {
    return explicit;
  }

  const legacyPrefix = "agent.action.";
  if (hook.hookKind.startsWith(legacyPrefix)) {
    return normalizeToken(hook.hookKind.slice(legacyPrefix.length));
  }
  return hook.hookKind === "agent.action" ? null : null;
}

function deriveExplicitDedupeKey(
  hook: StepCliSessionHookEventPayload,
): string | null {
  const fields = hook as StepCliSessionHookEventPayload & HookEnvelopeFields;
  const dedupeKey = normalizeSentence(readStringField(fields.dedupeKey));
  return dedupeKey.length > 0 ? dedupeKey : null;
}

function humanizeActionKind(actionKind: string): string {
  const words = actionKind
    .split(".")
    .flatMap((segment) => segment.split("_"))
    .filter((segment) => segment.length > 0);

  if (words.length === 0) {
    return "Agent action";
  }

  return words
    .map((word, index) => (index === 0 ? capitalize(word) : word.toLowerCase()))
    .join(" ");
}

function getStringMetadata(
  hook: StepCliSessionHookEventPayload,
  key: string,
): string | null {
  const value = hook.data?.[key];
  return typeof value === "string" ? value : null;
}

function readStringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeToken(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeSentence(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function capitalize(value: string): string {
  if (value.length === 0) {
    return value;
  }

  return `${value[0]!.toUpperCase()}${value.slice(1).toLowerCase()}`;
}
