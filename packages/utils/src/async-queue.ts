export type AsyncFifoState = "open" | "closed" | "failed";

/**
 * Single-producer / single-consumer async FIFO. Producer pushes synchronously,
 * consumer pulls via `next()`; one parked waiter at a time. Used by the SDK
 * (input queue, outbound queue) and any other code that needs to bridge a
 * push-based source to an AsyncIterator without burning a setInterval.
 */
export class AsyncFifo<T> {
  private readonly buffer: T[] = [];
  private waiter: {
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  } | null = null;
  private state: AsyncFifoState = "open";
  private error: unknown = null;

  push(value: T): boolean {
    if (this.state !== "open") return false;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter.resolve({ value, done: false });
      return true;
    }
    this.buffer.push(value);
    return true;
  }

  close(): void {
    if (this.state !== "open") return;
    this.state = "closed";
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter.resolve({ value: undefined as T, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.state !== "open") return;
    this.state = "failed";
    this.error = error;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter.reject(error);
    }
  }

  /** Whether new push() calls will be accepted. */
  isOpen(): boolean {
    return this.state === "open";
  }

  /** Pull the next value. Returns null when the queue is closed cleanly. */
  next(): Promise<T | null> {
    const head = this.buffer.shift();
    if (head !== undefined) return Promise.resolve(head);
    if (this.state === "closed") return Promise.resolve(null);
    if (this.state === "failed") return Promise.reject(this.error);
    return new Promise<T | null>((resolve, reject) => {
      this.waiter = {
        resolve: (result) => {
          resolve(result.done ? null : result.value);
        },
        reject,
      };
    });
  }

  iterator(): AsyncIterator<T> {
    return {
      next: () => {
        const head = this.buffer.shift();
        if (head !== undefined) {
          return Promise.resolve({ value: head, done: false });
        }
        if (this.state === "closed") {
          return Promise.resolve({ value: undefined as T, done: true });
        }
        if (this.state === "failed") {
          return Promise.reject(this.error);
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined as T, done: true });
      },
    };
  }
}
