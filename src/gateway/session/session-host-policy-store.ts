import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  StepCliSessionHostPolicyPatch,
  StepCliSessionHostPolicyRecord,
  StepCliSessionMaintenancePolicy,
  StepCliSessionProactivePolicy,
} from "@step-cli/protocol";
import { isFileNotFound } from "@step-cli/utils/fs.js";

export interface SessionHostPolicyStoreOptions {
  filePath: string;
}

const EMPTY_HOST_POLICY: StepCliSessionHostPolicyRecord = {
  proactive: null,
  maintenance: null,
};

export class SessionHostPolicyStore {
  private readonly filePath: string;

  constructor(options: SessionHostPolicyStoreOptions) {
    this.filePath = options.filePath;
  }

  getFilePath(): string {
    return this.filePath;
  }

  async load(): Promise<StepCliSessionHostPolicyRecord> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        return cloneHostPolicyRecord(EMPTY_HOST_POLICY);
      }
      throw error;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      return cloneHostPolicyRecord(EMPTY_HOST_POLICY);
    }

    const parsed: unknown = JSON.parse(trimmed);
    return parseHostPolicyRecord(parsed, this.filePath);
  }

  async save(record: StepCliSessionHostPolicyRecord): Promise<void> {
    const normalized = parseHostPolicyRecord(record, this.filePath);
    await writeJsonFile(this.filePath, normalized);
  }

  saveSync(record: StepCliSessionHostPolicyRecord): void {
    const normalized = parseHostPolicyRecord(record, this.filePath);
    writeJsonFileSync(this.filePath, normalized);
  }

  async update(
    patch: StepCliSessionHostPolicyPatch,
    current?: StepCliSessionHostPolicyRecord,
  ): Promise<StepCliSessionHostPolicyRecord> {
    const next = mergeHostPolicyRecord(
      current ?? (await this.load()),
      patch,
      this.filePath,
    );
    await this.save(next);
    return next;
  }

  updateSync(
    patch: StepCliSessionHostPolicyPatch,
    current?: StepCliSessionHostPolicyRecord,
  ): StepCliSessionHostPolicyRecord {
    const next = mergeHostPolicyRecord(
      current ?? this.loadSync(),
      patch,
      this.filePath,
    );
    this.saveSync(next);
    return next;
  }

  loadSync(): StepCliSessionHostPolicyRecord {
    let raw: string;
    try {
      raw = fsSync.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        return cloneHostPolicyRecord(EMPTY_HOST_POLICY);
      }
      throw error;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      return cloneHostPolicyRecord(EMPTY_HOST_POLICY);
    }

    const parsed: unknown = JSON.parse(trimmed);
    return parseHostPolicyRecord(parsed, this.filePath);
  }
}

function mergeHostPolicyRecord(
  current: StepCliSessionHostPolicyRecord,
  patch: StepCliSessionHostPolicyPatch,
  source: string,
): StepCliSessionHostPolicyRecord {
  return {
    proactive: mergeProactivePolicy(current.proactive, patch.proactive, source),
    maintenance: mergeMaintenancePolicy(
      current.maintenance,
      patch.maintenance,
      source,
    ),
  };
}

function parseHostPolicyRecord(
  value: unknown,
  source: string,
): StepCliSessionHostPolicyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid host policy payload: ${source}`);
  }

  const record = value as Record<string, unknown>;
  return {
    proactive: parseLoadedProactivePolicy(record.proactive, source),
    maintenance: parseLoadedMaintenancePolicy(record.maintenance, source),
  };
}

function parseLoadedProactivePolicy(
  value: unknown,
  source: string,
): StepCliSessionProactivePolicy | null {
  if (value == null) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid proactive host policy payload: ${source}`);
  }

  const record = stripUndefinedFields(value as Record<string, unknown>);
  const { enabled } = record;
  if (typeof enabled !== "boolean") {
    throw new Error(
      `Proactive host policy requires boolean 'enabled': ${source}`,
    );
  }

  const policy: StepCliSessionProactivePolicy = { enabled };
  if (typeof record.paused === "boolean") {
    policy.paused = record.paused;
  }
  if (typeof record.minIdleMs === "number") {
    policy.minIdleMs = record.minIdleMs;
  }
  if (typeof record.defaultSleepMs === "number") {
    policy.defaultSleepMs = record.defaultSleepMs;
  }
  if (typeof record.maxSleepMs === "number") {
    policy.maxSleepMs = record.maxSleepMs;
  }
  if (typeof record.maxConsecutiveNoopTicks === "number") {
    policy.maxConsecutiveNoopTicks = record.maxConsecutiveNoopTicks;
  }
  if (record.lastTickAt === null || typeof record.lastTickAt === "string") {
    policy.lastTickAt = record.lastTickAt;
  }
  if (record.nextTickAt === null || typeof record.nextTickAt === "string") {
    policy.nextTickAt = record.nextTickAt;
  }

  return policy;
}

