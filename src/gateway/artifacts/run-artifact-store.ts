import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentRunResult } from "@step-cli/core/agent/agent-loop.js";
import type { AgentHarnessKind } from "@step-cli/core/agent/harness-context.js";
import type {
  AgentRunArtifactEntry,
  AgentRunArtifactQuery,
  AgentRunArtifactRef,
  AgentRunArtifactStore,
  AgentRunArtifactSummary,
  PersistAgentRunArtifactInput,
  PersistedAgentRunArtifact,
} from "@step-cli/core/agent/run-artifact-store.js";
import { isFileNotFound } from "@step-cli/utils/fs.js";
import { shortenLine } from "@step-cli/utils/text.js";
import type { AgentRunArtifactCategory } from "@step-cli/core/agent/run-artifact-store.js";
import {
  getSessionArtifactsRootDirectory,
  getSessionsRootDirectory,
  type StepCliResolvedStorageLayout,
} from "../storage/layout.js";

const RUN_ARTIFACT_SCHEMA_VERSION = 1;
const LEGACY_ARTIFACT_PATH_SEGMENTS: Record<
  AgentRunArtifactCategory,
  readonly string[]
> = {
  subagent: [".step-cli", "artifacts", "subagent"],
  teammate: [".step-cli", "artifacts", "teammate"],
};

export class FilesystemAgentRunArtifactStore implements AgentRunArtifactStore {
  constructor(private readonly storageLayout: StepCliResolvedStorageLayout) {}

  async persist(
    input: PersistAgentRunArtifactInput,
  ): Promise<AgentRunArtifactRef> {
    return await persistAgentRunArtifactRecord(input, this.storageLayout);
  }
}

export function createFilesystemAgentRunArtifactStore(
  storageLayout: StepCliResolvedStorageLayout,
): AgentRunArtifactStore {
  return new FilesystemAgentRunArtifactStore(storageLayout);
}

async function persistAgentRunArtifactRecord(
  input: PersistAgentRunArtifactInput,
  storageLayout: StepCliResolvedStorageLayout,
): Promise<AgentRunArtifactRef> {
  const savedAt = new Date().toISOString();
  const sessionId = normalizeArtifactScopeId(
    input.result.run.sessionId,
    input.harness.sessionId,
  );
  const goalId = normalizeArtifactScopeId(
    input.result.run.goalId,
    input.harness.goalId,
  );
  const attemptId = normalizeArtifactScopeId(
    input.result.run.attemptId,
    `attempt-${input.harness.attemptCount}`,
  );
  const dir = getAgentRunArtifactAttemptDirectory({
    storageLayout,
    sessionId,
    attemptId,
    category: input.category,
  });
  await fs.mkdir(dir, { recursive: true });

  const artifactId = buildArtifactId({
    savedAt,
    category: input.category,
    label: input.label,
    attemptId,
  });
  const absolutePath = path.join(dir, `${artifactId}.json`);
  const relativePath = toWorkspaceRelativePath(
    input.workspaceRoot,
    absolutePath,
  );

  const payload: PersistedAgentRunArtifact = {
    schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
    kind: "agent_run",
    artifactId,
    savedAt,
    category: input.category,
    label: input.label,
    prompt: input.taskPrompt,
    harness: input.harness,
    run: {
      ...input.result.run,
      sessionId,
      goalId,
      attemptId,
    },
    steps: input.result.steps,
    toolCalls: input.result.toolCalls,
    output: input.result.output,
    actions: input.result.actions,
    stateTimeline: input.result.stateTimeline,
    notes: input.notes,
  };

  await fs.writeFile(
    absolutePath,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );

  return {
    kind: "agent_run",
    category: input.category,
    artifactId,
    absolutePath,
    relativePath,
    savedAt,
    sessionId,
    goalId,
    attemptId,
  };
}

export async function listAgentRunArtifacts(
  input: AgentRunArtifactQuery & {
    storageLayout: StepCliResolvedStorageLayout;
  },
): Promise<AgentRunArtifactSummary[]> {
  const files = await collectAgentRunArtifactFiles(
    input.workspaceRoot,
    input.storageLayout,
  );
  const summaries: AgentRunArtifactSummary[] = [];

  for (const filePath of files) {
    const entry = await readStoredAgentRunArtifact(
      input.workspaceRoot,
      filePath,
    );
    if (!entry) {
      continue;
    }
    if (!matchesArtifactQuery(entry.summary, input)) {
      continue;
    }
    summaries.push(entry.summary);
  }

  summaries.sort(compareAgentRunArtifacts);
  if (typeof input.limit === "number" && Number.isFinite(input.limit)) {
    return summaries.slice(0, Math.max(0, input.limit));
  }
  return summaries;
}

