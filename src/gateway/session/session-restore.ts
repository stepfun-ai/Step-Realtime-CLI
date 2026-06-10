import type { RestoreWorkspaceResult } from "../restore/turn-restore.js";
import type {
  ApprovalMode,
  NonInteractiveApproval,
  ToolPolicyConfig,
} from "@step-cli/core/policy/tool-policy.js";
import type {
  AgentOperatingMode,
  ToolPermissionMode,
  UserClarificationRuntimeState,
} from "@step-cli/protocol";
import { cloneUserClarificationRuntimeState } from "@step-cli/utils/clarification.js";
import type {
  SessionRuntimeSnapshot,
  SessionSnapshot,
} from "./session-store.js";

type SessionRestoreAction = "Resumed" | "Reloaded" | "Restored";

interface ExtractToolPolicyFallback {
  mode: ApprovalMode;
  nonInteractiveApproval: NonInteractiveApproval;
}

export interface SessionRestorePlan {
  notices: string[];
  systemPrompt: string;
  memoryState: SessionSnapshot["memory"];
  runtime?: SessionRuntimeSnapshot;
  toolRuntimeState?: unknown;
  pluginStates?: unknown;
  clarificationState: UserClarificationRuntimeState;
  toolPolicy: ToolPolicyConfig;
}

export function buildSessionRestorePlan(input: {
  snapshot: SessionSnapshot;
  sourceLabel: string;
  actionLabel: SessionRestoreAction;
  currentSystemPrompt: string;
  provider: SessionSnapshot["provider"];
  model: string;
  mode: AgentOperatingMode;
  pluginIds: string[];
  maxPerTurn: number;
  currentApprovalMode: ApprovalMode;
  currentNonInteractiveApproval: NonInteractiveApproval;
  baseToolPermissionOverrides?: Record<string, ToolPermissionMode>;
}): SessionRestorePlan {
  const notices = [
    formatSessionRestoreNotice(
      input.actionLabel,
      input.sourceLabel,
      input.snapshot.savedAt,
    ),
  ];
  let systemPrompt = input.currentSystemPrompt;

  if (input.snapshot.provider !== input.provider) {
    notices.push(
      `Session provider mismatch: snapshot=${input.snapshot.provider}, current=${input.provider}`,
    );
  }
  if (input.snapshot.model !== input.model) {
    notices.push(
      `Session model mismatch: snapshot=${input.snapshot.model}, current=${input.model}`,
    );
  }

  const snapshotMode = getSessionSnapshotMode(input.snapshot);
  if (snapshotMode && snapshotMode !== input.mode) {
    notices.push(
      `Session mode mismatch: snapshot=${snapshotMode}, current=${input.mode}`,
    );
  }

  const samePlugins = areStringArraysEqual(
    input.snapshot.pluginIds,
    input.pluginIds,
  );
  if (!samePlugins) {
    notices.push(
      `Session plugin mismatch: snapshot=[${input.snapshot.pluginIds.join(", ")}], current=[${input.pluginIds.join(", ")}]`,
    );
  } else if (
    input.snapshot.systemPrompt.trim().length > 0 &&
    input.snapshot.systemPrompt !== systemPrompt
  ) {
    if (canReuseSnapshotSystemPrompt(input.snapshot, input.mode)) {
      systemPrompt = input.snapshot.systemPrompt;
      notices.push(
        "Loaded system prompt from session snapshot (plugin ids and operating mode match).",
      );
    } else {
      notices.push(
        "Skipped snapshot system prompt because the saved operating mode does not match the current session.",
      );
    }
  }

  const toolPolicy: ToolPolicyConfig = {
    mode: input.currentApprovalMode,
    nonInteractiveApproval: input.currentNonInteractiveApproval,
    overrides: input.baseToolPermissionOverrides
      ? { ...input.baseToolPermissionOverrides }
      : undefined,
  };
  if (isSessionSnapshotV2Plus(input.snapshot)) {
    const restored = extractToolPolicyConfig(input.snapshot.toolPolicy, {
      mode: input.currentApprovalMode,
      nonInteractiveApproval: input.currentNonInteractiveApproval,
    });
    if (restored) {
      toolPolicy.mode = restored.mode;
      toolPolicy.nonInteractiveApproval = restored.nonInteractiveApproval;
      Object.assign(toolPolicy.overrides ?? {}, restored.overrides ?? {});

      if (
        restored.mode !== input.currentApprovalMode ||
        restored.nonInteractiveApproval !== input.currentNonInteractiveApproval
      ) {
        notices.push(
          `Restored approval mode from session snapshot: ${restored.mode} / ${restored.nonInteractiveApproval}.`,
        );
      }

      const count = Object.keys(restored.overrides ?? {}).length;
      if (count > 0) {
        notices.push(
          `Restored ${count} tool policy override(s) from session snapshot.`,
        );
      }
    }
  }

  if (input.snapshot.schemaVersion < 3) {
    notices.push(
      "Session snapshot predates runtime identity metadata; generated a fresh session/goal profile.",
    );
  }

  return {
    notices,
    systemPrompt,
    memoryState: input.snapshot.memory,
    runtime: hasSessionRuntimeSnapshot(input.snapshot)
      ? input.snapshot.runtime
      : undefined,
    toolRuntimeState: isSessionSnapshotV2Plus(input.snapshot)
      ? input.snapshot.toolRuntime
      : undefined,
    pluginStates: isSessionSnapshotV2Plus(input.snapshot)
      ? input.snapshot.pluginStates
      : undefined,
    clarificationState: buildInitialClarificationState({
      maxPerTurn: input.maxPerTurn,
      snapshot: input.snapshot,
      notices,
    }),
    toolPolicy,
  };
}

