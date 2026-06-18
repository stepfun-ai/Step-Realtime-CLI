import { describe, it, expect, vi } from "vitest";
import {
  userTurnTextFromMessage,
  TaskInputQueue,
  startInputPump,
} from "./input-queue.js";
import type { SDKUserMessage } from "./types.js";

describe("userTurnTextFromMessage", () => {
  it("string content returns that string", () => {
    const msg: SDKUserMessage = { role: "user", content: "hello" };
    expect(userTurnTextFromMessage(msg)).toBe("hello");
  });

  it("array of text blocks joined by newline", () => {
    const msg: SDKUserMessage = {
      role: "user",
      content: [
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
        { type: "text", text: "line3" },
      ],
    };
    expect(userTurnTextFromMessage(msg)).toBe("line1\nline2\nline3");
  });

  it("array with no text blocks returns empty string", () => {
    const msg: SDKUserMessage = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "id1", content: "result" }],
    };
    expect(userTurnTextFromMessage(msg)).toBe("");
  });

  it("empty string content returns empty string", () => {
    const msg: SDKUserMessage = { role: "user", content: "" };
    expect(userTurnTextFromMessage(msg)).toBe("");
  });

  it("mixed array with text and non-text blocks only returns text joined", () => {
    const msg: SDKUserMessage = {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "tool_result", tool_use_id: "id1", content: "data" },
        { type: "text", text: "world" },
      ],
    };
    expect(userTurnTextFromMessage(msg)).toBe("hello\nworld");
  });
});

describe("TaskInputQueue", () => {
  const normal: SDKUserMessage = { role: "user", content: "normal" };
  const nowMsg: SDKUserMessage = {
    role: "user",
    content: "urgent",
    priority: "now",
  };

  it("push then next returns the message in FIFO order", async () => {
    const q = new TaskInputQueue();
    q.push({ role: "user", content: "a" });
    q.push({ role: "user", content: "b" });
    expect((await q.next())?.content).toBe("a");
    expect((await q.next())?.content).toBe("b");
  });

  it("close causes next to resolve to null", async () => {
    const q = new TaskInputQueue();
    q.close();
    expect(await q.next()).toBeNull();
  });

  it("priority:'now' messages go to the side channel, not the main FIFO", async () => {
    const q = new TaskInputQueue();
    q.push(nowMsg);
    expect(q.pendingNowQueue).toHaveLength(1);
    q.close();
    // main FIFO never received the now-message
    expect(await q.next()).toBeNull();
  });

  it("drainPendingNow returns and empties the side channel", () => {
    const q = new TaskInputQueue();
    q.push(nowMsg);
    q.push({ role: "user", content: "urgent2", priority: "now" });
    const drained = q.drainPendingNow();
    expect(drained.map((m) => m.content)).toEqual(["urgent", "urgent2"]);
    expect(q.pendingNowQueue).toHaveLength(0);
  });

  it("drainPendingNow returns empty array when nothing pending", () => {
    const q = new TaskInputQueue();
    expect(q.drainPendingNow()).toEqual([]);
  });

  it("routes normal messages to main and now-messages aside in one mix", async () => {
    const q = new TaskInputQueue();
    q.push(normal);
    q.push(nowMsg);
    expect(q.pendingNowQueue).toHaveLength(1);
    expect((await q.next())?.content).toBe("normal");
  });
});

describe("startInputPump", () => {
  it("forwards every message from the source into the queue then closes it", async () => {
    const q = new TaskInputQueue();
    const closeSpy = vi.spyOn(q, "close");
    async function* source() {
      yield { role: "user", content: "1" } as SDKUserMessage;
      yield { role: "user", content: "2" } as SDKUserMessage;
    }
    startInputPump(source(), q, () => {});
    expect((await q.next())?.content).toBe("1");
    expect((await q.next())?.content).toBe("2");
    expect(await q.next()).toBeNull();
    expect(closeSpy).toHaveBeenCalled();
  });

  it("invokes onError and still closes the queue when the source throws", async () => {
    const q = new TaskInputQueue();
    const onError = vi.fn();
    async function* source(): AsyncGenerator<SDKUserMessage> {
      yield { role: "user", content: "x" };
      throw new Error("source failed");
    }
    startInputPump(source(), q, onError);
    expect((await q.next())?.content).toBe("x");
    // remaining messages closed out
    expect(await q.next()).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe("source failed");
  });
});
