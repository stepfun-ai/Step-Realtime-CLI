import { randomUUID } from "node:crypto";
import type {
  SessionWakeReason,
  StepCliSessionEvent,
  StepCliSessionEventKind,
} from "@step-cli/protocol";

interface SessionEventInput {
  sessionId: string;
  kind: StepCliSessionEventKind;
  wakeId?: string;
  reason?: SessionWakeReason;
  queueDepth?: number;
  outcome?: StepCliSessionEvent["outcome"];
  payload?: Record<string, unknown>;
}

interface SessionEventSubscriber {
  queue: StepCliSessionEvent[];
  resolve: (() => void) | null;
  closed: boolean;
  retired: boolean;
}

const DEFAULT_MAX_BUFFERED_EVENTS = 2_048;

export class SessionEventCursorExpiredError extends Error {
  readonly sessionId: string;
  readonly afterEventId: string;
  readonly lastEventId: string | null;

  constructor(input: {
    sessionId: string;
    afterEventId: string;
    lastEventId: string | null;
  }) {
    super(
      [
        `Session event cursor '${input.afterEventId}' for '${input.sessionId}' is stale or unavailable.`,
        "Refetch the latest session snapshot and resubscribe from its host.lastEventId.",
      ].join(" "),
    );
    this.name = "SessionEventCursorExpiredError";
    this.sessionId = input.sessionId;
    this.afterEventId = input.afterEventId;
    this.lastEventId = input.lastEventId;
  }
}

export class SessionEventBus {
  private readonly bufferedEvents = new Map<string, StepCliSessionEvent[]>();
  private readonly subscribers = new Map<string, Set<SessionEventSubscriber>>();

  constructor(
    private readonly maxBufferedEvents = DEFAULT_MAX_BUFFERED_EVENTS,
  ) {}

  publish(input: SessionEventInput): StepCliSessionEvent {
    const event: StepCliSessionEvent = {
      eventId: randomUUID(),
      sessionId: input.sessionId,
      kind: input.kind,
      recordedAt: new Date().toISOString(),
      wakeId: input.wakeId,
      reason: input.reason,
      queueDepth: input.queueDepth,
      outcome: input.outcome,
      payload: input.payload ? { ...input.payload } : undefined,
    };

    const buffer = this.bufferedEvents.get(input.sessionId) ?? [];
    buffer.push(event);
    if (buffer.length > this.maxBufferedEvents) {
      buffer.splice(0, buffer.length - this.maxBufferedEvents);
    }
    this.bufferedEvents.set(input.sessionId, buffer);

    const subscribers = this.subscribers.get(input.sessionId);
    if (subscribers) {
      for (const subscriber of subscribers) {
        if (subscriber.closed) {
          continue;
        }
        subscriber.queue.push(event);
        const resolve = subscriber.resolve;
        subscriber.resolve = null;
        resolve?.();
      }
    }

    return event;
  }

  getLastEventId(sessionId: string): string | null {
    const buffer = this.bufferedEvents.get(sessionId);
    const last = buffer?.at(-1);
    return last?.eventId ?? null;
  }

  clearSession(sessionId: string): void {
    this.bufferedEvents.delete(sessionId);
    this.retireSessionSubscribers(sessionId);
  }

  retireSessionSubscribers(sessionId: string): void {
    const subscribers = this.subscribers.get(sessionId);
    if (!subscribers) {
      return;
    }

    this.subscribers.delete(sessionId);
    for (const subscriber of subscribers) {
      subscriber.retired = true;
      const resolve = subscriber.resolve;
      subscriber.resolve = null;
      resolve?.();
    }
  }

  retireAllSubscribers(): void {
    const sessionIds = [...this.subscribers.keys()];
    for (const sessionId of sessionIds) {
      this.retireSessionSubscribers(sessionId);
    }
  }

  assertCursorAvailable(
    sessionId: string,
    afterEventId: string | undefined,
  ): void {
    void this.getReplayEvents(sessionId, afterEventId);
  }

  subscribe(
    sessionId: string,
    options: {
      afterEventId?: string;
      signal?: AbortSignal;
    } = {},
  ): AsyncIterable<StepCliSessionEvent> {
    const subscriber: SessionEventSubscriber = {
      queue: this.getReplayEvents(sessionId, options.afterEventId),
      resolve: null,
      closed: false,
      retired: false,
    };

    const close = () => {
      if (subscriber.closed) {
        return;
      }

      subscriber.closed = true;
      const listeners = this.subscribers.get(sessionId);
      listeners?.delete(subscriber);
      if (listeners && listeners.size === 0) {
        this.subscribers.delete(sessionId);
      }

      const resolve = subscriber.resolve;
      subscriber.resolve = null;
      resolve?.();
    };

    let removeAbortListener: (() => void) | null = null;
    if (options.signal) {
      if (options.signal.aborted) {
        subscriber.closed = true;
      } else {
        const onAbort = () => {
          close();
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => {
          options.signal?.removeEventListener("abort", onAbort);
        };
      }
    }

    if (!subscriber.closed) {
      const listeners = this.subscribers.get(sessionId) ?? new Set();
      listeners.add(subscriber);
      this.subscribers.set(sessionId, listeners);
    }

    return {
      [Symbol.asyncIterator]: async function* () {
        try {
          while (true) {
            if (subscriber.queue.length === 0) {
              if (subscriber.closed || subscriber.retired) {
                break;
              }
              await new Promise<void>((resolve) => {
                subscriber.resolve = resolve;
              });
              continue;
            }

            while (subscriber.queue.length > 0) {
              const next = subscriber.queue.shift();
              if (!next) {
                break;
              }
              yield next;
            }

            if (subscriber.closed || subscriber.retired) {
              break;
            }
          }
        } finally {
          removeAbortListener?.();
          close();
        }
      },
    };
  }

  private getReplayEvents(
    sessionId: string,
    afterEventId: string | undefined,
  ): StepCliSessionEvent[] {
    if (!afterEventId) {
      return [];
    }

    const buffer = this.bufferedEvents.get(sessionId);
    if (!buffer || buffer.length === 0) {
      throw new SessionEventCursorExpiredError({
        sessionId,
        afterEventId,
        lastEventId: null,
      });
    }

    const index = buffer.findIndex((event) => event.eventId === afterEventId);
    if (index < 0) {
      throw new SessionEventCursorExpiredError({
        sessionId,
        afterEventId,
        lastEventId: buffer.at(-1)?.eventId ?? null,
      });
    }

    return buffer.slice(index + 1);
  }
}
