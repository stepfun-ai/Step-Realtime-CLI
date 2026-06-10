import type { AgentRunResult } from "./agent-loop.js";
import type { AgentHarnessIdentity } from "./harness-context.js";
import type { AgentHarnessKind } from "../runtime-context-types.js";
import { toErrorMessage } from "@step-cli/utils/error.js";
import { truncateText } from "@step-cli/utils/text.js";

export type AgentRunArtifactCategory = "subagent" | "teammate";

export interface AgentRunArtifactRef {
  kind: "agent_run";
  category: AgentRunArtifactCategory;
  artifactId: string;
  absolutePath: string;
  relativePath: string;
  savedAt?: string;
  sessionId?: string | null;
  goalId?: string | null;
  attemptId?: string | null;
}

export interface PersistedAgentRunArtifact {
  schemaVersion: 1;
  kind: "agent_run";
  artifactId: string;
  savedAt: string;
  category: AgentRunArtifactCategory;
  label: string;
  prompt: string;
  harness: AgentHarnessIdentity | Record<string, unknown>;
  run: AgentRunResult["run"] | Record<string, unknown>;
  steps: number;
  toolCalls: number;
  output: string;
  actions: AgentRunResult["actions"];
  stateTimeline: AgentRunResult["stateTimeline"];
  notes?: Record<string, unknown>;
}

export interface AgentRunArtifactSummary extends AgentRunArtifactRef {
  label: string;
  sessionId: string | null;
  goalId: string | null;
  attemptId: string | null;
  harnessId: string | null;
  harnessKind: AgentHarnessKind | null;
  harnessName: string | null;
  steps: number;
  toolCalls: number;
  promptPreview: string;
  outputPreview: string;
}

export interface AgentRunArtifactEntry {
  ref: AgentRunArtifactRef;
  summary: AgentRunArtifactSummary;
  artifact: PersistedAgentRunArtifact;
}

export interface AgentRunArtifactQuery {
  workspaceRoot: string;
  category?: AgentRunArtifactCategory;
  sessionId?: string;
  goalId?: string;
  attemptId?: string;
  harnessKind?: AgentHarnessKind;
  harnessName?: string;
  labelIncludes?: string;
  limit?: number;
}

export interface PersistAgentRunArtifactInput {
  workspaceRoot: string;
  category: AgentRunArtifactCategory;
  label: string;
  taskPrompt: string;
  harness: AgentHarnessIdentity;
  result: AgentRunResult;
  notes?: Record<string, unknown>;
}

export interface AgentRunArtifactStore {
  persist(input: PersistAgentRunArtifactInput): Promise<AgentRunArtifactRef>;
}

export async function persistAgentRunArtifact(
  store: AgentRunArtifactStore | undefined,
  input: PersistAgentRunArtifactInput,
): Promise<AgentRunArtifactRef> {
  if (!store) {
    throw new Error("Agent run artifact store is not configured.");
  }

  return await store.persist(input);
}

export function renderAgentRunArtifactNotice(input: {
  subject: string;
  artifact: AgentRunArtifactRef;
  result: Pick<AgentRunResult, "output" | "steps" | "toolCalls" | "actions">;
  maxPreviewChars?: number;
}): string {
  const preview = truncateText({
    text: input.result.output.trim() || "(no final output)",
    maxChars: Math.max(240, input.maxPreviewChars ?? 700),
    strategy: "head_tail",
  }).text;

  return [
    `${input.subject} stored full result at ${input.artifact.relativePath}.`,
    `steps: ${input.result.steps}`,
    `tool_calls: ${input.result.toolCalls}`,
    "final_output_preview:",
    preview,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join("\n");
}

export function renderAgentRunInlineNotice(input: {
  subject: string;
  error: unknown;
  result: Pick<AgentRunResult, "output" | "steps" | "toolCalls" | "actions">;
  maxPreviewChars?: number;
}): string {
  const preview = truncateText({
    text: input.result.output.trim() || "(no final output)",
    maxChars: Math.max(240, input.maxPreviewChars ?? 700),
    strategy: "head_tail",
  }).text;

  return [
    `${input.subject} completed, but storing the full artifact failed: ${toErrorMessage(input.error)}`,
    `steps: ${input.result.steps}`,
    `tool_calls: ${input.result.toolCalls}`,
    "final_output_preview:",
    preview,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join("\n");
}
