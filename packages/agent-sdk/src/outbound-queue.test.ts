import { describe, it, expect } from "vitest";
import { OutboundQueue } from "./outbound-queue.js";
import type { SDKMessage } from "./types.js";

describe("OutboundQueue", () => {
  it("push then iterator().next() resolves with pushed message", async () => {
    const q = new OutboundQueue();
    const msg: SDKMessage = {
      type: "assistant",
      session_id: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    };
    q.push(msg);
    const iter = q.iterator();
    const result = await iter.next();
    expect(result.done).toBe(false);
    expect(result.value).toBe(msg);
  });

  it("multiple pushes return in FIFO order via sequential next() calls", async () => {
    const q = new OutboundQueue();
    const msgs: SDKMessage[] = [
      {
        type: "assistant",
        session_id: "s1",
        message: { role: "assistant", content: [{ type: "text", text: "a" }] },
      },
      {
        type: "assistant",
        session_id: "s1",
        message: { role: "assistant", content: [{ type: "text", text: "b" }] },
      },
      {
        type: "assistant",
        session_id: "s1",
        message: { role: "assistant", content: [{ type: "text", text: "c" }] },
      },
    ];
    for (const m of msgs) q.push(m);
    const iter = q.iterator();
    expect((await iter.next()).value).toBe(msgs[0]);
    expect((await iter.next()).value).toBe(msgs[1]);
    expect((await iter.next()).value).toBe(msgs[2]);
  });

  it("evicts oldest stream_event when buffer fills to maxBuffered", async () => {
    const q = new OutboundQueue(3);
    const streamMsg: SDKMessage = {
      type: "stream_event",
      session_id: "s1",
      event: { type: "text_delta", text: "delta" },
    };
    const msgA: SDKMessage = {
      type: "assistant",
      session_id: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "a" }] },
    };
    const msgB: SDKMessage = {
      type: "assistant",
      session_id: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "b" }] },
    };
    q.push(streamMsg);
    q.push(msgA);
    q.push(msgB);

    // Buffer is full (3). Push another message to trigger eviction of the oldest stream_event.
    const msgC: SDKMessage = {
      type: "assistant",
      session_id: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "c" }] },
    };
    q.push(msgC);

    const iter = q.iterator();
    // streamMsg should have been evicted, so we get msgA, msgB, msgC
    expect((await iter.next()).value).toBe(msgA);
    expect((await iter.next()).value).toBe(msgB);
    expect((await iter.next()).value).toBe(msgC);
  });

  it("close() causes pending next() to resolve with done: true", async () => {
    const q = new OutboundQueue();
    const iter = q.iterator();
    const pending = iter.next();
    q.close();
    const result = await pending;
    expect(result.done).toBe(true);
  });

  it("close() causes future next() calls to resolve with done: true", async () => {
    const q = new OutboundQueue();
    q.close();
    const iter = q.iterator();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  it("fail(error) causes pending next() to reject with the error", async () => {
    const q = new OutboundQueue();
    const iter = q.iterator();
    const pending = iter.next();
    const err = new Error("boom");
    q.fail(err);
    await expect(pending).rejects.toBe(err);
  });

  it("push after close() is a no-op", async () => {
    const q = new OutboundQueue();
    q.close();
    q.push({
      type: "assistant",
      session_id: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
    });
    const iter = q.iterator();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  it("iterator().return() calls close() internally", async () => {
    const q = new OutboundQueue();
    const iter = q.iterator();
    await iter.return!();
    // After return, the queue should be closed
    const iter2 = q.iterator();
    const result = await iter2.next();
    expect(result.done).toBe(true);
  });

  it("next() called before push returns Promise that resolves once pushed (backpressure)", async () => {
    const q = new OutboundQueue();
    const iter = q.iterator();
    const pending = iter.next();
    // Not resolved yet — checking via microtask timing
    let resolved = false;
    pending.then(() => {
      resolved = true;
    });
    // Allow microtasks to flush
    await Promise.resolve();
    expect(resolved).toBe(false);

    const msg: SDKMessage = {
      type: "assistant",
      session_id: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "late" }] },
    };
    q.push(msg);
    const result = await pending;
    expect(resolved).toBe(true);
    expect(result.done).toBe(false);
    expect(result.value).toBe(msg);
  });

  it("respects custom maxBuffered constructor argument", async () => {
    const q = new OutboundQueue(2);
    // Fill with non-stream_event messages
    q.push({
      type: "assistant",
      session_id: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "a" }] },
    });
    q.push({
      type: "assistant",
      session_id: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "b" }] },
    });
    // Buffer full; push triggers eviction of oldest (non-stream, so .shift())
    q.push({
      type: "assistant",
      session_id: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "c" }] },
    });
    const iter = q.iterator();
    expect((await iter.next()).value).toMatchObject({
      message: { content: [{ text: "b" }] },
    });
    expect((await iter.next()).value).toMatchObject({
      message: { content: [{ text: "c" }] },
    });
  });
});
