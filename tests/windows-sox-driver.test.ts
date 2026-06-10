import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSoxAudioCommands } from "../extensions/realtime-voice/src/audio/sox-driver.js";

describe("resolveSoxAudioCommands", () => {
  it("keeps Linux arecord/aplay defaults", () => {
    const commands = resolveSoxAudioCommands({
      platform: "linux",
    });

    assert.equal(commands.capture.cmd, "arecord");
    assert.equal(commands.playback.cmd, "aplay");
  });

  it("does not pretend Linux audio commands are available on Windows", () => {
    assert.throws(
      () => resolveSoxAudioCommands({ platform: "win32" }),
      /SoxAudioDriver is not supported on Windows/,
    );
  });
});
