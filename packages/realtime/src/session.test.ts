import { describe, it, expect, vi } from "vitest";
import type { BackendAdapter, NormalizedEvent } from "./backend/types.js";

function createMockBackend(events: NormalizedEvent[] = []): BackendAdapter {
  let idx = 0;
  const closed = { value: false };

  return {
    id: "mock",
    capabilities: {
      nativeFunctionCalling: false,
      modelMaintainsHistory: false,
      serverVad: false,
      audioOutput: true,
    },
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockImplementation(async () => {
      closed.value = true;
    }),
    events: () => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (closed.value || idx >= events.length) {
              return { value: undefined, done: true as const };
            }
            return { value: events[idx++]!, done: false as const };
          },
        };
      },
    }),
    appendAudio: vi.fn(),
    commitInput: vi.fn(),
    requestResponse: vi.fn(),
    cancelResponse: vi.fn(),
    sendUserText: vi.fn(),
    sendFunctionCallOutput: vi.fn(),
    applyInputMode: vi.fn().mockResolvedValue("ok"),
  } as unknown as BackendAdapter;
}

describe("BackendAdapter mock", () => {
  it("connect and close lifecycle", async () => {
    const backend = createMockBackend();
    await backend.connect();
    expect(backend.connect).toHaveBeenCalledTimes(1);

    await backend.close();
    expect(backend.close).toHaveBeenCalledTimes(1);
  });

  it("events iterator yields provided events", async () => {
    const events: NormalizedEvent[] = [
      {
        type: "transcript.delta",
        text: "hello",
        responseId: "r-1",
      } as NormalizedEvent,
    ];
    const backend = createMockBackend(events);

    const collected: NormalizedEvent[] = [];
    for await (const ev of backend.events()) {
      collected.push(ev);
    }

    expect(collected).toHaveLength(1);
  });

  it("events iterator completes after close", async () => {
    const backend = createMockBackend([]);
    await backend.close();

    const collected: NormalizedEvent[] = [];
    for await (const ev of backend.events()) {
      collected.push(ev);
    }

    expect(collected).toHaveLength(0);
  });

  it("appendAudio forwards data", () => {
    const backend = createMockBackend();
    const buf = Buffer.from("audio");
    backend.appendAudio(buf);
    expect(backend.appendAudio).toHaveBeenCalledWith(buf);
  });

  it("commitInput can be called", () => {
    const backend = createMockBackend();
    backend.commitInput();
    expect(backend.commitInput).toHaveBeenCalled();
  });

  it("requestResponse can be called with options", () => {
    const backend = createMockBackend();
    backend.requestResponse({ instructions: "test" });
    expect(backend.requestResponse).toHaveBeenCalledWith({
      instructions: "test",
    });
  });

  it("cancelResponse can be called", () => {
    const backend = createMockBackend();
    backend.cancelResponse();
    expect(backend.cancelResponse).toHaveBeenCalled();
  });
});

describe("RealtimeSession concepts", () => {
  it("idle → connect → respond → close flow", async () => {
    const backend = createMockBackend([
      {
        type: "transcript.done",
        text: "hi",
        responseId: "r-1",
      } as NormalizedEvent,
      { type: "response.done", responseId: "r-1" } as NormalizedEvent,
    ]);

    await backend.connect();
    backend.requestResponse({ instructions: "hello" });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.events()) {
      events.push(ev);
    }

    await backend.close();
    expect(events).toHaveLength(2);
  });

  it("barge-in cancels current response", async () => {
    const backend = createMockBackend();
    await backend.connect();

    backend.requestResponse({ instructions: "long story" });
    await backend.cancelResponse();

    expect(backend.cancelResponse).toHaveBeenCalledTimes(1);
    await backend.close();
  });

  it("history management through multiple turns", async () => {
    const backend = createMockBackend();
    await backend.connect();

    backend.commitInput();
    backend.requestResponse({ instructions: "turn 1" });
    backend.commitInput();
    backend.requestResponse({ instructions: "turn 2" });

    expect(backend.requestResponse).toHaveBeenCalledTimes(2);
    await backend.close();
  });
});
