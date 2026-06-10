import { AsyncFifo } from "@step-cli/utils/async-queue.js";
import type { SDKUserMessage } from "./types.js";

/**
 * AsyncFifo specialized for the turn driver, with a side channel for the
 * priority:"now" drain. The main FIFO wakes the driver via `next()`; the
 * pendingNowQueue is drained synchronously inside the SDK's beforeModelRequest
 * hook so the message lands in conversation memory before the next model call.
 */
export class TaskInputQueue {
  private readonly main = new AsyncFifo<SDKUserMessage>();
  readonly pendingNowQueue: SDKUserMessage[] = [];

  push(message: SDKUserMessage): void {
    if (message.priority === "now") {
      this.pendingNowQueue.push(message);
      return;
    }
    this.main.push(message);
  }

  close(): void {
    this.main.close();
  }

  next(): Promise<SDKUserMessage | null> {
    return this.main.next();
  }

  drainPendingNow(): SDKUserMessage[] {
    if (this.pendingNowQueue.length === 0) return [];
    return this.pendingNowQueue.splice(0, this.pendingNowQueue.length);
  }
}

export function startInputPump(
  source: AsyncIterable<SDKUserMessage>,
  queue: TaskInputQueue,
  onError: (error: unknown) => void,
): void {
  void (async () => {
    try {
      for await (const message of source) {
        queue.push(message);
      }
    } catch (error) {
      onError(error);
    } finally {
      queue.close();
    }
  })();
}

export function userTurnTextFromMessage(message: SDKUserMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}
