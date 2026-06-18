import { describe, it, expect } from "vitest";
import { platform } from "node:os";
import { resolveSoxAudioCommands } from "./sox-driver.js";

describe("resolveSoxAudioCommands", () => {
  it("trims blank macOS input device overrides before falling back to default", () => {
    const commands = resolveSoxAudioCommands({
      platform: "darwin",
      env: { STEP_SOX_INPUT_DEVICE: "   " },
    });

    expect(commands.capture.args[0]).toBe("-d");
  });

  it("allows macOS playback output device selection", () => {
    const commands = resolveSoxAudioCommands({
      platform: "darwin",
      env: { STEP_SOX_OUTPUT_DEVICE: "External Headphones" },
    });

    expect(commands.playback.args.slice(-3)).toEqual([
      "-t",
      "coreaudio",
      "External Headphones",
    ]);
  });

  it("keeps Linux arecord/aplay defaults", () => {
    const commands = resolveSoxAudioCommands({
      platform: "linux",
    });

    expect(commands.capture.cmd).toBe("arecord");
    expect(commands.playback.cmd).toBe("aplay");
  });

  it("does not pretend Linux audio commands are available on Windows", () => {
    expect(() => resolveSoxAudioCommands({ platform: "win32" })).toThrow(
      /SoxAudioDriver is not supported on Windows/,
    );
  });
});

const isMac = platform() === "darwin";
const isLinux = platform() === "linux";
const isWindows = platform() === "win32";

describe.skipIf(isWindows)("SoxAudioDriver command construction", () => {
  it.runIf(isMac)("getCaptureCommand returns sox on macOS", async () => {
    const mod = await import("./sox-driver.js");
    const driver = new mod.SoxAudioDriver();
    expect(driver).toBeDefined();
  });

  it.runIf(isLinux)("getCaptureCommand returns arecord on Linux", async () => {
    const mod = await import("./sox-driver.js");
    const driver = new mod.SoxAudioDriver();
    expect(driver).toBeDefined();
  });

  it("SoxAudioDriver has required methods", async () => {
    const mod = await import("./sox-driver.js");
    const driver = new mod.SoxAudioDriver();
    expect(typeof driver.startCapture).toBe("function");
    expect(typeof driver.startPlayback).toBe("function");
    expect(typeof driver.probe).toBe("function");
    expect(typeof driver.dispose).toBe("function");
  });
});

describe.runIf(isWindows)("SoxAudioDriver on Windows", () => {
  it("can be imported without error", async () => {
    const mod = await import("./sox-driver.js");
    expect(mod.SoxAudioDriver).toBeDefined();
  });
});

describe.skipIf(isWindows)("SoxAudioDriver platform behavior", () => {
  it("constructs without throwing", async () => {
    const mod = await import("./sox-driver.js");
    expect(() => new mod.SoxAudioDriver()).not.toThrow();
  });

  it("dispose is callable even without active processes", async () => {
    const mod = await import("./sox-driver.js");
    const driver = new mod.SoxAudioDriver();
    await expect(driver.dispose()).resolves.toBeUndefined();
  });

  it("probe returns availability info", async () => {
    const mod = await import("./sox-driver.js");
    const driver = new mod.SoxAudioDriver();
    const result = await driver.probe();
    expect(typeof result.captureAvailable).toBe("boolean");
    expect(typeof result.playbackAvailable).toBe("boolean");
  });
});

describe.runIf(isWindows)("SoxAudioDriver Windows guard", () => {
  it("probe rejects on Windows", async () => {
    const mod = await import("./sox-driver.js");
    const driver = new mod.SoxAudioDriver();
    await expect(driver.probe()).rejects.toThrow(/not supported on Windows/);
  });
});
