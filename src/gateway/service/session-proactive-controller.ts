import type {
  StepCliSessionEvent,
  StepCliSessionEventKind,
  StepCliSessionHostPolicyRecord,
  StepCliSessionProactivePolicy,
  StepCliSessionSnapshotResult,
  StepCliSessionWakeRequest,
} from "@step-cli/protocol";

type TimerHandle = ReturnType<typeof setTimeout>;

type EnqueueWake = (
  sessionId: string,
  request: StepCliSessionWakeRequest,
) => Promise<unknown>;

type PublishedProactiveEventKind = Extract<
  StepCliSessionEventKind,
  | "session.proactive.armed"
  | "session.proactive.fired"
  | "session.proactive.skipped"
  | "session.proactive.paused"
>;

interface SessionProactiveControllerOptions {
  getSessionSnapshot: (
    sessionId: string,
  ) => Promise<StepCliSessionSnapshotResult | null>;
  getSessionHostPolicy: (
    sessionId: string,
  ) => Promise<StepCliSessionHostPolicyRecord | null>;
  updateSessionHostPolicy: (
    sessionId: string,
    patch: {
      proactive?: Partial<StepCliSessionProactivePolicy> | null;
    },
  ) => Promise<StepCliSessionHostPolicyRecord>;
  enqueueWake: EnqueueWake;
  publishEvent?: (event: {
    sessionId: string;
    kind: PublishedProactiveEventKind;
    payload?: Record<string, unknown>;
  }) => void;
}

interface ReloadSessionOptions {
  preserveScheduledTick?: boolean;
}

type ProactiveSkipReason =
  | "disabled"
  | "paused"
  | "session-busy"
  | "clarification-pending";

const DEFAULT_PROACTIVE_SLEEP_MS = 60_000;

export const DEFAULT_PROACTIVE_TICK_PROMPT = [
  "Host proactive tick.",
  "If there is clear unfinished work you can advance safely, continue it.",
  "If you should wait for user input or nothing useful remains, do not invent work.",
].join(" ");

export class SessionProactiveController {
  private readonly getSessionSnapshot: SessionProactiveControllerOptions["getSessionSnapshot"];
  private readonly getSessionHostPolicy: SessionProactiveControllerOptions["getSessionHostPolicy"];
  private readonly updateSessionHostPolicy: SessionProactiveControllerOptions["updateSessionHostPolicy"];
  private readonly enqueueWake: SessionProactiveControllerOptions["enqueueWake"];
  private readonly publishEvent: SessionProactiveControllerOptions["publishEvent"];
  private readonly timers = new Map<string, TimerHandle>();
  private readonly generations = new Map<string, number>();
  private closed = false;

  constructor(options: SessionProactiveControllerOptions) {
    this.getSessionSnapshot = options.getSessionSnapshot;
    this.getSessionHostPolicy = options.getSessionHostPolicy;
    this.updateSessionHostPolicy = options.updateSessionHostPolicy;
    this.enqueueWake = options.enqueueWake;
    this.publishEvent = options.publishEvent;
  }

  async reloadSession(
    sessionId: string,
    options: ReloadSessionOptions = {},
  ): Promise<void> {
    const generation = this.bumpGeneration(sessionId);
    this.clearTimer(sessionId);
    if (this.closed) {
      return;
    }

    const session = await this.loadSessionState(sessionId);
    if (!this.isCurrentGeneration(sessionId, generation)) {
      return;
    }
    if (!session?.policy.proactive) {
      return;
    }

    const proactive = session.policy.proactive;
    const skipReason = resolveSkipReason(session.snapshot, proactive);
    if (skipReason) {
      await this.clearScheduledTick(
        sessionId,
        proactive.nextTickAt ?? null,
        skipReason,
      );
      return;
    }

    const nextTickAt = resolveNextTickAt(session.snapshot, proactive, {
      preserveScheduledTick: options.preserveScheduledTick,
    });
    if (proactive.nextTickAt !== nextTickAt) {
      await this.updateSessionHostPolicy(sessionId, {
        proactive: {
          nextTickAt,
        },
      });
      if (!this.isCurrentGeneration(sessionId, generation)) {
        return;
      }
      this.publish("session.proactive.armed", sessionId, {
        nextTickAt,
      });
    }

    this.armTimer(sessionId, nextTickAt, generation);
  }

  async handleSessionEvent(event: StepCliSessionEvent): Promise<void> {
    if (this.closed) {
      return;
    }

    const eventKind = event.kind as string;

    if (event.kind === "session.deleted") {
      this.clearTimer(event.sessionId);
      return;
    }

    if (event.kind === "session.updated") {
      return;
    }

    if (event.kind.startsWith("session.proactive.")) {
      return;
    }

    if (eventKind === "session.hook" || eventKind === "session.observer") {
      return;
    }

    await this.reloadSession(event.sessionId);
  }

  async clearSession(sessionId: string): Promise<void> {
    this.bumpGeneration(sessionId);
    this.clearTimer(sessionId);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.generations.clear();
  }

