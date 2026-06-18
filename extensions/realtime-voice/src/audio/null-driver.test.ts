import { describe, it, expect } from "vitest";
import { NullAudioDriver } from "./null-driver.js";

describe("NullAudioDriver", () => {
  it("startCapture returns a handle with empty stream and stop", async () => {
    const driver = new NullAudioDriver();
    const handle = driver.startCapture();

    expect(handle).toBeDefined();
    expect(typeof handle.stop).toBe("function");

    const chunks: Buffer[] = [];
    for await (const chunk of handle.stream) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(0);
  });

  it("startPlayback returns a handle with write/flush/stop no-ops", () => {
    const driver = new NullAudioDriver();
    const handle = driver.startPlayback();

    expect(typeof handle.write).toBe("function");
    expect(typeof handle.flush).toBe("function");
    expect(typeof handle.stop).toBe("function");

    expect(() => handle.write(Buffer.alloc(0))).not.toThrow();
    expect(() => handle.flush()).not.toThrow();
    expect(() => handle.stop()).not.toThrow();
  });

  it("probe reports neither capture nor playback available", async () => {
    const driver = new NullAudioDriver();
    const result = await driver.probe();
    expect(result.captureAvailable).toBe(false);
    expect(result.playbackAvailable).toBe(false);
  });

  it("dispose resolves without error", async () => {
    const driver = new NullAudioDriver();
    await expect(driver.dispose()).resolves.toBeUndefined();
  });
});
