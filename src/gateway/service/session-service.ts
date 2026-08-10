import type { Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import {
  StepCli,
  type StepCliConfig,
  type StepCliRuntimeSummary as GatewayRuntimeSummary,
  type StepCliTurnResult as GatewayTurnResult,
} from "../runtime.js";
import { SessionEventStore } from "../session/session-event-store.js";
import {
  decodeStorageKey,
  getSessionDirectory,
  getSessionEventsFilePath,
  getSessionHostPolicyFilePath,
  getSessionSnapshotFilePath,
  getSessionTriggersFilePath,
  getSessionsRootDirectory,
  resolveStorageLayout,
  resolveStorageRootDirectory,
  type StepCliResolvedStorageLayout,
} from "../storage/layout.js";
import type {
  SessionSnapshot,
  SessionSnapshotV4,
} from "../session/session-store.js";
import { SessionHostPolicyStore } from "../session/session-host-policy-store.js";
import type {
  SessionWakeReason,
  StepCliActiveGoal,
  StepCliGoalControlRequest,
  StepCliGoalResumeRequest,
  StepCliGoalResult,
  StepCliSessionClarificationResult,
  StepCliSessionClarificationSubmission,
  StepCliSessionClarificationSubmissionResult,
  StepCliSessionDescriptor,
  StepCliSessionEvent,
  StepCliSessionHookEventPayload,
  StepCliSessionHostMaintenanceSnapshot,
  StepCliSessionObserverEventPayload,
  StepCliSessionHostPolicyPatch,
  StepCliSessionHostPolicyRecord,
  StepCliSessionHostProactiveSnapshot,
  StepCliSessionHostSnapshot,
  StepCliSessionSnapshot as ProtocolSessionSnapshot,
  StepCliSessionRunResult,
  StepCliSessionSnapshotResult,
  StepCliSlashCommandResult,
  StepCliRuntimeSummary as ProtocolRuntimeSummary,
  StepCliTurnResult as ProtocolTurnResult,
  StepCliSessionWakeReceipt,
  StepCliSessionWakeRequest,
  StepCliStartGoalRequest,
  UserClarificationRequest,
  UserClarificationResponse,
  UserTurnInput,
} from "@step-cli/protocol";
import {
  cloneUserClarificationResponse,
  cloneUserClarificationRuntimeState,
  parseClarificationAnswer,
} from "@step-cli/utils/clarification.js";
import { cloneContextAssembly } from "@step-cli/core/agent/context-assembly.js";
import { cloneStepCliVerifierVerdict } from "../verifier.js";
import {
  isUserTurnEmpty,
  normalizeUserTurnInput,
} from "@step-cli/utils/user-message.js";
import { toErrorMessage } from "@step-cli/utils/error.js";
import { SessionEventBus } from "./session-event-bus.js";
import { SessionScheduler } from "./session-scheduler.js";
import { SessionProactiveController } from "./session-proactive-controller.js";
import { SessionQueue } from "./session-queue.js";

export type {
  StepCliSessionClarificationResult,
  StepCliSessionClarificationSubmission,
  StepCliSessionClarificationSubmissionResult,
  StepCliSessionDescriptor,
  StepCliSessionRunResult,
  StepCliSessionSnapshotResult,
} from "@step-cli/protocol";

interface PersistedSessionRecord {
  id: string;
  sessionFile: string;
  createdAt: string | null;
  lastUsedAt: string | null;
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

interface PendingClarificationResolver {
  request: UserClarificationRequest;
  resolve: (response: UserClarificationResponse) => void;
}

interface ActiveSession {
  app: StepCli;
  sessionFile: string;
  persisted: boolean;
  createdAt: string;
  lastUsedAt: string;
  running: boolean;
  closing: boolean;
  notices: string[];
  hostPolicy: StepCliSessionHostPolicyRecord;
  pendingClarification: PendingClarificationResolver | null;
  abortControllers: Set<AbortController>;
  activeRuns: Set<Promise<GatewayTurnResult>>;
  abortController: AbortController | null;
  activeRun: Promise<GatewayTurnResult> | null;
  wakeQueue: SessionQueue<GatewayTurnResult>;
  pendingWakeCount: number;
  activeWakeId: string | null;
  activeGoal: StepCliActiveGoal | null;
}

interface NormalizedWakeRequest {
  reason: SessionWakeReason;
  prompt: UserTurnInput;
  metadata?: Record<string, unknown>;
}

interface PreparedWake {
  sessionId: string;
  created: boolean;
  notices: string[];
  session: StepCliSessionDescriptor;
  wakeId: string;
  eventId: string;
  queueDepth: number;
  runPromise: Promise<GatewayTurnResult>;
}

interface ParsedGoalRunDisposition {
  disposition: "completed" | "continue" | "waiting_for_user" | "failed";
  reason?: string;
}

export class StepCliSessionService {
  private readonly baseConfig: StepCliConfig;
  private readonly storageLayout: StepCliResolvedStorageLayout;
  private readonly storageRootDir: string;
  private readonly sessionsDir: string;
  private readonly resumeSession: boolean;
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly eventBus = new SessionEventBus();
  private readonly scheduler: SessionScheduler;
  private readonly proactiveController: SessionProactiveController;
  private readonly bootstrapPromise: Promise<void>;

  constructor(
    baseConfig: StepCliConfig,
    options: {
      storageRootDir: string;
      resumeSession?: boolean;
    },
  ) {
    this.baseConfig = {
      ...baseConfig,
      sessionFile: undefined,
      resumeSession: false,
      useAlternateScreen: false,
    };
    this.storageLayout = resolveStorageLayout(
      resolveStorageRootDirectory(
        baseConfig.workspaceRoot,
        options.storageRootDir,
      ),
      baseConfig.storageLayout.paths,
    );
    this.storageRootDir = this.storageLayout.rootDir;
    this.sessionsDir = getSessionsRootDirectory(this.storageLayout);
    this.resumeSession = options.resumeSession ?? true;
    this.scheduler = new SessionScheduler({
      storageLayout: this.storageLayout,
      enqueueWake: async (sessionId, request) =>
        await this.enqueueWake(sessionId, request),
    });
    this.proactiveController = new SessionProactiveController({
      getSessionSnapshot: async (sessionId) =>
        await this.getSessionSnapshot(sessionId),
      getSessionHostPolicy: async (sessionId) =>
        await this.getSessionHostPolicy(sessionId),
      updateSessionHostPolicy: async (sessionId, patch) =>
        this.sessions.has(sessionId)
          ? this.applySessionHostPolicyPatchSync(sessionId, patch)
          : await this.applySessionHostPolicyPatch(sessionId, patch),
      enqueueWake: async (sessionId, request) =>
        await this.enqueueWake(sessionId, request),
      publishEvent: ({ sessionId, kind, payload }) => {
        this.publishSessionEvent(sessionId, {
          kind,
          payload,
        });
      },
    });
    this.bootstrapPromise = this.bootstrapPersistedSessions();
    void this.bootstrapPromise.catch(() => undefined);
  }

  getStorageRootDirectory(): string {
    return this.storageRootDir;
  }

  getSessionDirectory(): string {
    return this.sessionsDir;
  }

  getLoadedSessionCount(): number {
    return this.sessions.size;
  }

  async waitUntilReady(): Promise<void> {
    await this.bootstrapPromise;
  }

  async listSessions(): Promise<StepCliSessionDescriptor[]> {
    await this.bootstrapPromise;
    const persisted = await this.readPersistedSessions();
    const descriptors = new Map<string, StepCliSessionDescriptor>();

    for (const record of persisted) {
      descriptors.set(record.id, {
        id: record.id,
        loaded: false,
        running: false,
        persisted: true,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
        sessionFile: record.sessionFile,
      });
    }

    for (const [sessionId, entry] of this.sessions.entries()) {
      descriptors.set(sessionId, this.buildLoadedDescriptor(sessionId, entry));
    }

    return [...descriptors.values()].sort((left, right) => {
      const leftTime = Date.parse(left.lastUsedAt ?? left.createdAt ?? "") || 0;
      const rightTime =
        Date.parse(right.lastUsedAt ?? right.createdAt ?? "") || 0;
      return rightTime - leftTime || left.id.localeCompare(right.id);
    });
  }

  async getSession(
    sessionIdInput: string,
  ): Promise<StepCliSessionDescriptor | null> {
    const sessionId = normalizeSessionId(sessionIdInput);
    const loaded = this.sessions.get(sessionId);
    if (loaded) {
      return this.buildLoadedDescriptor(sessionId, loaded);
    }

    const sessionFile = this.getSessionFilePath(sessionId);
    const stats = await this.getPersistedSessionStats(sessionId);
    if (!stats) {
      return null;
    }

    return {
      id: sessionId,
      loaded: false,
      running: false,
      persisted: true,
      createdAt: toIsoOrNull(stats.birthtimeMs),
      lastUsedAt: toIsoOrNull(stats.mtimeMs),
      sessionFile,
    };
  }

  async getSessionSnapshot(
    sessionIdInput: string,
  ): Promise<StepCliSessionSnapshotResult | null> {
    const sessionId = normalizeSessionId(sessionIdInput);
    const loaded = this.sessions.get(sessionId);
    if (loaded) {
      const snapshot = attachActiveGoalToSnapshot(
        toProtocolSessionSnapshot(loaded.app.exportSessionSnapshot()),
        loaded.activeGoal,
      );
      return {
        session: this.buildLoadedDescriptor(sessionId, loaded),
        snapshot,
        host: this.buildSessionHostSnapshot(sessionId, loaded),
      };
    }

    const snapshot = await this.createSessionEventStore(sessionId).load();
    if (snapshot) {
      const session = await this.getSession(sessionId);
      if (!session) {
        return null;
      }
      const activeGoal = extractActiveGoalFromSnapshot(snapshot);

      return {
        session: withSessionActiveGoal(session, activeGoal),
        snapshot: attachActiveGoalToSnapshot(
          toProtocolSessionSnapshot(snapshot),
          activeGoal,
        ),
        host: this.buildSessionHostSnapshot(
          sessionId,
          undefined,
          await this.loadSessionHostPolicy(sessionId),
        ),
      };
    }

    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }

    await this.ensureSession(sessionId);
    const reloaded = this.sessions.get(sessionId);
    if (!reloaded) {
      throw new Error(`Failed to load session snapshot: ${sessionId}`);
    }

    return {
      session: this.buildLoadedDescriptor(sessionId, reloaded),
      snapshot: attachActiveGoalToSnapshot(
        toProtocolSessionSnapshot(reloaded.app.exportSessionSnapshot()),
        reloaded.activeGoal,
      ),
      host: this.buildSessionHostSnapshot(sessionId, reloaded),
    };
  }

  async getSessionHostPolicy(
    sessionIdInput: string,
  ): Promise<StepCliSessionHostPolicyRecord | null> {
    const sessionId = normalizeSessionId(sessionIdInput);
    const loaded = this.sessions.get(sessionId);
    if (loaded) {
      return cloneHostPolicyRecord(loaded.hostPolicy);
    }

    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }

    return await this.loadSessionHostPolicy(sessionId);
  }

  async updateSessionHostPolicy(
    sessionIdInput: string,
    patch: StepCliSessionHostPolicyPatch,
  ): Promise<StepCliSessionHostPolicyRecord> {
    const sessionId = normalizeSessionId(sessionIdInput);
    const next = await this.applySessionHostPolicyPatch(sessionId, patch);
    await this.proactiveController.reloadSession(sessionId);
    return (await this.getSessionHostPolicy(sessionId)) ?? next;
  }

  async startGoal(
    sessionIdInput: string,
    request: StepCliStartGoalRequest,
    signal?: AbortSignal,
  ): Promise<StepCliGoalResult> {
    const sessionId = normalizeSessionId(sessionIdInput);
    const text = normalizeGoalText(request.text);
    await this.ensureSession(sessionId);
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Failed to load session: ${sessionId}`);
    }
    if (entry.closing) {
      throw new Error(`Session '${sessionId}' is closing`);
    }
    if (entry.activeGoal && isNonTerminalGoalStatus(entry.activeGoal.status)) {
      throw new Error(
        `Session '${sessionId}' already has an active goal: ${entry.activeGoal.id}`,
      );
    }

    const now = new Date().toISOString();
    const goal: StepCliActiveGoal = {
      id: randomUUID(),
      sessionId,
      text,
      status: "active",
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      iteration: 0,
      counters: {
        consecutiveFailures: 0,
        totalRuns: 0,
        totalFailures: 0,
      },
    };
    if (request.limits) {
      goal.limits = { ...request.limits };
    }
    entry.activeGoal = goal;
    await this.persistActiveGoalSnapshot(sessionId, entry);

    this.publishSessionEvent(sessionId, {
      kind: "session.goal.started",
      payload: {
        goalId: goal.id,
        status: goal.status,
        iteration: goal.iteration,
        reason: "started",
      },
    });

    const prepared = await this.prepareWake(
      sessionId,
      {
        prompt: buildGoalWakePrompt(goal),
        reason: "goal_start",
        metadata: {
          goalId: goal.id,
        },
      },
      signal,
    );
    goal.lastWakeId = prepared.wakeId;
    goal.updatedAt = new Date().toISOString();
    await this.persistActiveGoalSnapshot(sessionId, entry);
    void prepared.runPromise.catch(() => undefined);

    return {
      session: this.buildLoadedDescriptor(sessionId, entry),
      goal: cloneActiveGoal(goal),
    };
  }

  async getGoalStatus(
    sessionIdInput: string,
  ): Promise<StepCliGoalResult | null> {
    const sessionId = normalizeSessionId(sessionIdInput);
    const loaded = this.sessions.get(sessionId);
    if (loaded) {
      return {
        session: this.buildLoadedDescriptor(sessionId, loaded),
        goal: cloneActiveGoal(loaded.activeGoal),
      };
    }

    const snapshot = await this.createSessionEventStore(sessionId).load();
    const activeGoal = extractActiveGoalFromSnapshot(snapshot);
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }

    return {
      session: withSessionActiveGoal(session, activeGoal),
      goal: cloneActiveGoal(activeGoal),
    };
  }

  async pauseGoal(
    sessionIdInput: string,
    request: StepCliGoalControlRequest = {},
  ): Promise<StepCliGoalResult> {
    const { sessionId, entry, goal } =
      await this.loadGoalControlSession(sessionIdInput);
    if (goal.status !== "paused") {
      goal.status = "paused";
      goal.updatedAt = new Date().toISOString();
      await this.persistActiveGoalSnapshot(sessionId, entry);
      this.publishSessionEvent(sessionId, {
        kind: "session.goal.paused",
        payload: {
          goalId: goal.id,
          status: goal.status,
          iteration: goal.iteration,
          reason: normalizeOptionalReason(request.reason) ?? "paused",
        },
      });
    }

    return {
      session: this.buildLoadedDescriptor(sessionId, entry),
      goal: cloneActiveGoal(goal),
    };
  }

  async resumeGoal(
    sessionIdInput: string,
    request: StepCliGoalResumeRequest = {},
    signal?: AbortSignal,
  ): Promise<StepCliGoalResult> {
    const { sessionId, entry, goal } =
      await this.loadGoalControlSession(sessionIdInput);
    if (request.resetFailures === true && goal.counters) {
      goal.counters.consecutiveFailures = 0;
    }

    if (goal.status !== "active") {
      goal.status = "active";
      goal.updatedAt = new Date().toISOString();
      await this.persistActiveGoalSnapshot(sessionId, entry);
      this.publishSessionEvent(sessionId, {
        kind: "session.goal.resumed",
        payload: {
          goalId: goal.id,
          status: goal.status,
          iteration: goal.iteration,
          reason: normalizeOptionalReason(request.reason) ?? "resumed",
        },
      });
    }

    const prepared = await this.prepareWake(
      sessionId,
      {
        prompt: buildGoalWakePrompt(goal),
        reason: "goal_continue",
        metadata: {
          goalId: goal.id,
        },
      },
      signal,
    );
    goal.lastWakeId = prepared.wakeId;
    goal.updatedAt = new Date().toISOString();
    await this.persistActiveGoalSnapshot(sessionId, entry);
    void prepared.runPromise.catch(() => undefined);

    return {
      session: this.buildLoadedDescriptor(sessionId, entry),
      goal: cloneActiveGoal(goal),
    };
  }

  async stopGoal(
    sessionIdInput: string,
    request: StepCliGoalControlRequest = {},
  ): Promise<StepCliGoalResult> {
    const { sessionId, entry, goal } =
      await this.loadGoalControlSession(sessionIdInput);
    const now = new Date().toISOString();
    const reason = normalizeOptionalReason(request.reason) ?? "stopped";

    goal.status = "stopped";
    goal.stoppedAt = now;
    goal.updatedAt = now;
    goal.stoppedReason = reason;
    await this.persistActiveGoalSnapshot(sessionId, entry);
    this.publishSessionEvent(sessionId, {
      kind: "session.goal.stopped",
      payload: {
        goalId: goal.id,
        status: goal.status,
        iteration: goal.iteration,
        reason,
      },
    });

    return {
      session: this.buildLoadedDescriptor(sessionId, entry),
      goal: cloneActiveGoal(goal),
    };
  }

  async ensureSession(sessionIdInput: string): Promise<{
    created: boolean;
    session: StepCliSessionDescriptor;
  }> {
    const sessionId = normalizeSessionId(sessionIdInput);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return {
        created: false,
        session: this.buildLoadedDescriptor(sessionId, existing),
      };
    }

    await fs.mkdir(this.sessionsDir, { recursive: true });
    const sessionFile = this.getSessionFilePath(sessionId);
    const existingStats = await this.getPersistedSessionStats(sessionId);
    const now = new Date().toISOString();
    const app = await StepCli.create(
      {
        ...this.baseConfig,
        sessionId,
        sessionFile,
        sessionEventsFile: this.getSessionEventsPath(sessionId),
        resumeSession: this.resumeSession,
      },
      {
        clarificationHandler: async (request) => {
          const entry = this.sessions.get(sessionId);
          if (!entry) {
            return {
              cancelled: true,
              reason: `Session '${sessionId}' is no longer available for clarification.`,
            };
          }

          if (entry.pendingClarification) {
            this.publishSessionEvent(sessionId, {
              kind: "session.clarification.resolved",
              payload: {
                cancelled: true,
                reason: "Superseded by a newer clarification request.",
              },
            });
            entry.pendingClarification.resolve({
              cancelled: true,
              reason: "Superseded by a newer clarification request.",
            });
          }

          return await new Promise<UserClarificationResponse>((resolve) => {
            entry.pendingClarification = {
              request,
              resolve,
            };
            this.markActiveGoalWaitingForUser(sessionId, entry, request);
            this.publishSessionEvent(sessionId, {
              kind: "session.clarification.pending",
              payload: {
                question: request.question,
                reason: request.reason,
                optionsCount: request.options?.length ?? 0,
                allowFreeform: request.allowFreeform === true,
              },
            });
          });
        },
        onSessionHook: (payload: StepCliSessionHookEventPayload) => {
          this.publishSessionEvent(sessionId, {
            kind: "session.hook",
            payload: { ...payload },
          });
        },
        onSessionObserver: (payload: StepCliSessionObserverEventPayload) => {
          this.publishSessionEvent(sessionId, {
            kind: "session.observer",
            payload: { ...payload },
          });
        },
      },
    );
    if (this.baseConfig.interactiveUiFactory) {
      await app.attachInteractiveUi(this.baseConfig.interactiveUiFactory);
    }
    const hostPolicy = await this.loadSessionHostPolicy(sessionId);
    const persistedSnapshot =
      await this.createSessionEventStore(sessionId).load();
    const activeGoal = extractActiveGoalFromSnapshot(persistedSnapshot);

    const active: ActiveSession = {
      app,
      sessionFile,
      persisted: Boolean(existingStats),
      createdAt: toIsoOrNull(existingStats?.birthtimeMs) ?? now,
      lastUsedAt: toIsoOrNull(existingStats?.mtimeMs) ?? now,
      running: false,
      closing: false,
      notices: app.getStartupNotices(),
      hostPolicy,
      pendingClarification: null,
      abortControllers: new Set(),
      activeRuns: new Set(),
      abortController: null,
      activeRun: null,
      wakeQueue: new SessionQueue<GatewayTurnResult>(),
      pendingWakeCount: 0,
      activeWakeId: null,
      activeGoal,
    };

    this.sessions.set(sessionId, active);
    this.publishSessionEvent(sessionId, {
      kind: "session.updated",
      payload: {
        state: existingStats ? "loaded" : "created",
      },
    });
    await this.scheduler.reloadSession(sessionId);
    await this.proactiveController.reloadSession(sessionId, {
      preserveScheduledTick: existingStats !== null,
    });
    await this.scheduleRecoveredGoalContinuation(sessionId, active);

    return {
      created: true,
      session: this.buildLoadedDescriptor(sessionId, active),
    };
  }

  subscribeSessionEvents(
    sessionIdInput: string,
    options: {
      afterEventId?: string;
      signal?: AbortSignal;
    } = {},
  ): AsyncIterable<StepCliSessionEvent> {
    const sessionId = normalizeSessionId(sessionIdInput);
    return this.eventBus.subscribe(sessionId, options);
  }

  assertSessionEventCursor(
    sessionIdInput: string,
    afterEventId: string | undefined,
  ): void {
    const sessionId = normalizeSessionId(sessionIdInput);
    this.eventBus.assertCursorAvailable(sessionId, afterEventId);
  }

  async enqueueWake(
    sessionIdInput: string,
    request: StepCliSessionWakeRequest,
    signal?: AbortSignal,
  ): Promise<StepCliSessionWakeReceipt> {
    const prepared = await this.prepareWake(sessionIdInput, request, signal);
    void prepared.runPromise.catch(() => undefined);
    return {
      accepted: true,
      created: prepared.created,
      notices: prepared.notices,
      session: prepared.session,
      wakeId: prepared.wakeId,
      eventId: prepared.eventId,
      queueDepth: prepared.queueDepth,
    };
  }

  async runPrompt(
    sessionIdInput: string,
    prompt: string | UserTurnInput,
    signal?: AbortSignal,
  ): Promise<StepCliSessionRunResult> {
    const prepared = await this.prepareWake(
      sessionIdInput,
      {
        prompt,
        reason: "user",
      },
      signal,
    );
    const entry = this.sessions.get(prepared.sessionId);
    if (!entry) {
      throw new Error(`Failed to load session: ${prepared.sessionId}`);
    }
    const result = await prepared.runPromise;
    return {
      created: prepared.created,
      notices: prepared.notices,
      session: this.buildLoadedDescriptor(prepared.sessionId, entry),
      result: toProtocolTurnResult(result),
    };
  }

  async executeSlashCommand(
    sessionIdInput: string,
    commandLine: string,
  ): Promise<StepCliSlashCommandResult> {
    const sessionId = normalizeSessionId(sessionIdInput);
    await this.ensureSession(sessionId);
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Failed to load session: ${sessionId}`);
    }
    return await entry.app.executeSlashCommandExternal(commandLine);
  }

  async getPendingClarification(
    sessionIdInput: string,
  ): Promise<StepCliSessionClarificationResult | null> {
    const sessionId = normalizeSessionId(sessionIdInput);
    const loaded = this.sessions.get(sessionId);
    if (loaded) {
      const session = this.buildLoadedDescriptor(sessionId, loaded);
      return {
        session,
        clarification: session.runtime?.clarification.pending ?? null,
      };
    }

    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }

    return {
      session,
      clarification: null,
    };
  }

  async submitClarification(
    sessionIdInput: string,
    submission: StepCliSessionClarificationSubmission,
  ): Promise<StepCliSessionClarificationSubmissionResult | null> {
    const sessionId = normalizeSessionId(sessionIdInput);
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      const session = await this.getSession(sessionId);
      if (!session) {
        return null;
      }
      throw new Error(`Session '${sessionId}' has no pending clarification`);
    }

    const pending = entry.pendingClarification;
    if (!pending) {
      throw new Error(`Session '${sessionId}' has no pending clarification`);
    }

    const cancelled = submission.cancelled === true;
    const rawAnswer = submission.answer?.trim();
    if (cancelled && rawAnswer) {
      throw new Error(
        "Clarification submission cannot include both 'cancelled=true' and 'answer'",
      );
    }

    let response: UserClarificationResponse;
    if (cancelled) {
      response = {
        cancelled: true,
        reason:
          normalizeOptionalReason(submission.reason) ??
          "User cancelled clarification.",
      };
    } else {
      if (!rawAnswer) {
        throw new Error(
          "Clarification submission must include a non-empty 'answer' or set 'cancelled=true'",
        );
      }

      const parsed = parseClarificationAnswer(pending.request, rawAnswer);
      if (parsed.kind === "help") {
        throw new Error(
          "Clarification submission must provide an answer, not a help command",
        );
      }
      if (parsed.kind === "invalid") {
        throw new Error(parsed.message);
      }
      response = parsed.response;
    }

    entry.pendingClarification = null;
    if (!response.cancelled) {
      await this.markWaitingGoalActive(sessionId, entry);
    }
    pending.resolve(response);
    this.publishSessionEvent(sessionId, {
      kind: "session.clarification.resolved",
      payload: {
        cancelled: response.cancelled,
        reason: response.cancelled ? response.reason : undefined,
        answer: response.cancelled ? undefined : response.answer,
        source: response.cancelled ? undefined : response.source,
      },
    });
    await Promise.resolve();
    return {
      session: this.buildLoadedDescriptor(sessionId, entry),
      response: cloneUserClarificationResponse(response),
    };
  }

  async deleteSession(
    sessionIdInput: string,
    options: {
      purge?: boolean;
    } = {},
  ): Promise<{
    existed: boolean;
    purged: boolean;
  }> {
    const sessionId = normalizeSessionId(sessionIdInput);
    const existing = this.sessions.get(sessionId);
    if (existing?.closing) {
      throw new Error(`Session '${sessionId}' is closing`);
    }
    if (existing && isSessionBusy(existing)) {
      throw new Error(`Session '${sessionId}' is currently running`);
    }

    if (existing) {
      await this.scheduler.clearSession(sessionId);
      await this.proactiveController.clearSession(sessionId);
      await this.closeLoadedSession(sessionId, existing, {
        reason: `Session '${sessionId}' deleted.`,
      });
      this.sessions.delete(sessionId);
    }
    const persisted = Boolean(await this.getPersistedSessionStats(sessionId));
    const sessionDirectory = this.getSessionDirectoryPath(sessionId);
    const sessionDirExists = await pathExists(sessionDirectory);
    let purged = false;
    if (options.purge) {
      await fs.rm(sessionDirectory, { recursive: true, force: true });
      purged = persisted || sessionDirExists;
    }

    if (existing || persisted || purged) {
      this.publishSessionEvent(sessionId, {
        kind: "session.deleted",
        payload: {
          purgeRequested: options.purge === true,
          purged,
        },
      });
      this.eventBus.clearSession(sessionId);
    }

    return {
      existed: Boolean(existing) || persisted,
      purged,
    };
  }

  async close(
    options: {
      abortRunning?: boolean;
      reason?: string;
    } = {},
  ): Promise<void> {
    const entries = [...this.sessions.entries()];

    try {
      await Promise.allSettled([
        this.scheduler.close(),
        this.proactiveController.close(),
      ]);
      await Promise.allSettled(
        entries.map(async ([sessionId, entry]) => {
          await this.closeLoadedSession(sessionId, entry, options);
        }),
      );
    } finally {
      this.eventBus.retireAllSubscribers();
      this.sessions.clear();
    }
  }

  private async prepareWake(
    sessionIdInput: string,
    request: StepCliSessionWakeRequest,
    signal?: AbortSignal,
  ): Promise<PreparedWake> {
    const sessionId = normalizeSessionId(sessionIdInput);
    const normalizedRequest = normalizeWakeRequest(request);
    const ensured = await this.ensureSession(sessionId);
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Failed to load session: ${sessionId}`);
    }
    if (entry.closing) {
      throw new Error(`Session '${sessionId}' is closing`);
    }

    entry.pendingWakeCount += 1;
    syncSessionRunningState(entry);

    const wakeId = randomUUID();
    const queued = entry.wakeQueue.enqueue(wakeId, async () => {
      return await this.executeQueuedWake(sessionId, entry, {
        wakeId,
        request: normalizedRequest,
        signal,
      });
    });

    const queueDepth = entry.pendingWakeCount;
    const enqueuedEvent = this.publishSessionEvent(sessionId, {
      kind: "session.run.enqueued",
      wakeId,
      reason: normalizedRequest.reason,
      queueDepth,
      outcome: "queued",
      payload: {
        hasAttachments: (normalizedRequest.prompt.attachments?.length ?? 0) > 0,
        metadata: normalizedRequest.metadata ?? null,
      },
    });

    return {
      sessionId,
      created: ensured.created,
      notices: ensured.created ? [...entry.notices] : [],
      session: this.buildLoadedDescriptor(sessionId, entry),
      wakeId,
      eventId: enqueuedEvent.eventId,
      queueDepth,
      runPromise: queued.promise,
    };
  }

  private async executeQueuedWake(
    sessionId: string,
    entry: ActiveSession,
    input: {
      wakeId: string;
      request: NormalizedWakeRequest;
      signal?: AbortSignal;
    },
  ): Promise<GatewayTurnResult> {
    if (entry.closing) {
      entry.pendingWakeCount = Math.max(0, entry.pendingWakeCount - 1);
      syncSessionRunningState(entry);
      throw new Error(`Session '${sessionId}' is closing`);
    }

    const goal = getActiveGoalForWake(entry, input.request);
    if (isGoalWakeRequest(input.request) && entry.activeGoal && !goal) {
      entry.pendingWakeCount = Math.max(0, entry.pendingWakeCount - 1);
      syncSessionRunningState(entry);
      await this.proactiveController.reloadSession(sessionId);
      throw new Error("Skipped goal wake because the goal is no longer active");
    }
    if (goal) {
      const now = new Date().toISOString();
      goal.lastWakeId = input.wakeId;
      goal.lastRunStartedAt = now;
      goal.updatedAt = now;
    }

    entry.activeWakeId = input.wakeId;
    this.publishSessionEvent(sessionId, {
      kind: "session.run.started",
      wakeId: input.wakeId,
      reason: input.request.reason,
      queueDepth: entry.pendingWakeCount,
      outcome: "started",
    });

    const abortController = new AbortController();
    const combined = combineAbortSignals(input.signal, abortController.signal);
    const abortControllers = getAbortControllerSet(entry);
    const activeRuns = getActiveRunSet(entry);
    abortControllers.add(abortController);
    entry.abortController = abortController;
    const runPromise = entry.app.runTurn(input.request.prompt, combined.signal);
    activeRuns.add(runPromise);
    entry.activeRun = runPromise;
    syncSessionRunningState(entry);

    try {
      const result = await runPromise;
      if (goal && entry.activeGoal?.id === goal.id) {
        recordCompletedGoalRun(goal);
      }
      entry.lastUsedAt = new Date().toISOString();
      entry.persisted = await pathExists(entry.sessionFile);
      this.publishSessionEvent(sessionId, {
        kind: "session.run.finished",
        wakeId: input.wakeId,
        reason: input.request.reason,
        queueDepth: Math.max(0, entry.pendingWakeCount - 1),
        outcome: "completed",
        payload: {
          steps: result.steps,
          toolCalls: result.toolCalls,
          outputPreview: result.output.slice(0, 240),
        },
      });
      if (goal && entry.activeGoal?.id === goal.id) {
        await this.applyGoalRunDisposition(
          sessionId,
          entry,
          goal,
          result,
          input.wakeId,
        );
      }
      return result;
    } catch (error) {
      const aborted = isAbortError(error);
      if (!aborted && goal && entry.activeGoal?.id === goal.id) {
        recordFailedGoalRun(goal);
      }
      this.publishSessionEvent(sessionId, {
        kind: "session.run.finished",
        wakeId: input.wakeId,
        reason: input.request.reason,
        queueDepth: Math.max(0, entry.pendingWakeCount - 1),
        outcome: aborted ? "aborted" : "failed",
        payload: {
          error: toErrorMessage(error),
        },
      });
      if (!aborted && goal && entry.activeGoal?.id === goal.id) {
        this.failGoalIfFailureLimitReached(sessionId, goal, input.wakeId);
      }
      throw error;
    } finally {
      combined.dispose();
      activeRuns.delete(runPromise);
      abortControllers.delete(abortController);
      if (entry.activeRun === runPromise) {
        entry.activeRun = null;
      }
      if (entry.abortController === abortController) {
        entry.abortController = null;
      }
      if (entry.activeWakeId === input.wakeId) {
        entry.activeWakeId = null;
      }
      entry.pendingWakeCount = Math.max(0, entry.pendingWakeCount - 1);
      syncSessionRunningState(entry);
      if (entry.activeGoal) {
        await this.persistActiveGoalSnapshot(sessionId, entry).catch(
          () => undefined,
        );
      }
      await this.proactiveController.reloadSession(sessionId);
    }
  }

  private publishSessionEvent(
    sessionId: string,
    input: Omit<Parameters<SessionEventBus["publish"]>[0], "sessionId">,
  ): StepCliSessionEvent {
    const event = this.eventBus.publish({
      sessionId,
      ...input,
    });
    void this.proactiveController
      .handleSessionEvent(event)
      .catch(() => undefined);
    return event;
  }

  private async applyGoalRunDisposition(
    sessionId: string,
    entry: ActiveSession,
    goal: StepCliActiveGoal,
    result: GatewayTurnResult,
    wakeId: string,
  ): Promise<void> {
    if (goal.status !== "active") {
      return;
    }

    const disposition = parseGoalRunDisposition(result.output);
    if (!disposition) {
      return;
    }

    const now = new Date().toISOString();
    const reason = disposition.reason ?? disposition.disposition;
    if (disposition.disposition === "continue") {
      goal.updatedAt = now;
      this.publishSessionEvent(sessionId, {
        kind: "session.goal.updated",
        wakeId,
        payload: {
          goalId: goal.id,
          status: goal.status,
          iteration: goal.iteration,
          disposition: disposition.disposition,
          reason,
          wakeId,
        },
      });
      await this.scheduleGoalContinuation(sessionId, entry, goal, wakeId);
      return;
    }

    if (disposition.disposition === "completed") {
      goal.status = "completed";
      goal.completedAt = now;
      goal.completionReason = reason;
      goal.updatedAt = now;
      this.publishSessionEvent(sessionId, {
        kind: "session.goal.completed",
        wakeId,
        payload: {
          goalId: goal.id,
          status: goal.status,
          iteration: goal.iteration,
          reason,
          wakeId,
        },
      });
      return;
    }

    if (disposition.disposition === "waiting_for_user") {
      goal.status = "waiting_for_user";
      goal.waitingReason = reason;
      goal.updatedAt = now;
      this.publishSessionEvent(sessionId, {
        kind: "session.goal.waiting_for_user",
        wakeId,
        payload: {
          goalId: goal.id,
          status: goal.status,
          iteration: goal.iteration,
          reason,
          wakeId,
        },
      });
      return;
    }

    goal.status = "failed";
    goal.failureReason = reason;
    goal.updatedAt = now;
    this.publishSessionEvent(sessionId, {
      kind: "session.goal.failed",
      wakeId,
      payload: {
        goalId: goal.id,
        status: goal.status,
        iteration: goal.iteration,
        reason,
        wakeId,
      },
    });
  }

  private async scheduleGoalContinuation(
    sessionId: string,
    entry: ActiveSession,
    goal: StepCliActiveGoal,
    sourceWakeId?: string,
  ): Promise<void> {
    if (entry.activeGoal?.id !== goal.id || goal.status !== "active") {
      return;
    }
    if (entry.closing) {
      return;
    }

    if (entry.pendingClarification) {
      const now = new Date().toISOString();
      const reason =
        normalizeOptionalReason(entry.pendingClarification.request.reason) ??
        entry.pendingClarification.request.question;
      goal.status = "waiting_for_user";
      goal.waitingReason = reason;
      goal.updatedAt = now;
      this.publishSessionEvent(sessionId, {
        kind: "session.goal.waiting_for_user",
        wakeId: sourceWakeId,
        payload: {
          goalId: goal.id,
          status: goal.status,
          iteration: goal.iteration,
          reason,
          ...(sourceWakeId ? { wakeId: sourceWakeId } : undefined),
        },
      });
      await this.persistActiveGoalSnapshot(sessionId, entry);
      return;
    }

    if (entry.pendingWakeCount > 1) {
      return;
    }

    const limitReason = getGoalContinuationLimitReason(goal);
    if (limitReason) {
      const now = new Date().toISOString();
      goal.status = "failed";
      goal.failureReason = limitReason;
      goal.updatedAt = now;
      this.publishSessionEvent(sessionId, {
        kind: "session.goal.failed",
        wakeId: sourceWakeId,
        payload: {
          goalId: goal.id,
          status: goal.status,
          iteration: goal.iteration,
          reason: limitReason,
          ...(sourceWakeId ? { wakeId: sourceWakeId } : undefined),
        },
      });
      await this.persistActiveGoalSnapshot(sessionId, entry);
      return;
    }

    const prepared = await this.prepareWake(sessionId, {
      prompt: buildGoalWakePrompt(goal),
      reason: "goal_continue",
      metadata: {
        goalId: goal.id,
      },
    });
    goal.lastWakeId = prepared.wakeId;
    goal.updatedAt = new Date().toISOString();
    await this.persistActiveGoalSnapshot(sessionId, entry);
    void prepared.runPromise.catch(() => undefined);
  }

  private async scheduleRecoveredGoalContinuation(
    sessionId: string,
    entry: ActiveSession,
  ): Promise<void> {
    const goal = entry.activeGoal;
    if (!goal || goal.status !== "active") {
      return;
    }

    await this.scheduleGoalContinuation(sessionId, entry, goal);
  }

  private markActiveGoalWaitingForUser(
    sessionId: string,
    entry: ActiveSession,
    request: UserClarificationRequest,
  ): void {
    const goal = entry.activeGoal;
    if (!goal || goal.status !== "active") {
      return;
    }

    const reason = normalizeOptionalReason(request.reason) ?? request.question;
    const wakeId = entry.activeWakeId ?? undefined;
    goal.status = "waiting_for_user";
    goal.waitingReason = reason;
    goal.updatedAt = new Date().toISOString();
    this.publishSessionEvent(sessionId, {
      kind: "session.goal.waiting_for_user",
      wakeId,
      payload: {
        goalId: goal.id,
        status: goal.status,
        iteration: goal.iteration,
        reason,
        ...(wakeId ? { wakeId } : undefined),
      },
    });
    void this.persistActiveGoalSnapshot(sessionId, entry).catch(
      () => undefined,
    );
  }

  private async markWaitingGoalActive(
    sessionId: string,
    entry: ActiveSession,
  ): Promise<void> {
    const goal = entry.activeGoal;
    if (!goal || goal.status !== "waiting_for_user") {
      return;
    }

    goal.status = "active";
    goal.updatedAt = new Date().toISOString();
    delete goal.waitingReason;
    await this.persistActiveGoalSnapshot(sessionId, entry);
    this.publishSessionEvent(sessionId, {
      kind: "session.goal.resumed",
      payload: {
        goalId: goal.id,
        status: goal.status,
        iteration: goal.iteration,
        reason: "clarification resolved",
      },
    });
  }

  private failGoalIfFailureLimitReached(
    sessionId: string,
    goal: StepCliActiveGoal,
    wakeId?: string,
  ): void {
    if (goal.status !== "active") {
      return;
    }

    const maxConsecutiveFailures = goal.limits?.maxConsecutiveFailures;
    const consecutiveFailures = goal.counters?.consecutiveFailures ?? 0;
    if (
      maxConsecutiveFailures === undefined ||
      consecutiveFailures < maxConsecutiveFailures
    ) {
      return;
    }

    const reason = `Goal reached maxConsecutiveFailures limit (${maxConsecutiveFailures})`;
    goal.status = "failed";
    goal.failureReason = reason;
    goal.updatedAt = new Date().toISOString();
    this.publishSessionEvent(sessionId, {
      kind: "session.goal.failed",
      wakeId,
      payload: {
        goalId: goal.id,
        status: goal.status,
        iteration: goal.iteration,
        reason,
        ...(wakeId ? { wakeId } : undefined),
      },
    });
  }

  private buildLoadedDescriptor(
    sessionId: string,
    entry: ActiveSession,
  ): StepCliSessionDescriptor {
    syncSessionRunningState(entry);
    const activeGoal = cloneActiveGoal(entry.activeGoal);
    const runtime = toProtocolRuntimeSummary(entry.app.getSummary());
    return {
      id: sessionId,
      loaded: true,
      running: entry.running,
      persisted: entry.persisted,
      createdAt: entry.createdAt,
      lastUsedAt: entry.lastUsedAt,
      sessionFile: entry.sessionFile,
      runtime: {
        ...runtime,
        activeGoal,
      },
      activeGoal,
    };
  }

  private buildSessionHostSnapshot(
    sessionId: string,
    entry?: ActiveSession,
    hostPolicy: StepCliSessionHostPolicyRecord = entry?.hostPolicy ?? {
      proactive: null,
      maintenance: null,
    },
  ): StepCliSessionHostSnapshot {
    return {
      lastEventId: this.eventBus.getLastEventId(sessionId),
      queueDepth: entry?.pendingWakeCount ?? 0,
      activeWakeId: entry?.activeWakeId ?? null,
      proactive: toHostProactiveSnapshot(hostPolicy.proactive),
      maintenance: toHostMaintenanceSnapshot(hostPolicy.maintenance),
    };
  }

  private async loadGoalControlSession(sessionIdInput: string): Promise<{
    sessionId: string;
    entry: ActiveSession;
    goal: StepCliActiveGoal;
  }> {
    const sessionId = normalizeSessionId(sessionIdInput);
    await this.ensureSession(sessionId);
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Failed to load session: ${sessionId}`);
    }
    if (entry.closing) {
      throw new Error(`Session '${sessionId}' is closing`);
    }

    const goal = entry.activeGoal;
    if (!goal) {
      throw new Error(`Session '${sessionId}' has no active goal`);
    }
    if (!isNonTerminalGoalStatus(goal.status)) {
      throw new Error(
        `Session '${sessionId}' goal '${goal.id}' is already ${goal.status}`,
      );
    }

    return { sessionId, entry, goal };
  }

  private async persistActiveGoalSnapshot(
    sessionId: string,
    entry: ActiveSession,
  ): Promise<void> {
    const snapshot = attachActiveGoalToStoredSnapshot(
      entry.app.exportSessionSnapshot(),
      entry.activeGoal,
    );
    await fs.mkdir(this.getSessionDirectoryPath(sessionId), {
      recursive: true,
    });
    await fs.writeFile(
      entry.sessionFile,
      `${JSON.stringify(snapshot, null, 2)}\n`,
      "utf8",
    );
    entry.persisted = true;
  }

  private getSessionFilePath(sessionId: string): string {
    return getSessionSnapshotFilePath(this.storageLayout, sessionId);
  }

  private getSessionEventsPath(sessionId: string): string {
    return getSessionEventsFilePath(this.storageLayout, sessionId);
  }

  private getSessionDirectoryPath(sessionId: string): string {
    return getSessionDirectory(this.storageLayout, sessionId);
  }

  private createSessionEventStore(sessionId: string): SessionEventStore {
    return new SessionEventStore({
      snapshotFile: this.getSessionFilePath(sessionId),
      eventsFile: this.getSessionEventsPath(sessionId),
    });
  }

  private getSessionHostPolicyPath(sessionId: string): string {
    return getSessionHostPolicyFilePath(this.storageLayout, sessionId);
  }

  private createSessionHostPolicyStore(
    sessionId: string,
  ): SessionHostPolicyStore {
    return new SessionHostPolicyStore({
      filePath: this.getSessionHostPolicyPath(sessionId),
    });
  }

  private async loadSessionHostPolicy(
    sessionId: string,
  ): Promise<StepCliSessionHostPolicyRecord> {
    return await this.createSessionHostPolicyStore(sessionId).load();
  }

  private async applySessionHostPolicyPatch(
    sessionId: string,
    patch: StepCliSessionHostPolicyPatch,
  ): Promise<StepCliSessionHostPolicyRecord> {
    const loaded = this.sessions.get(sessionId);
    if (!loaded) {
      const session = await this.getSession(sessionId);
      if (!session) {
        throw new SessionNotFoundError(sessionId);
      }
    }
    const store = this.createSessionHostPolicyStore(sessionId);
    const next = await store.update(
      patch,
      loaded ? cloneHostPolicyRecord(loaded.hostPolicy) : undefined,
    );
    if (loaded) {
      loaded.hostPolicy = cloneHostPolicyRecord(next);
    }
    return cloneHostPolicyRecord(next);
  }

  private applySessionHostPolicyPatchSync(
    sessionId: string,
    patch: StepCliSessionHostPolicyPatch,
  ): StepCliSessionHostPolicyRecord {
    const loaded = this.sessions.get(sessionId);
    if (!loaded) {
      throw new Error(
        `Cannot synchronously update host policy for unloaded session '${sessionId}'`,
      );
    }

    const store = this.createSessionHostPolicyStore(sessionId);
    const next = store.updateSync(
      patch,
      cloneHostPolicyRecord(loaded.hostPolicy),
    );
    loaded.hostPolicy = cloneHostPolicyRecord(next);
    return cloneHostPolicyRecord(next);
  }

  private async closeLoadedSession(
    sessionId: string,
    entry: ActiveSession,
    options: {
      abortRunning?: boolean;
      reason?: string;
    },
  ): Promise<void> {
    const reason =
      normalizeOptionalReason(options.reason) ??
      `Session '${sessionId}' is shutting down.`;
    entry.closing = true;
    this.cancelPendingClarification(sessionId, entry, reason);

    const abortControllers = getAbortControllerSet(entry);
    const activeRuns = getActiveRunSet(entry);

    if (options.abortRunning) {
      for (const controller of abortControllers) {
        if (!controller.signal.aborted) {
          controller.abort(reason);
        }
      }
    }

    if (activeRuns.size > 0) {
      await Promise.allSettled(activeRuns);
    }

    await entry.wakeQueue.waitForIdle();

    await entry.app.close({
      abortActiveRun: options.abortRunning,
      reason,
    });
    entry.persisted = await pathExists(entry.sessionFile);
    abortControllers.clear();
    activeRuns.clear();
    entry.abortController = null;
    entry.activeRun = null;
    entry.pendingWakeCount = 0;
    entry.activeWakeId = null;
    entry.running = false;
  }

  private cancelPendingClarification(
    sessionId: string,
    entry: ActiveSession,
    reason: string,
  ): void {
    const pending = entry.pendingClarification;
    if (!pending) {
      return;
    }

    entry.pendingClarification = null;
    this.publishSessionEvent(sessionId, {
      kind: "session.clarification.resolved",
      payload: {
        cancelled: true,
        reason,
      },
    });
    pending.resolve({
      cancelled: true,
      reason,
    });
  }

  private async bootstrapPersistedSessions(): Promise<void> {
    const persisted = await this.readPersistedSessions();
    const results = await Promise.allSettled(
      persisted.map(async ({ id: sessionId }) => {
        const snapshot = await this.createSessionEventStore(sessionId).load();
        const activeGoal = extractActiveGoalFromSnapshot(snapshot);
        if (activeGoal?.status === "active") {
          await this.ensureSession(sessionId);
          return;
        }

        const hostPolicy = await this.loadSessionHostPolicy(sessionId);
        await this.scheduler.reloadSession(sessionId);
        if (hostPolicy.proactive) {
          await this.proactiveController.reloadSession(sessionId, {
            preserveScheduledTick: true,
          });
        }
      }),
    );

    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Failed to bootstrap ${failures.length} persisted session timer(s).`,
      );
    }
  }

  private async readPersistedSessions(): Promise<PersistedSessionRecord[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const sessionId = decodeSessionDirectory(entry.name);
          if (!sessionId) {
            return null;
          }

          const sessionFile = this.getSessionFilePath(sessionId);
          const stats = await this.getPersistedSessionStats(sessionId);
          return {
            id: sessionId,
            sessionFile,
            createdAt: toIsoOrNull(stats?.birthtimeMs),
            lastUsedAt: toIsoOrNull(stats?.mtimeMs),
          } satisfies PersistedSessionRecord;
        }),
    );

    return sessions.filter((entry): entry is PersistedSessionRecord =>
      Boolean(entry),
    );
  }

  private async getPersistedSessionStats(
    sessionId: string,
  ): Promise<Awaited<ReturnType<typeof statIfExists>>> {
    return (
      (await statIfExists(this.getSessionFilePath(sessionId))) ??
      (await statIfExists(this.getSessionEventsPath(sessionId))) ??
      (await statIfExists(this.getSessionHostPolicyPath(sessionId))) ??
      (await statIfExists(
        getSessionTriggersFilePath(this.storageLayout, sessionId),
      ))
    );
  }
}

function normalizeSessionId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Session id must not be empty");
  }
  if (trimmed.length > 200) {
    throw new Error("Session id must be 200 characters or fewer");
  }
  if (containsControlCharacter(trimmed)) {
    throw new Error("Session id contains unsupported control characters");
  }
  return trimmed;
}

function normalizeGoalText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Goal text must not be empty");
  }
  return trimmed;
}

function isNonTerminalGoalStatus(status: StepCliActiveGoal["status"]): boolean {
  return (
    status === "active" ||
    status === "paused" ||
    status === "waiting_for_user" ||
    status === "failed"
  );
}

function getActiveGoalForWake(
  entry: ActiveSession,
  request: NormalizedWakeRequest,
): StepCliActiveGoal | null {
  if (!isGoalWakeRequest(request)) {
    return null;
  }
  const goal = entry.activeGoal;
  if (!goal || goal.status !== "active") {
    return null;
  }
  const goalId = request.metadata?.goalId;
  if (typeof goalId === "string" && goalId !== goal.id) {
    return null;
  }
  return goal;
}

function isGoalWakeRequest(request: NormalizedWakeRequest): boolean {
  return request.reason === "goal_start" || request.reason === "goal_continue";
}

function recordCompletedGoalRun(goal: StepCliActiveGoal): void {
  const now = new Date().toISOString();
  const counters = getGoalCounters(goal);

  counters.totalRuns += 1;
  counters.consecutiveFailures = 0;
  goal.iteration += 1;
  goal.lastRunFinishedAt = now;
  goal.updatedAt = now;
}

function recordFailedGoalRun(goal: StepCliActiveGoal): void {
  const now = new Date().toISOString();
  const counters = getGoalCounters(goal);

  counters.totalRuns += 1;
  counters.totalFailures += 1;
  counters.consecutiveFailures += 1;
  goal.iteration += 1;
  goal.lastRunFinishedAt = now;
  goal.updatedAt = now;
}

function getGoalCounters(
  goal: StepCliActiveGoal,
): NonNullable<StepCliActiveGoal["counters"]> {
  if (!goal.counters) {
    goal.counters = {
      consecutiveFailures: 0,
      totalRuns: 0,
      totalFailures: 0,
    };
  }
  return goal.counters;
}

function getGoalContinuationLimitReason(
  goal: StepCliActiveGoal,
): string | null {
  const maxIterations = goal.limits?.maxIterations;
  if (maxIterations !== undefined && goal.iteration >= maxIterations) {
    return `Goal reached maxIterations limit (${maxIterations})`;
  }

  const maxRuntimeMs = goal.limits?.maxRuntimeMs;
  const startedAt = Date.parse(goal.startedAt ?? goal.createdAt);
  if (
    maxRuntimeMs !== undefined &&
    Number.isFinite(startedAt) &&
    Date.now() - startedAt >= maxRuntimeMs
  ) {
    return `Goal reached maxRuntimeMs limit (${maxRuntimeMs})`;
  }

  return null;
}

function buildGoalWakePrompt(goal: StepCliActiveGoal): UserTurnInput {
  return {
    content: [
      "You are working toward this long-running session goal:",
      "",
      goal.text,
      "",
      `Goal id: ${goal.id}`,
      `Goal iteration: ${goal.iteration}`,
      "",
      "At the end of this goal turn, report one goal disposition:",
      "- completed: the goal is fully achieved",
      "- continue: more autonomous work is needed",
      "- waiting_for_user: user input is required",
      "- failed: autonomous progress cannot continue",
      "",
      "Include a short reason and next action.",
    ].join("\n"),
  };
}

function parseGoalRunDisposition(
  output: string,
): ParsedGoalRunDisposition | null {
  const dispositionMatch = output.match(
    /(?:^|\n)\s*(?:goal[_\s-]*)?disposition\s*[:=-]\s*(completed|continue|waiting_for_user|failed)\b/i,
  );
  if (!dispositionMatch) {
    return null;
  }
  const disposition = dispositionMatch[1]?.toLowerCase();
  if (
    disposition !== "completed" &&
    disposition !== "continue" &&
    disposition !== "waiting_for_user" &&
    disposition !== "failed"
  ) {
    return null;
  }

  const reasonMatch = output.match(/(?:^|\n)\s*reason\s*[:=-]\s*([^\n]+)/i);
  return {
    disposition,
    reason: normalizeOptionalReason(reasonMatch?.[1]),
  };
}

function cloneActiveGoal(
  goal: StepCliActiveGoal | null | undefined,
): StepCliActiveGoal | null {
  if (!goal) {
    return null;
  }

  const clone: StepCliActiveGoal = {
    id: goal.id,
    sessionId: goal.sessionId,
    text: goal.text,
    status: goal.status,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    iteration: goal.iteration,
  };

  if (goal.startedAt !== undefined) {
    clone.startedAt = goal.startedAt;
  }
  if (goal.completedAt !== undefined) {
    clone.completedAt = goal.completedAt;
  }
  if (goal.stoppedAt !== undefined) {
    clone.stoppedAt = goal.stoppedAt;
  }
  if (goal.lastWakeId !== undefined) {
    clone.lastWakeId = goal.lastWakeId;
  }
  if (goal.lastRunStartedAt !== undefined) {
    clone.lastRunStartedAt = goal.lastRunStartedAt;
  }
  if (goal.lastRunFinishedAt !== undefined) {
    clone.lastRunFinishedAt = goal.lastRunFinishedAt;
  }
  if (goal.nextWakeAt !== undefined) {
    clone.nextWakeAt = goal.nextWakeAt;
  }
  if (goal.completionReason !== undefined) {
    clone.completionReason = goal.completionReason;
  }
  if (goal.failureReason !== undefined) {
    clone.failureReason = goal.failureReason;
  }
  if (goal.waitingReason !== undefined) {
    clone.waitingReason = goal.waitingReason;
  }
  if (goal.stoppedReason !== undefined) {
    clone.stoppedReason = goal.stoppedReason;
  }
  if (goal.limits !== undefined) {
    clone.limits = { ...goal.limits };
  }
  if (goal.counters !== undefined) {
    clone.counters = { ...goal.counters };
  }

  return clone;
}

function extractActiveGoalFromSnapshot(
  snapshot: SessionSnapshot | null | undefined,
): StepCliActiveGoal | null {
  if (!snapshot) {
    return null;
  }

  const topLevelGoal =
    "activeGoal" in snapshot ? snapshot.activeGoal : undefined;
  if (topLevelGoal !== undefined) {
    return cloneActiveGoal(topLevelGoal);
  }

  const runtimeGoal =
    "runtime" in snapshot ? snapshot.runtime.activeGoal : undefined;
  return cloneActiveGoal(runtimeGoal);
}

function withSessionActiveGoal(
  session: StepCliSessionDescriptor,
  goal: StepCliActiveGoal | null | undefined,
): StepCliSessionDescriptor {
  const activeGoal = cloneActiveGoal(goal);
  return {
    ...session,
    runtime: session.runtime
      ? {
          ...session.runtime,
          activeGoal,
        }
      : undefined,
    activeGoal,
  };
}

function attachActiveGoalToStoredSnapshot(
  snapshot: SessionSnapshotV4,
  goal: StepCliActiveGoal | null | undefined,
): SessionSnapshotV4 {
  const activeGoal = cloneActiveGoal(goal);
  return {
    ...snapshot,
    runtime: {
      ...snapshot.runtime,
      activeGoal,
    },
    activeGoal,
  };
}

function attachActiveGoalToSnapshot(
  snapshot: ProtocolSessionSnapshot,
  goal: StepCliActiveGoal | null | undefined,
): ProtocolSessionSnapshot {
  const activeGoal = cloneActiveGoal(goal);
  if (!snapshot.runtime) {
    return {
      ...snapshot,
      activeGoal,
    };
  }

  return {
    ...snapshot,
    runtime: {
      ...snapshot.runtime,
      activeGoal,
    },
    activeGoal,
  };
}

function normalizeOptionalReason(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function decodeSessionDirectory(filename: string): string | null {
  try {
    return normalizeSessionId(decodeStorageKey(filename));
  } catch {
    return null;
  }
}

async function statIfExists(
  filePath: string,
): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  return Boolean(await statIfExists(filePath));
}

function toIsoOrNull(timestampMs: number | bigint | undefined): string | null {
  const normalizedTimestampMs =
    typeof timestampMs === "bigint"
      ? timestampMs <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(timestampMs)
        : Number.NaN
      : timestampMs;
  if (
    normalizedTimestampMs === undefined ||
    !Number.isFinite(normalizedTimestampMs) ||
    normalizedTimestampMs <= 0
  ) {
    return null;
  }
  return new Date(normalizedTimestampMs).toISOString();
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error !== null && typeof error === "object" && "code" in error;
}

function getAbortControllerSet(entry: ActiveSession): Set<AbortController> {
  if (!entry.abortControllers) {
    entry.abortControllers = new Set();
  }
  if (entry.abortController) {
    entry.abortControllers.add(entry.abortController);
  }
  return entry.abortControllers;
}

function getActiveRunSet(
  entry: ActiveSession,
): Set<Promise<GatewayTurnResult>> {
  if (!entry.activeRuns) {
    entry.activeRuns = new Set();
  }
  if (entry.activeRun) {
    entry.activeRuns.add(entry.activeRun);
  }
  return entry.activeRuns;
}

function isSessionBusy(entry: ActiveSession): boolean {
  return (
    entry.pendingWakeCount > 0 ||
    getAbortControllerSet(entry).size > 0 ||
    getActiveRunSet(entry).size > 0
  );
}

function syncSessionRunningState(entry: ActiveSession): void {
  entry.running = isSessionBusy(entry);
}

function toProtocolRuntimeSummary(
  summary: GatewayRuntimeSummary,
): ProtocolRuntimeSummary {
  return {
    workspaceRoot: summary.workspaceRoot,
    mode: summary.mode,
    model: summary.model,
    provider: summary.provider,
    pluginIds: [...summary.pluginIds],
    approvalMode: summary.approvalMode,
    nonInteractiveApproval: summary.nonInteractiveApproval,
    sessionFile: summary.sessionFile,
    sessionAutoSave: summary.sessionAutoSave,
    plan: summary.plan ? toProtocolRecord(summary.plan) : null,
    clarification: cloneUserClarificationRuntimeState(summary.clarification),
    contextAssembly: cloneContextAssembly(summary.contextAssembly),
    runtime: toProtocolRecord(summary.runtime),
    verifier: cloneStepCliVerifierVerdict(summary.verifier),
  };
}

function toProtocolTurnResult(result: GatewayTurnResult): ProtocolTurnResult {
  return {
    output: result.output,
    steps: result.steps,
    toolCalls: result.toolCalls,
    run: toProtocolRecord(result.run),
    actions: result.actions.map((entry) => toProtocolRecord(entry)),
    stateTimeline: result.stateTimeline.map((entry) => toProtocolRecord(entry)),
    memory: result.memory,
    context: result.context,
    contextAssembly: cloneContextAssembly(result.contextAssembly),
    verifier: cloneStepCliVerifierVerdict(result.verifier),
  };
}

function toProtocolSessionSnapshot(
  snapshot: SessionSnapshot,
): ProtocolSessionSnapshot {
  const activeGoal = extractActiveGoalFromSnapshot(snapshot);
  const runtime =
    "runtime" in snapshot && snapshot.runtime
      ? {
          sessionId: snapshot.runtime.sessionId,
          goalId: snapshot.runtime.goalId,
          activeGoal,
          executionProfile: snapshot.runtime.executionProfile
            ? toProtocolRecord(snapshot.runtime.executionProfile)
            : undefined,
          contextAssembly: cloneContextAssembly(
            snapshot.runtime.contextAssembly,
          ),
          verifier: cloneStepCliVerifierVerdict(snapshot.runtime.verifier),
        }
      : undefined;
  const tools =
    "tools" in snapshot && snapshot.tools ? [...snapshot.tools] : undefined;
  const clarification =
    "clarification" in snapshot && snapshot.clarification
      ? cloneUserClarificationRuntimeState(snapshot.clarification)
      : undefined;
  const toolPolicy = "toolPolicy" in snapshot ? snapshot.toolPolicy : undefined;
  const toolRuntime =
    "toolRuntime" in snapshot ? snapshot.toolRuntime : undefined;
  const pluginStates =
    "pluginStates" in snapshot ? snapshot.pluginStates : undefined;

  return {
    schemaVersion: snapshot.schemaVersion,
    savedAt: snapshot.savedAt,
    workspaceRoot: snapshot.workspaceRoot,
    provider: snapshot.provider,
    model: snapshot.model,
    mode: "mode" in snapshot ? snapshot.mode : undefined,
    systemPrompt: snapshot.systemPrompt,
    pluginIds: [...snapshot.pluginIds],
    memory: snapshot.memory,
    runtime,
    activeGoal,
    tools,
    clarification,
    toolPolicy,
    toolRuntime,
    pluginStates,
  };
}

function toProtocolRecord<T extends object>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}

function cloneHostPolicyRecord(
  value: StepCliSessionHostPolicyRecord,
): StepCliSessionHostPolicyRecord {
  return {
    proactive: value.proactive ? { ...value.proactive } : null,
    maintenance: value.maintenance ? { ...value.maintenance } : null,
  };
}

function toHostProactiveSnapshot(
  value: StepCliSessionHostPolicyRecord["proactive"],
): StepCliSessionHostProactiveSnapshot | null {
  if (!value) {
    return null;
  }

  return {
    enabled: value.enabled,
    paused: value.paused ?? false,
    lastTickAt: value.lastTickAt ?? null,
    nextTickAt: value.nextTickAt ?? null,
  };
}

function toHostMaintenanceSnapshot(
  value: StepCliSessionHostPolicyRecord["maintenance"],
): StepCliSessionHostMaintenanceSnapshot | null {
  if (!value) {
    return null;
  }

  return {
    autoDreamEnabled: value.autoDreamEnabled,
    dreamRunning: value.dreamRunning ?? false,
    nextEligibleDreamAt: value.nextEligibleDreamAt ?? null,
    lastDreamAt: value.lastDreamAt ?? null,
    lastDreamStatus: value.lastDreamStatus ?? null,
    lastDreamSummary: value.lastDreamSummary ?? null,
    lastDreamSkipReason: value.lastDreamSkipReason ?? null,
  };
}

function normalizeWakeRequest(
  request: StepCliSessionWakeRequest,
): NormalizedWakeRequest {
  const reason = normalizeWakeReason(request.reason);
  if (request.prompt === undefined) {
    throw new Error(
      `Wake reason '${reason}' is not supported yet without a prompt`,
    );
  }

  const prompt = normalizeUserTurnInput(request.prompt);
  if (isUserTurnEmpty(prompt)) {
    throw new Error(
      "Turn input must include prompt text or at least one attachment",
    );
  }

  return {
    reason,
    prompt,
    metadata: request.metadata ? { ...request.metadata } : undefined,
  };
}

function normalizeWakeReason(value: unknown): SessionWakeReason {
  switch (value) {
    case "user":
    case "cron":
    case "proactive_tick":
    case "goal_start":
    case "goal_continue":
      return value;
    default:
      throw new Error(
        "Wake requests currently support only 'user', 'cron', 'proactive_tick', 'goal_start', or 'goal_continue' reasons",
      );
  }
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "AbortError" || /abort/i.test(error.message);
}

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal | undefined;
  dispose: () => void;
} {
  const activeSignals = signals.filter((signal): signal is AbortSignal =>
    Boolean(signal),
  );
  if (activeSignals.length === 0) {
    return {
      signal: undefined,
      dispose: () => {},
    };
  }

  if (activeSignals.length === 1) {
    return {
      signal: activeSignals[0],
      dispose: () => {},
    };
  }

  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  const abort = (source: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason);
    }

    for (const dispose of listeners) {
      dispose();
    }
    listeners.length = 0;
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }

    const handleAbort = () => abort(signal);
    signal.addEventListener("abort", handleAbort, { once: true });
    listeners.push(() => signal.removeEventListener("abort", handleAbort));
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const dispose of listeners) {
        dispose();
      }
      listeners.length = 0;
    },
  };
}
