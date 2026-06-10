import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSoxAudioCommands } from "../extensions/realtime-voice/src/audio/sox-driver.js";

describe("resolveSoxAudioCommands", () => {
  it("trims blank macOS input device overrides before falling back to default", () => {
    const commands = resolveSoxAudioCommands({
      platform: "darwin",
      env: { STEP_SOX_INPUT_DEVICE: "   " },
    });

    assert.deepEqual(commands.capture, {
      cmd: "sox",
      args: [
        "-d",
        "-t",
        "raw",
        "-r",
        "24000",
        "-e",
        "signed",
        "-b",
        "16",
        "-c",
        "1",
        "-",
      ],
    });
  });

  it("allows macOS playback output device selection", () => {
    const commands = resolveSoxAudioCommands({
      platform: "darwin",
      env: { STEP_SOX_OUTPUT_DEVICE: "External Headphones" },
    });

    assert.deepEqual(commands.playback.args.slice(-3), [
      "-t",
      "coreaudio",
      "External Headphones",
    ]);
  });

  it("keeps Linux arecord/aplay defaults", () => {
    const commands = resolveSoxAudioCommands({
      platform: "linux",
      env: {},
    });

    assert.equal(commands.capture.cmd, "arecord");
    assert.equal(commands.playback.cmd, "aplay");
  });
});
