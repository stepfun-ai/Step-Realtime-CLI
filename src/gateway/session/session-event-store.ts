import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, StepCliVerifierVerdict } from "@step-cli/protocol";
import { isFileNotFound } from "@step-cli/utils/fs.js";
import {
  cloneStepCliVerifierVerdict,
  isStepCliVerifierVerdict,
} from "../verifier.js";
import {
  isSessionSnapshot,
  type SessionSnapshot,
  type SessionSnapshotV4,
} from "./session-store.js";

const SESSION_EVENT_SCHEMA_VERSION = 1;

type SessionEventKind =
  | "session.initialized"
  | "session.message"
  | "session.state"
  | "session.verifier.verdict";

interface SessionEventEnvelopeBase {
  schemaVersion: 1;
  eventId: string;
  kind: SessionEventKind;
  recordedAt: string;
  sessionId: string;
  goalId: string;
}

interface SessionInitializedEvent extends SessionEventEnvelopeBase {
  kind: "session.initialized";
  payload: {
    snapshot: SessionSnapshotV4;
  };
}

interface SessionMessageEvent extends SessionEventEnvelopeBase {
  kind: "session.message";
  payload: {
    message: ChatMessage;
  };
}

interface SessionStateEvent extends SessionEventEnvelopeBase {
  kind: "session.state";
  payload: {
    snapshot: SessionSnapshotV4;
  };
}

interface SessionVerifierVerdictEvent extends SessionEventEnvelopeBase {
  kind: "session.verifier.verdict";
  payload: {
    verifier: StepCliVerifierVerdict;
  };
}

type SessionEventEnvelope =
  | SessionInitializedEvent
  | SessionMessageEvent
  | SessionStateEvent
  | SessionVerifierVerdictEvent;

export interface SessionEventStoreOptions {
  snapshotFile: string;
  eventsFile?: string;
}

export class SessionEventStore {
  private readonly snapshotFile: string;
  private readonly eventsFile?: string;
  private persistedMessageCount = 0;
  private persistedVerifierKey: string | null = null;

  constructor(options: SessionEventStoreOptions) {
    this.snapshotFile = options.snapshotFile;
    this.eventsFile = options.eventsFile;
  }

  getFilePath(): string {
    return this.snapshotFile;
  }

  async load(): Promise<SessionSnapshot | null> {
    const snapshot = await this.loadFromSnapshotFile();
    if (snapshot) {
      this.persistedMessageCount = snapshot.memory.messages.length;
      this.persistedVerifierKey = serializeVerifierVerdict(
        "runtime" in snapshot ? snapshot.runtime?.verifier : undefined,
      );
      return snapshot;
    }

    const legacySnapshot = await this.loadLegacySnapshotFromEvents();
    if (!legacySnapshot) {
      return null;
    }

    this.persistedMessageCount = legacySnapshot.memory.messages.length;
    this.persistedVerifierKey = serializeVerifierVerdict(
      "runtime" in legacySnapshot
        ? legacySnapshot.runtime?.verifier
        : undefined,
    );
    return legacySnapshot;
  }

  async save(snapshot: SessionSnapshotV4): Promise<void> {
    if (snapshot.memory.messages.length < this.persistedMessageCount) {
      this.persistedMessageCount = 0;
    }

    const nextVerifierKey = serializeVerifierVerdict(snapshot.runtime.verifier);

    await writeSnapshotFile(this.snapshotFile, snapshot);

    if (this.eventsFile) {
      const events: SessionEventEnvelope[] = [];
      for (const message of snapshot.memory.messages.slice(
        this.persistedMessageCount,
      )) {
        events.push(buildMessageEvent(snapshot, message));
      }
      if (
        nextVerifierKey !== null &&
        nextVerifierKey !== this.persistedVerifierKey
      ) {
        events.push(
          buildVerifierVerdictEvent(snapshot, snapshot.runtime.verifier),
        );
      }
      await appendEvents(this.eventsFile, events);
    }

    this.persistedMessageCount = snapshot.memory.messages.length;
    this.persistedVerifierKey = nextVerifierKey;
  }

  private async loadFromSnapshotFile(): Promise<SessionSnapshot | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.snapshotFile, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        return null;
      }
      throw error;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }

    return isSessionSnapshot(parsed) ? parsed : null;
  }

  private async loadLegacySnapshotFromEvents(): Promise<SessionSnapshot | null> {
    for (const eventsFile of this.getLegacyEventsFiles()) {
      const snapshot = await loadLegacySnapshotFromEventsFile(eventsFile);
      if (snapshot) {
        return snapshot;
      }
    }

    return null;
  }

  private getLegacyEventsFiles(): string[] {
    return [
      ...new Set(
        [this.eventsFile, this.snapshotFile].filter(
          (filePath): filePath is string => Boolean(filePath),
        ),
      ),
    ];
  }
}

