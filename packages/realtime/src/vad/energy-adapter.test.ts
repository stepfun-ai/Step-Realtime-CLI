import { describe, it, expect } from "vitest";

async function loadFactory() {
  const mod = await import("./energy-adapter.js");
  return mod.createVadAdapter;
}

function makePcm(sampleCount: number, amplitude: number): Buffer {
  const buf = Buffer.alloc(sampleCount * 2);
  const value = Math.round(amplitude * 32767);
  for (let i = 0; i < sampleCount; i++) {
    buf.writeInt16LE(value, i * 2);
  }
  return buf;
}

describe("EnergyVadAdapter", () => {
  it("starts in silent state — no event for silence", async () => {
    const factory = await loadFactory();
    const adapter = await factory();
    const event = await adapter.processFrame(makePcm(480, 0));
    expect(event).toBeNull();
  });

  it("emits speech_start after sustained loud frames", async () => {
    const factory = await loadFactory();
    const adapter = await factory({
      thresholdUp: 0.02,
      startMs: 50,
      sampleRate: 24000,
    });

    let started = false;
    for (let i = 0; i < 20; i++) {
      const event = await adapter.processFrame(makePcm(2400, 0.5));
      if (event?.type === "speech_start") {
        started = true;
        break;
      }
    }

    expect(started).toBe(true);
  });

  it("emits speech_end after sustained silence following speech", async () => {
    const factory = await loadFactory();
    const adapter = await factory({
      thresholdUp: 0.02,
      thresholdDown: 0.01,
      startMs: 50,
      silenceMs: 100,
      sampleRate: 24000,
    });

    for (let i = 0; i < 20; i++) {
      await adapter.processFrame(makePcm(2400, 0.5));
    }

    let ended = false;
    for (let i = 0; i < 30; i++) {
      const event = await adapter.processFrame(makePcm(2400, 0));
      if (event?.type === "speech_end") {
        ended = true;
        break;
      }
    }

    expect(ended).toBe(true);
  });

  it("returns null for empty buffer", async () => {
    const factory = await loadFactory();
    const adapter = await factory();
    expect(await adapter.processFrame(Buffer.alloc(0))).toBeNull();
  });

  it("reset returns to silent state", async () => {
    const factory = await loadFactory();
    const adapter = await factory({
      thresholdUp: 0.02,
      startMs: 50,
      sampleRate: 24000,
    });

    for (let i = 0; i < 20; i++) {
      await adapter.processFrame(makePcm(2400, 0.5));
    }

    adapter.reset();

    const event = await adapter.processFrame(makePcm(480, 0));
    expect(event).toBeNull();
  });

  it("does not emit speech_start on brief flutter", async () => {
    const factory = await loadFactory();
    const adapter = await factory({
      thresholdUp: 0.02,
      thresholdDown: 0.01,
      startMs: 200,
      sampleRate: 24000,
    });

    await adapter.processFrame(makePcm(480, 0.5));
    await adapter.processFrame(makePcm(480, 0));
    const event = await adapter.processFrame(makePcm(480, 0));
    expect(event).toBeNull();
  });

  it("uses default options when none provided", async () => {
    const factory = await loadFactory();
    const adapter = await factory();
    expect(adapter).toBeDefined();
    expect(typeof adapter.processFrame).toBe("function");
    expect(typeof adapter.reset).toBe("function");
  });
});