function parseLoadedMaintenancePolicy(
  value: unknown,
  source: string,
): StepCliSessionMaintenancePolicy | null {
  if (value == null) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid maintenance host policy payload: ${source}`);
  }

  const record = stripUndefinedFields(value as Record<string, unknown>);
  const { autoDreamEnabled } = record;
  if (typeof autoDreamEnabled !== "boolean") {
    throw new Error(
      `Maintenance host policy requires boolean 'autoDreamEnabled': ${source}`,
    );
  }

  const policy: StepCliSessionMaintenancePolicy = { autoDreamEnabled };
  if (typeof record.minIntervalMinutes === "number") {
    policy.minIntervalMinutes = record.minIntervalMinutes;
  }
  if (typeof record.minTurnsSinceLastDream === "number") {
    policy.minTurnsSinceLastDream = record.minTurnsSinceLastDream;
  }
  if (record.executionMode === "same_session_wake") {
    policy.executionMode = record.executionMode;
  }
  if (typeof record.dreamRunning === "boolean") {
    policy.dreamRunning = record.dreamRunning;
  }
  if (typeof record.runningJobId === "string") {
    policy.runningJobId = record.runningJobId;
  }
  if (
    record.nextEligibleDreamAt === null ||
    typeof record.nextEligibleDreamAt === "string"
  ) {
    policy.nextEligibleDreamAt = record.nextEligibleDreamAt;
  }
  if (record.lastDreamAt === null || typeof record.lastDreamAt === "string") {
    policy.lastDreamAt = record.lastDreamAt;
  }
  if (
    record.lastDreamStatus === "idle" ||
    record.lastDreamStatus === "running" ||
    record.lastDreamStatus === "completed" ||
    record.lastDreamStatus === "failed" ||
    record.lastDreamStatus === "skipped"
  ) {
    policy.lastDreamStatus = record.lastDreamStatus;
  }
  if (typeof record.lastDreamSummary === "string") {
    policy.lastDreamSummary = record.lastDreamSummary;
  }
  if (typeof record.lastDreamSkipReason === "string") {
    policy.lastDreamSkipReason = record.lastDreamSkipReason;
  }

  return policy;
}

function mergeProactivePolicy(
  current: StepCliSessionProactivePolicy | null,
  patch: StepCliSessionHostPolicyPatch["proactive"],
  source: string,
): StepCliSessionProactivePolicy | null {
  if (patch === undefined) {
    return current ? { ...current } : null;
  }
  if (patch === null) {
    return null;
  }

  const next = parseLoadedProactivePolicy(
    Object.assign({}, current, patch),
    source,
  );
  if (!next) {
    throw new Error(
      "Proactive host policy requires 'enabled' when creating or updating a policy",
    );
  }
  return next;
}

function mergeMaintenancePolicy(
  current: StepCliSessionMaintenancePolicy | null,
  patch: StepCliSessionHostPolicyPatch["maintenance"],
  source: string,
): StepCliSessionMaintenancePolicy | null {
  if (patch === undefined) {
    return current ? { ...current } : null;
  }
  if (patch === null) {
    return null;
  }

  const next = parseLoadedMaintenancePolicy(
    Object.assign({}, current, patch),
    source,
  );
  if (!next) {
    throw new Error(
      "Maintenance host policy requires 'autoDreamEnabled' when creating or updating a policy",
    );
  }
  return next;
}

function stripUndefinedFields(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function cloneHostPolicyRecord(
  value: StepCliSessionHostPolicyRecord,
): StepCliSessionHostPolicyRecord {
  return {
    proactive: value.proactive ? { ...value.proactive } : null,
    maintenance: value.maintenance ? { ...value.maintenance } : null,
  };
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

function writeJsonFileSync(filePath: string, value: unknown): void {
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  fsSync.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fsSync.renameSync(tempPath, filePath);
}