  private async fireSession(
    sessionId: string,
    generation: number,
  ): Promise<void> {
    this.clearTimer(sessionId);
    if (this.closed || !this.isCurrentGeneration(sessionId, generation)) {
      return;
    }

    const session = await this.loadSessionState(sessionId);
    if (this.closed || !this.isCurrentGeneration(sessionId, generation)) {
      return;
    }
    if (!session?.policy.proactive) {
      return;
    }

    const proactive = session.policy.proactive;
    const skipReason = resolveSkipReason(session.snapshot, proactive);
    if (skipReason) {
      await this.clearScheduledTick(
        sessionId,
        proactive.nextTickAt ?? null,
        skipReason,
      );
      return;
    }

    const tickAt = new Date().toISOString();
    const nextTickAt = new Date(
      Date.parse(tickAt) + resolveDelayMs(proactive),
    ).toISOString();
    await this.updateSessionHostPolicy(sessionId, {
      proactive: {
        lastTickAt: tickAt,
        nextTickAt,
      },
    });
    if (this.closed || !this.isCurrentGeneration(sessionId, generation)) {
      return;
    }
    this.publish("session.proactive.fired", sessionId, {
      tickAt,
    });
    this.publish("session.proactive.armed", sessionId, {
      nextTickAt,
    });
    this.armTimer(sessionId, nextTickAt, generation);

    await this.enqueueWake(sessionId, {
      prompt: {
        content: DEFAULT_PROACTIVE_TICK_PROMPT,
      },
      reason: "proactive_tick",
      metadata: {
        tickKind: "idle",
      },
    });
  }

  private armTimer(
    sessionId: string,
    nextTickAt: string,
    generation: number,
  ): void {
    if (this.closed) {
      return;
    }

    const delayMs = Math.max(0, Date.parse(nextTickAt) - Date.now());
    const timer = setTimeout(async () => {
      if (!this.isCurrentGeneration(sessionId, generation)) {
        return;
      }
      try {
        await this.fireSession(sessionId, generation);
      } catch {
        // Best-effort background wake: surfaced via host state/tests, not timer exceptions.
      }
    }, delayMs);
    this.timers.set(sessionId, timer);
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  private async clearScheduledTick(
    sessionId: string,
    nextTickAt: string | null,
    reason: ProactiveSkipReason,
  ): Promise<void> {
    if (nextTickAt !== null) {
      await this.updateSessionHostPolicy(sessionId, {
        proactive: {
          nextTickAt: null,
        },
      });
    }

    if (reason === "paused") {
      this.publish("session.proactive.paused", sessionId);
      return;
    }

    this.publish("session.proactive.skipped", sessionId, {
      reason,
    });
  }

  private async loadSessionState(sessionId: string): Promise<{
    snapshot: StepCliSessionSnapshotResult;
    policy: StepCliSessionHostPolicyRecord;
  } | null> {
    const [snapshot, policy] = await Promise.all([
      this.getSessionSnapshot(sessionId),
      this.getSessionHostPolicy(sessionId),
    ]);
    if (!snapshot || !policy) {
      return null;
    }

    return {
      snapshot,
      policy,
    };
  }

  private publish(
    kind: PublishedProactiveEventKind,
    sessionId: string,
    payload?: Record<string, unknown>,
  ): void {
    this.publishEvent?.({
      sessionId,
      kind,
      payload,
    });
  }

  private bumpGeneration(sessionId: string): number {
    const next = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, next);
    return next;
  }

  private isCurrentGeneration(sessionId: string, generation: number): boolean {
    return this.generations.get(sessionId) === generation;
  }
}

function resolveSkipReason(
  snapshot: StepCliSessionSnapshotResult,
  proactive: StepCliSessionProactivePolicy,
): ProactiveSkipReason | null {
  if (!proactive.enabled) {
    return "disabled";
  }
  if (proactive.paused === true) {
    return "paused";
  }
  if (snapshot.session.runtime?.clarification.pending) {
    return "clarification-pending";
  }
  if (
    snapshot.session.running ||
    snapshot.host.queueDepth > 0 ||
    snapshot.host.activeWakeId !== null
  ) {
    return "session-busy";
  }
  return null;
}

function resolveNextTickAt(
  snapshot: StepCliSessionSnapshotResult,
  proactive: StepCliSessionProactivePolicy,
  options: ReloadSessionOptions = {},
): string {
  const preservedNextTick = parseTime(proactive.nextTickAt)?.toISOString();
  if (options.preserveScheduledTick === true && preservedNextTick) {
    return preservedNextTick;
  }
  const nowMs = Date.now();
  const lastUsedAtMs =
    parseTime(snapshot.session.lastUsedAt)?.getTime() ?? nowMs;
  const delayMs = resolveDelayMs(proactive);
  const baselineMs = Math.max(nowMs, lastUsedAtMs + delayMs);
  const persistedMs = parseTime(proactive.nextTickAt)?.getTime() ?? 0;
  return new Date(Math.max(baselineMs, persistedMs)).toISOString();
}

function resolveDelayMs(proactive: StepCliSessionProactivePolicy): number {
  const minIdleMs = sanitizeDelay(proactive.minIdleMs);
  const defaultSleepMs = sanitizeDelay(proactive.defaultSleepMs);
  return Math.max(minIdleMs, defaultSleepMs, DEFAULT_PROACTIVE_SLEEP_MS);
}

function sanitizeDelay(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function parseTime(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return new Date(timestamp);
}