export async function readAgentRunArtifact(input: {
  workspaceRoot: string;
  reference: string;
  storageLayout: StepCliResolvedStorageLayout;
}): Promise<AgentRunArtifactEntry | null> {
  const filePath = await resolveAgentRunArtifactPath(
    input.workspaceRoot,
    input.reference,
    input.storageLayout,
  );
  if (!filePath) {
    return null;
  }
  return await readStoredAgentRunArtifact(input.workspaceRoot, filePath);
}

export function getAgentRunArtifactRootDirectory(
  storageLayout: StepCliResolvedStorageLayout,
): string {
  return getSessionsRootDirectory(storageLayout);
}

function getAgentRunArtifactAttemptDirectory(input: {
  storageLayout: StepCliResolvedStorageLayout;
  sessionId: string;
  attemptId: string;
  category: AgentRunArtifactCategory;
}): string {
  return path.join(
    getSessionArtifactsRootDirectory(input.storageLayout, input.sessionId),
    "attempts",
    encodeURIComponent(input.attemptId),
    input.category,
  );
}

function buildArtifactId(input: {
  savedAt: string;
  category: AgentRunArtifactCategory;
  label: string;
  attemptId: string;
}): string {
  const timestamp = input.savedAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = randomUUID().slice(0, 8);
  return [
    timestamp || String(Date.now()),
    input.category,
    normalizeArtifactName(input.label),
    normalizeArtifactName(input.attemptId),
    suffix,
  ].join("_");
}

async function collectAgentRunArtifactFiles(
  workspaceRoot: string,
  storageLayout: StepCliResolvedStorageLayout,
): Promise<string[]> {
  const files: string[] = [];
  const searchRoots = [
    getAgentRunArtifactRootDirectory(storageLayout),
    ...Object.values(LEGACY_ARTIFACT_PATH_SEGMENTS).map((segments) =>
      path.join(workspaceRoot, ...segments),
    ),
  ];

  for (const root of searchRoots) {
    await walkArtifactFiles(root, files);
  }

  files.sort((left, right) => left.localeCompare(right));
  return files;
}

async function walkArtifactFiles(root: string, files: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isFileNotFound(error)) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkArtifactFiles(fullPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(fullPath);
    }
  }
}