async function loadLegacySnapshotFromEventsFile(
  eventsFile: string,
): Promise<SessionSnapshot | null> {
  let raw: string;
  try {
    raw = await fs.readFile(eventsFile, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      return null;
    }
    throw error;
  }

  let latestInit: SessionSnapshotV4 | null = null;
  let latestState: SessionSnapshotV4 | null = null;
  let latestVerifier: StepCliVerifierVerdict | undefined;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const event = parseSessionEventEnvelope(parsed);
    if (!event) {
      continue;
    }

    if (event.kind === "session.initialized") {
      latestInit = event.payload.snapshot;
      continue;
    }

    if (event.kind === "session.state") {
      latestState = event.payload.snapshot;
      continue;
    }

    if (event.kind === "session.verifier.verdict") {
      latestVerifier = cloneStepCliVerifierVerdict(event.payload.verifier);
    }
  }

  const snapshot = latestState ?? latestInit;
  if (!snapshot) {
    return null;
  }

  return latestVerifier
    ? {
        ...snapshot,
        runtime: {
          ...snapshot.runtime,
          verifier: latestVerifier,
        },
      }
    : snapshot;
}

async function writeSnapshotFile(
  snapshotFile: string,
  snapshot: SessionSnapshotV4,
): Promise<void> {
  await fs.mkdir(path.dirname(snapshotFile), { recursive: true });
  const tempFile = `${snapshotFile}.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(tempFile, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tempFile, snapshotFile);
  } catch (error) {
    await fs.rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

function buildMessageEvent(
  snapshot: SessionSnapshotV4,
  message: ChatMessage,
): SessionMessageEvent {
  return {
    schemaVersion: SESSION_EVENT_SCHEMA_VERSION,
    eventId: randomUUID(),
    kind: "session.message",
    recordedAt: new Date().toISOString(),
    sessionId: snapshot.runtime.sessionId,
    goalId: snapshot.runtime.goalId,
    payload: {
      message,
    },
  };
}

function buildVerifierVerdictEvent(
  snapshot: SessionSnapshotV4,
  verifier: StepCliVerifierVerdict | undefined,
): SessionVerifierVerdictEvent {
  if (!verifier) {
    throw new Error(
      "Cannot persist a verifier event without a verdict payload.",
    );
  }

  return {
    schemaVersion: SESSION_EVENT_SCHEMA_VERSION,
    eventId: randomUUID(),
    kind: "session.verifier.verdict",
    recordedAt: new Date().toISOString(),
    sessionId: snapshot.runtime.sessionId,
    goalId: snapshot.runtime.goalId,
    payload: {
      verifier: cloneStepCliVerifierVerdict(verifier),
    },
  };
}

async function appendEvents(
  eventsFile: string,
  events: SessionEventEnvelope[],
): Promise<void> {
  if (events.length === 0) {
    return;
  }

  await fs.mkdir(path.dirname(eventsFile), { recursive: true });
  const handle = await fs.open(eventsFile, "a", 0o600);
  try {
    await handle.writeFile(
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseSessionEventEnvelope(
  value: unknown,
): SessionEventEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== SESSION_EVENT_SCHEMA_VERSION ||
    typeof candidate.eventId !== "string" ||
    typeof candidate.recordedAt !== "string" ||
    typeof candidate.sessionId !== "string" ||
    typeof candidate.goalId !== "string"
  ) {
    return null;
  }

  if (
    candidate.kind !== "session.initialized" &&
    candidate.kind !== "session.message" &&
    candidate.kind !== "session.state" &&
    candidate.kind !== "session.verifier.verdict"
  ) {
    return null;
  }

  const payload =
    candidate.payload && typeof candidate.payload === "object"
      ? (candidate.payload as Record<string, unknown>)
      : null;
  if (!payload) {
    return null;
  }

  if (candidate.kind === "session.message") {
    const message = payload.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return null;
    }
    return candidate as unknown as SessionMessageEvent;
  }

  if (candidate.kind === "session.verifier.verdict") {
    return isStepCliVerifierVerdict(payload.verifier)
      ? (candidate as unknown as SessionVerifierVerdictEvent)
      : null;
  }

  if (!isSessionSnapshot(payload.snapshot)) {
    return null;
  }

  return candidate as unknown as SessionInitializedEvent | SessionStateEvent;
}

function serializeVerifierVerdict(
  verifier: StepCliVerifierVerdict | undefined,
): string | null {
  return verifier
    ? JSON.stringify(cloneStepCliVerifierVerdict(verifier))
    : null;
}
