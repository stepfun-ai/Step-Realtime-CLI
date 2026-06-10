import type {
  StepCliSessionWakeRequest,
  StepCliTriggerDescriptor,
} from "@step-cli/protocol";
import { SessionTriggerStore } from "../session/session-trigger-store.js";
import {
  getSessionTriggersFilePath,
  type StepCliResolvedStorageLayout,
} from "../storage/layout.js";

type TimerHandle = ReturnType<typeof setTimeout>;

type EnqueueWake = (
  sessionId: string,
  request: StepCliSessionWakeRequest,
) => Promise<unknown>;

interface SessionSchedulerOptions {
  storageLayout: StepCliResolvedStorageLayout;
  enqueueWake: EnqueueWake;
}

interface CronSchedule {
  minute: CronMatcher;
  hour: CronMatcher;
  dayOfMonth: CronMatcher;
  month: CronMatcher;
  dayOfWeek: CronMatcher;
}

type CronMatcher = (value: number) => boolean;

export class SessionScheduler {
  private readonly storageLayout: StepCliResolvedStorageLayout;
  private readonly enqueueWake: EnqueueWake;
  private readonly timers = new Map<string, TimerHandle>();
  private readonly sessionTriggers = new Map<
    string,
    StepCliTriggerDescriptor[]
  >();
  private closed = false;

  constructor(options: SessionSchedulerOptions) {
    this.storageLayout = options.storageLayout;
    this.enqueueWake = options.enqueueWake;
  }

  async reloadSession(sessionId: string): Promise<void> {
    this.clearSessionTimer(sessionId);
    if (this.closed) {
      return;
    }

    const store = this.createStore(sessionId);
    const triggers = await store.load();
    const normalized = normalizeTriggerSchedule(triggers, new Date());
    if (normalized.changed) {
      await store.save(normalized.triggers);
    }
    this.sessionTriggers.set(sessionId, cloneTriggers(normalized.triggers));

    const nextTrigger = selectNextTrigger(normalized.triggers);
    if (!nextTrigger?.nextRunAt) {
      return;
    }

    const nextRunAt = Date.parse(nextTrigger.nextRunAt);
    if (!Number.isFinite(nextRunAt)) {
      return;
    }

    const delayMs = Math.max(0, nextRunAt - Date.now());
    const timer = setTimeout(async () => {
      await this.fireSession(sessionId);
    }, delayMs);
    this.timers.set(sessionId, timer);
  }

  async clearSession(sessionId: string): Promise<void> {
    this.clearSessionTimer(sessionId);
    this.sessionTriggers.delete(sessionId);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.sessionTriggers.clear();
  }

  private async fireSession(sessionId: string): Promise<void> {
    if (this.closed) {
      return;
    }
    this.clearSessionTimer(sessionId);

    const now = new Date();
    const store = this.createStore(sessionId);
    const due = normalizeTriggerSchedule(
      cloneTriggers(this.sessionTriggers.get(sessionId) ?? []),
      now,
    );
    const wakeRequests = getDueTriggers(due.triggers, now).map((trigger) => {
      // Skip missed cron windows by default instead of backfilling one wake
      // per interval after restart or event-loop stalls.
      trigger.nextRunAt = computeNextCronRunAt(trigger.cron.expression, now);
      trigger.updatedAt = now.toISOString();
      due.changed = true;
      return this.enqueueWake(sessionId, {
        prompt: trigger.input,
        reason: "cron",
        metadata: {
          triggerId: trigger.id,
        },
      });
    });

    this.sessionTriggers.set(sessionId, cloneTriggers(due.triggers));
    if (due.changed) {
      // Persist the next fire time before yielding so fake-timer driven tests
      // and process restarts both observe the advanced cursor immediately.
      store.saveSync(due.triggers);
    }

    await Promise.allSettled(wakeRequests);
    await this.reloadSession(sessionId);
  }

  private clearSessionTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  private createStore(sessionId: string): SessionTriggerStore {
    return new SessionTriggerStore({
      filePath: getSessionTriggersFilePath(this.storageLayout, sessionId),
    });
  }
}

function normalizeTriggerSchedule(
  triggers: readonly StepCliTriggerDescriptor[],
  now: Date,
): {
  triggers: StepCliTriggerDescriptor[];
  changed: boolean;
} {
  let changed = false;
  const normalized = triggers.map((trigger) => {
    const next = { ...trigger };
    if (!next.enabled || next.kind !== "cron") {
      return next;
    }

    const nextRunAt = parseTriggerTime(next.nextRunAt);
    if (!nextRunAt || nextRunAt.getTime() < now.getTime()) {
      next.nextRunAt = computeNextCronRunAt(next.cron.expression, now);
      next.updatedAt = now.toISOString();
      changed = true;
    }
    return next;
  });

  return {
    triggers: normalized,
    changed,
  };
}