export function formatRestoreWorkspaceNotice(
  result: RestoreWorkspaceResult | null,
): string | null {
  if (!result || result.trackedFiles <= 0) {
    return null;
  }

  const parts: string[] = [];
  if (result.restoredFiles > 0) {
    parts.push(
      `restored ${result.restoredFiles} file(s)${formatRestorePathSuffix(result.restoredPaths)}`,
    );
  }
  if (result.deletedFiles > 0) {
    parts.push(
      `removed ${result.deletedFiles} new file(s)${formatRestorePathSuffix(result.deletedPaths)}`,
    );
  }

  if (parts.length === 0) {
    return null;
  }

  return `Reverted tracked file changes from the last turn: ${parts.join("; ")}.`;
}

export function formatExternalRestoreWarning(
  effectLabels: readonly string[],
): string {
  const formattedEffects = effectLabels
    .map((label) => `\`${label}\``)
    .join(", ");
  return [
    "Restore did not undo side effects outside tracked file edits.",
    `This turn used ${formattedEffects}, so shell-created files, background processes, or remote changes may still remain.`,
  ].join(" ");
}

function formatSessionRestoreNotice(
  actionLabel: SessionRestoreAction,
  sourceLabel: string,
  savedAt: string,
): string {
  const formattedTime = formatTimestamp(savedAt);
  switch (actionLabel) {
    case "Restored":
      return `Rewound the session to the snapshot captured before the last user turn (${formattedTime}).`;
    case "Reloaded":
      return `Reloaded the session snapshot from ${sourceLabel} (${formattedTime}).`;
    case "Resumed":
    default:
      return `Resumed the session from ${sourceLabel} (${formattedTime}).`;
  }
}

function formatRestorePathSuffix(paths: readonly string[]): string {
  if (paths.length === 0) {
    return "";
  }

  const preview = paths.slice(0, 3).map((value) => `\`${value}\``);
  const remaining = paths.length - preview.length;
  const previewText = preview.join(", ");
  return remaining > 0
    ? ` (${previewText}, +${remaining} more)`
    : ` (${previewText})`;
}

function isSessionSnapshotV2Plus(
  snapshot: SessionSnapshot | null,
): snapshot is Extract<SessionSnapshot, { schemaVersion: 2 | 3 | 4 }> {
  return (
    snapshot?.schemaVersion === 2 ||
    snapshot?.schemaVersion === 3 ||
    snapshot?.schemaVersion === 4
  );
}

function hasSessionRuntimeSnapshot(
  snapshot: SessionSnapshot | null,
): snapshot is Extract<SessionSnapshot, { schemaVersion: 3 | 4 }> {
  return snapshot?.schemaVersion === 3 || snapshot?.schemaVersion === 4;
}

function getSessionSnapshotMode(
  snapshot: SessionSnapshot | null,
): AgentOperatingMode | undefined {
  return snapshot?.schemaVersion === 4 ? snapshot.mode : undefined;
}

function canReuseSnapshotSystemPrompt(
  snapshot: SessionSnapshot,
  currentMode: AgentOperatingMode,
): boolean {
  const snapshotMode = getSessionSnapshotMode(snapshot);
  if (snapshotMode) {
    return snapshotMode === currentMode;
  }
  return currentMode === "normal";
}

export function buildInitialClarificationState(input: {
  maxPerTurn: number;
  snapshot: SessionSnapshot | null;
  notices: string[];
}): UserClarificationRuntimeState {
  const snapshotState =
    input.snapshot?.schemaVersion === 4
      ? input.snapshot.clarification
      : undefined;
  const restored = snapshotState
    ? cloneUserClarificationRuntimeState(snapshotState)
    : undefined;

  if (restored?.pending) {
    input.notices.push(
      "Dropped pending user clarification from session snapshot because in-flight clarification requests cannot survive process restarts.",
    );
  }

  return {
    maxPerTurn: input.maxPerTurn,
    usedThisTurn: 0,
    remainingThisTurn: Math.max(0, input.maxPerTurn),
    totalRequests: Math.max(
      restored?.totalRequests ?? 0,
      restored?.history.length ?? 0,
    ),
    pending: null,
    history: restored?.history ?? [],
  };
}

function extractToolPolicyConfig(
  value: unknown,
  fallback: ExtractToolPolicyFallback,
): ToolPolicyConfig | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const overrides = extractToolPermissionOverrides(value) ?? {};
  let mode = fallback.mode;
  let nonInteractiveApproval = fallback.nonInteractiveApproval;
  let found = Object.keys(overrides).length > 0;

  if (
    value.mode === "confirm" ||
    value.mode === "auto" ||
    value.mode === "strict"
  ) {
    mode = value.mode;
    found = true;
  }

  if (
    value.nonInteractiveApproval === "allow" ||
    value.nonInteractiveApproval === "deny"
  ) {
    nonInteractiveApproval = value.nonInteractiveApproval;
    found = true;
  }

  return found
    ? {
        mode,
        nonInteractiveApproval,
        overrides,
      }
    : null;
}

function extractToolPermissionOverrides(
  value: unknown,
): Record<string, ToolPermissionMode> | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const overrides = value.overrides;
  if (!isPlainObject(overrides)) {
    return null;
  }

  const result: Record<string, ToolPermissionMode> = {};
  for (const [toolName, mode] of Object.entries(overrides)) {
    if (!toolName || typeof toolName !== "string") {
      continue;
    }
    if (mode !== "allow" && mode !== "confirm" && mode !== "deny") {
      continue;
    }
    result[toolName] = mode;
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function areStringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function formatTimestamp(value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    return "unknown";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "Z");
}
