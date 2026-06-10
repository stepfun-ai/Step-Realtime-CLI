export interface SessionQueueEnqueueResult<T> {
  queueDepth: number;
  promise: Promise<T>;
}

export class SessionQueue<T> {
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;
  private activeJobId: string | null = null;

  enqueue(
    jobId: string,
    runner: () => Promise<T> | T,
  ): SessionQueueEnqueueResult<T> {
    this.depth += 1;
    const queueDepth = this.depth;
    const run = async () => {
      this.activeJobId = jobId;
      try {
        return await runner();
      } finally {
        if (this.activeJobId === jobId) {
          this.activeJobId = null;
        }
        this.depth = Math.max(0, this.depth - 1);
      }
    };
    const promise = this.tail.then(run, run);

    this.tail = promise.then(
      () => undefined,
      () => undefined,
    );

    return {
      queueDepth,
      promise,
    };
  }

  getDepth(): number {
    return this.depth;
  }

  getActiveJobId(): string | null {
    return this.activeJobId;
  }

  async waitForIdle(): Promise<void> {
    await this.tail;
  }
}
