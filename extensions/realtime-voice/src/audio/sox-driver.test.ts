import { describe, it, expect } from "vitest";
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
