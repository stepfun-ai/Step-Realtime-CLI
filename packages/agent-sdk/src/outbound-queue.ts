import type { SDKMessage } from "./types.js";

/**
 * Bounded outbound queue for SDKMessages produced by the SDK and consumed by
 * the host's `for await (const message of query()) {...}` loop.
 *
 * Mirrors the shape of `AsyncFifo<SDKMessage>` from @step-cli/utils but adds a
 * high-watermark eviction policy: when the buffer is full we drop the oldest
 * `stream_event` (input_json_delta / text_delta) entries first since those are
 * replayable deltas of the final assistant message. If no stream_event is
 * available to evict we drop the oldest message of any kind so the queue
 * cannot grow unbounded.
 */
const DEFAULT_HIGH_WATERMARK = 1024;

type Waiter = {
  resolve: (value: IteratorResult<SDKMessage>) => void;
  reject: (error: unknown) => void;
};

export class OutboundQueue {
  private readonly buffer: SDKMessage[] = [];
  private readonly maxBuffered: number;
  private waiter: Waiter | null = null;
  private done = false;
  private error: unknown = null;

  constructor(maxBuffered: number = DEFAULT_HIGH_WATERMARK) {
    this.maxBuffered = maxBuffered;
  }

  push(message: SDKMessage): void {
    if (this.done) return;
    if (this.waiter) {
      const { resolve } = this.waiter;
      this.waiter = null;
      resolve({ value: message, done: false });
      return;
    }
    if (this.buffer.length >= this.maxBuffered) this.evictOldest();
    this.buffer.push(message);
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    if (this.waiter) {
      const { resolve } = this.waiter;
      this.waiter = null;
      resolve({ value: undefined as unknown as SDKMessage, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.done) return;
    this.done = true;
    this.error = error;
    if (this.waiter) {
      const { reject } = this.waiter;
      this.waiter = null;
      reject(error);
    }
  }

  iterator(): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const head = this.buffer.shift();
        if (head) return Promise.resolve({ value: head, done: false });
        if (this.done) {
          if (this.error) return Promise.reject(this.error);
          return Promise.resolve({
            value: undefined as unknown as SDKMessage,
            done: true,
          });
        }
        return new Promise<IteratorResult<SDKMessage>>((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({
          value: undefined as unknown as SDKMessage,
          done: true,
        });
      },
    };
  }

  private evictOldest(): void {
    for (let i = 0; i < this.buffer.length; i += 1) {
      if (this.buffer[i]?.type === "stream_event") {
        this.buffer.splice(i, 1);
        return;
      }
    }
    this.buffer.shift();
  }
}