function selectNextTrigger(
  triggers: readonly StepCliTriggerDescriptor[],
): StepCliTriggerDescriptor | null {
  const sorted = triggers
    .filter((trigger) => trigger.enabled && trigger.kind === "cron")
    .filter((trigger) => parseTriggerTime(trigger.nextRunAt))
    .sort((left, right) => {
      return (
        Date.parse(left.nextRunAt ?? "") - Date.parse(right.nextRunAt ?? "")
      );
    });

  return sorted[0] ?? null;
}

function getDueTriggers(
  triggers: readonly StepCliTriggerDescriptor[],
  now: Date,
): StepCliTriggerDescriptor[] {
  return [...triggers]
    .filter((trigger) => trigger.enabled && trigger.kind === "cron")
    .filter((trigger) => {
      const nextRunAt = parseTriggerTime(trigger.nextRunAt);
      return nextRunAt !== null && nextRunAt.getTime() <= now.getTime();
    })
    .sort((left, right) => {
      return (
        Date.parse(left.nextRunAt ?? "") - Date.parse(right.nextRunAt ?? "")
      );
    });
}

function computeNextCronRunAt(expression: string, after: Date): string {
  const schedule = parseCronExpression(expression);
  const candidate = new Date(after.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  for (let attempts = 0; attempts < 366 * 24 * 60; attempts += 1) {
    if (matchesCronSchedule(schedule, candidate)) {
      return candidate.toISOString();
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  throw new Error(
    `Unable to compute next cron run for expression: ${expression}`,
  );
}

function matchesCronSchedule(schedule: CronSchedule, candidate: Date): boolean {
  return (
    schedule.minute(candidate.getUTCMinutes()) &&
    schedule.hour(candidate.getUTCHours()) &&
    schedule.dayOfMonth(candidate.getUTCDate()) &&
    schedule.month(candidate.getUTCMonth() + 1) &&
    schedule.dayOfWeek(candidate.getUTCDay())
  );
}

function parseCronExpression(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Cron expression must contain 5 fields: ${expression}`);
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  return {
    minute: parseCronField(minute, 0, 59, "minute"),
    hour: parseCronField(hour, 0, 23, "hour"),
    dayOfMonth: parseCronField(dayOfMonth, 1, 31, "day-of-month"),
    month: parseCronField(month, 1, 12, "month"),
    dayOfWeek: parseCronField(dayOfWeek, 0, 7, "day-of-week"),
  };
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  label: string,
): CronMatcher {
  const allowed = new Set<number>();
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (!part) {
      throw new Error(
        `Cron ${label} field contains an empty segment: ${field}`,
      );
    }
    for (const value of expandCronPart(part, min, max, label)) {
      allowed.add(value === 7 && label === "day-of-week" ? 0 : value);
    }
  }

  return (value: number) => allowed.has(value);
}

function expandCronPart(
  part: string,
  min: number,
  max: number,
  label: string,
): number[] {
  const [base, stepValue] = part.split("/");
  const step =
    stepValue === undefined
      ? 1
      : parseCronNumber(stepValue, min, max, label, true);
  if (step <= 0) {
    throw new Error(`Cron ${label} step must be positive: ${part}`);
  }

  let start: number;
  let end: number;
  if (base === "*" || base === "") {
    start = min;
    end = max;
  } else if (base.includes("-")) {
    const [rawStart, rawEnd] = base.split("-", 2);
    start = parseCronNumber(rawStart, min, max, label);
    end = parseCronNumber(rawEnd, min, max, label);
  } else {
    start = parseCronNumber(base, min, max, label);
    end = start;
  }

  if (end < start) {
    throw new Error(`Cron ${label} range is invalid: ${part}`);
  }

  const values: number[] = [];
  for (let value = start; value <= end; value += 1) {
    if ((value - start) % step === 0) {
      values.push(value);
    }
  }
  return values;
}

function parseCronNumber(
  value: string,
  min: number,
  max: number,
  label: string,
  allowStepOverflow = false,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Cron ${label} field must be an integer: ${value}`);
  }

  if (allowStepOverflow) {
    return parsed;
  }

  if (parsed < min || parsed > max) {
    throw new Error(
      `Cron ${label} field must be between ${min} and ${max}: ${value}`,
    );
  }

  return parsed;
}

function parseTriggerTime(value: string | null): Date | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Date(timestamp);
}

function cloneTriggers(
  triggers: readonly StepCliTriggerDescriptor[],
): StepCliTriggerDescriptor[] {
  return triggers.map((trigger) => ({
    ...trigger,
    cron: { ...trigger.cron },
    input: trigger.input,
  }));
}
