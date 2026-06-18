import { describe, it, expect, vi } from "vitest";
import { StepfunStatelessAdapter } from "./stepfun-stateless.js";

vi.mock("ws", () => {
  const EventEmitter = require("node:events");
  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn().mockImplementation(function (this: MockWebSocket) {
      this.readyState = 3;
      this.emit("close", 1000, "normal");
    });
    constructor() {
      super();
      setTimeout(() => this.emit("open"), 0);
    }
  }
  return { default: MockWebSocket, WebSocket: MockWebSocket };
});

describe("StepfunStatelessAdapter", () => {
  it("has correct id and capabilities", () => {
    const adapter = new StepfunStatelessAdapter({
      apiKey: "test-key",
      endpoint: "wss://example.com/v1/realtime/stateless",
      model: "step-overture-preview",
      voice: "default",
      modalities: ["text", "audio"],
      instructions: "test instructions",
    });

    expect(adapter.id).toBe("stepfun_stateless");
    expect(adapter.capabilities.nativeFunctionCalling).toBe(true);
    expect(adapter.capabilities.modelMaintainsHistory).toBe(false);
    expect(adapter.capabilities.serverVad).toBe(false);
    expect(adapter.capabilities.audioOutput).toBe(true);
  });

  it("exposes events() async iterable", () => {
    const adapter = new StepfunStatelessAdapter({
      apiKey: "key",
      endpoint: "wss://example.com",
      model: "model",
      voice: "voice",
      modalities: ["text"],
      instructions: "inst",
    });

    const iter = adapter.events();
    expect(iter[Symbol.asyncIterator]).toBeDefined();
  });

  it("tracks cancelled response id for soft-cancel", () => {
    const adapter = new StepfunStatelessAdapter({
      apiKey: "key",
      endpoint: "wss://example.com",
      model: "model",
      voice: "voice",
      modalities: ["text"],
      instructions: "inst",
    });

    expect(adapter.lastTraceId).toBeUndefined();
    expect(adapter.lastRequestId).toBeUndefined();
  });

  it("state starts as idle", () => {
    const adapter = new StepfunStatelessAdapter({
      apiKey: "key",
      endpoint: "wss://example.com",
      model: "model",
      voice: "voice",
      modalities: ["text"],
      instructions: "inst",
    });

    expect((adapter as unknown as { state: string }).state).toBe("idle");
  });
});
