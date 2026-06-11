import { describe, it, expect } from "vitest";
import { resolveSoxAudioCommands } from "./sox-driver.js";

describe("resolveSoxAudioCommands", () => {
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
