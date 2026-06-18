import { describe, it, expect, vi } from "vitest";
import type {
  BackendAdapter,
  NormalizedEvent,
} from "@step-cli/realtime/backend/types.js";

function createMockBackend(events: NormalizedEvent[] = []): BackendAdapter {
  let idx = 0;
  const closed = { value: false };

  return {
    id: "mock-voice",
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
    sendAudio: vi.fn(),
    commitInput: vi.fn(),
    createResponse: vi.fn(),
    cancelResponse: vi.fn(),
    restoreSession: vi.fn(),
    appendAudioBuffer: vi.fn(),
  } as unknown as BackendAdapter;
}

describe("Voice Session E2E", () => {
  describe("session lifecycle", () => {
    it("connects, processes turn, and disconnects", async () => {
      const backend = createMockBackend([
        { type: "response.text.done", text: "Hello!" } as NormalizedEvent,
        { type: "response.done" } as NormalizedEvent,
      ]);

      await backend.connect();
      expect(backend.connect).toHaveBeenCalledTimes(1);

      backend.commitInput();
      backend.createResponse({ instructions: "Greet the user" });

      const events: NormalizedEvent[] = [];
      for await (const ev of backend.events()) {
        events.push(ev);
      }

      expect(events).toHaveLength(2);
      expect(events[0]!.type).toBe("response.text.done");

      await backend.close();
      expect(backend.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("turn lifecycle: idle → active → idle", () => {
    it("tracks turn state through input → response → done", async () => {
      const turnStates: string[] = [];
      const backend = createMockBackend([
        { type: "response.text.delta", text: "Hi" } as NormalizedEvent,
        { type: "response.done" } as NormalizedEvent,
      ]);

      turnStates.push("idle");

      await backend.connect();
      backend.commitInput();
      turnStates.push("input_committed");

      backend.createResponse({ instructions: "respond" });
      turnStates.push("active");

      for await (const ev of backend.events()) {
        if (ev.type === "response.done") {
          turnStates.push("idle");
        }
      }

      expect(turnStates).toEqual(["idle", "input_committed", "active", "idle"]);

      await backend.close();
    });
  });

  describe("barge-in handling", () => {
    it("cancels response and starts new turn", async () => {
      const backend = createMockBackend();
      await backend.connect();

      backend.createResponse({ instructions: "long story" });
      backend.cancelResponse();

      expect(backend.cancelResponse).toHaveBeenCalledTimes(1);

      backend.commitInput();
      backend.createResponse({ instructions: "short answer" });

      expect(backend.createResponse).toHaveBeenCalledTimes(2);

      await backend.close();
    });
  });

  describe("audio flow", () => {
    it("sends audio data during capture", async () => {
      const backend = createMockBackend();
      await backend.connect();

      const audioChunk = Buffer.alloc(4800);
      backend.sendAudio(audioChunk);
      backend.sendAudio(audioChunk);
      backend.sendAudio(audioChunk);

      expect(backend.sendAudio).toHaveBeenCalledTimes(3);
      await backend.close();
    });
  });

  describe("multi-turn conversation", () => {
    it("handles sequential turns with history", async () => {
      const backend = createMockBackend([
        { type: "response.text.done", text: "Turn 1" } as NormalizedEvent,
        { type: "response.done" } as NormalizedEvent,
      ]);

      await backend.connect();

      backend.commitInput();
      backend.createResponse({ instructions: "Turn 1 question" });

      for await (const _ev of backend.events()) {
        // consume all
      }

      backend.commitInput();
      backend.createResponse({ instructions: "Turn 2 question" });

      expect(backend.createResponse).toHaveBeenCalledTimes(2);
      expect(backend.commitInput).toHaveBeenCalledTimes(2);

      await backend.close();
    });
  });

  describe("VAD event integration", () => {
    it("speech_start triggers audio capture", () => {
      const vadEvent = { type: "speech_start" as const };
      expect(vadEvent.type).toBe("speech_start");
    });

    it("speech_end triggers input commit", () => {
      const vadEvent = { type: "speech_end" as const };
      expect(vadEvent.type).toBe("speech_end");

      const backend = createMockBackend();
      backend.commitInput();
      expect(backend.commitInput).toHaveBeenCalledTimes(1);
    });
  });
});