async function resolveAgentRunArtifactPath(
  workspaceRoot: string,
  reference: string,
  storageLayout: StepCliResolvedStorageLayout,
): Promise<string | null> {
  const trimmed = reference.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const explicitCandidates = path.isAbsolute(trimmed)
    ? [trimmed]
    : [path.resolve(workspaceRoot, trimmed)];
  for (const candidate of explicitCandidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  const matches: string[] = [];
  const files = await collectAgentRunArtifactFiles(
    workspaceRoot,
    storageLayout,
  );
  for (const filePath of files) {
    if (path.basename(filePath, ".json") === trimmed) {
      matches.push(filePath);
    }
  }

  if (matches.length === 0) {
    return null;
  }
  if (matches.length === 1) {
    return matches[0] ?? null;
  }

  throw new Error(
    `Artifact reference '${trimmed}' is ambiguous; matches: ${matches.map((filePath) => toWorkspaceRelativePath(workspaceRoot, filePath)).join(", ")}`,
  );
}

async function readStoredAgentRunArtifact(
  workspaceRoot: string,
  absolutePath: string,
): Promise<AgentRunArtifactEntry | null> {
  let raw: string;
  try {
    raw = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      return null;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const artifact = parsePersistedAgentRunArtifact(
    parsed,
    path.basename(absolutePath, ".json"),
  );
  if (!artifact) {
    return null;
  }

  const relativePath = toWorkspaceRelativePath(workspaceRoot, absolutePath);
  const summary = buildArtifactSummary(artifact, absolutePath, relativePath);

  return {
    ref: summary,
    summary,
    artifact,
  };
}

function parsePersistedAgentRunArtifact(
  value: unknown,
  fallbackArtifactId: string,
): PersistedAgentRunArtifact | null {
  const entry = asRecord(value);
  if (!entry) {
    return null;
  }
  if (entry.kind !== undefined && entry.kind !== "agent_run") {
    return null;
  }

  const category = parseArtifactCategory(entry.category);
  const savedAt = readNonEmptyString(entry.savedAt);
  if (!category || !savedAt) {
    return null;
  }

  const artifactId = readNonEmptyString(entry.artifactId) ?? fallbackArtifactId;
  const label =
    typeof entry.label === "string" ? entry.label : fallbackArtifactId;
  const prompt = typeof entry.prompt === "string" ? entry.prompt : "";
  const output = typeof entry.output === "string" ? entry.output : "";
  const steps = typeof entry.steps === "number" ? entry.steps : 0;
  const toolCalls = typeof entry.toolCalls === "number" ? entry.toolCalls : 0;
  const harness = asRecord(entry.harness) ?? {};
  const run = asRecord(entry.run) ?? {};
  const notes = asRecord(entry.notes) ?? undefined;

  return {
    schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
    kind: "agent_run",
    artifactId,
    savedAt,
    category,
    label,
    prompt,
    harness,
    run,
    steps,
    toolCalls,
    output,
    actions: Array.isArray(entry.actions)
      ? (entry.actions as AgentRunResult["actions"])
      : [],
    stateTimeline: Array.isArray(entry.stateTimeline)
      ? (entry.stateTimeline as AgentRunResult["stateTimeline"])
      : [],
    notes,
  };
}

function buildArtifactSummary(
  artifact: PersistedAgentRunArtifact,
  absolutePath: string,
  relativePath: string,
): AgentRunArtifactSummary {
  const sessionId = readArtifactSessionId(artifact);
  const goalId = readArtifactGoalId(artifact);
  const attemptId = readArtifactAttemptId(artifact);
  const harness = asRecord(artifact.harness);
  const harnessKind = parseHarnessKind(harness?.kind);
  const harnessId = readNonEmptyString(harness?.id);
  const harnessName = readNonEmptyString(harness?.name);

  return {
    kind: "agent_run",
    category: artifact.category,
    artifactId: artifact.artifactId,
    absolutePath,
    relativePath,
    savedAt: artifact.savedAt,
    sessionId,
    goalId,
    attemptId,
    label: artifact.label,
    harnessId,
    harnessKind,
    harnessName,
    steps: artifact.steps,
    toolCalls: artifact.toolCalls,
    promptPreview: shortenLine(artifact.prompt, 96),
    outputPreview: shortenLine(artifact.output, 120),
  };
}

function matchesArtifactQuery(
  summary: AgentRunArtifactSummary,
  query: AgentRunArtifactQuery,
): boolean {
  if (query.category && summary.category !== query.category) {
    return false;
  }
  if (query.sessionId && summary.sessionId !== query.sessionId) {
    return false;
  }
  if (query.goalId && summary.goalId !== query.goalId) {
    return false;
  }
  if (query.attemptId && summary.attemptId !== query.attemptId) {
    return false;
  }
  if (query.harnessKind && summary.harnessKind !== query.harnessKind) {
    return false;
  }
  if (query.harnessName && summary.harnessName !== query.harnessName) {
    return false;
  }
  if (query.labelIncludes) {
    const needle = query.labelIncludes.trim().toLowerCase();
    if (needle.length > 0 && !summary.label.toLowerCase().includes(needle)) {
      return false;
    }
  }
  return true;
}

function compareAgentRunArtifacts(
  left: AgentRunArtifactSummary,
  right: AgentRunArtifactSummary,
): number {
  const timeDiff =
    parseArtifactTimestamp(right.savedAt) -
    parseArtifactTimestamp(left.savedAt);
  if (timeDiff !== 0) {
    return timeDiff;
  }
  return right.artifactId.localeCompare(left.artifactId);
}

function parseArtifactTimestamp(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeArtifactScopeId(value: unknown, fallback: string): string {
  const candidate = readNonEmptyString(value);
  return candidate ?? fallback;
}

function readArtifactSessionId(
  artifact: PersistedAgentRunArtifact,
): string | null {
  return (
    readNonEmptyString(asRecord(artifact.run)?.sessionId) ??
    readNonEmptyString(asRecord(artifact.harness)?.sessionId)
  );
}

function readArtifactGoalId(
  artifact: PersistedAgentRunArtifact,
): string | null {
  return (
    readNonEmptyString(asRecord(artifact.run)?.goalId) ??
    readNonEmptyString(asRecord(artifact.harness)?.goalId)
  );
}

function readArtifactAttemptId(
  artifact: PersistedAgentRunArtifact,
): string | null {
  return readNonEmptyString(asRecord(artifact.run)?.attemptId);
}

function normalizeArtifactName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "run";
}

function toWorkspaceRelativePath(
  workspaceRoot: string,
  absolutePath: string,
): string {
  if (absolutePath.startsWith(workspaceRoot)) {
    return path.relative(workspaceRoot, absolutePath) || absolutePath;
  }
  return absolutePath;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isFileNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseArtifactCategory(
  value: unknown,
): AgentRunArtifactCategory | null {
  return value === "subagent" || value === "teammate" ? value : null;
}

function parseHarnessKind(value: unknown): AgentHarnessKind | null {
  return value === "main" || value === "subagent" || value === "teammate"
    ? value
    : null;
}
