import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getVoiceRuntimeError } from "./voice-command.js";

const originalBunVersion = process.versions.bun;

beforeEach(() => {
  delete (process.versions as { bun?: string }).bun;
});

afterEach(() => {
  if (originalBunVersion === undefined) {
    delete (process.versions as { bun?: string }).bun;
  } else {
    (process.versions as { bun?: string }).bun = originalBunVersion;
  }
});

describe("getVoiceRuntimeError", () => {
  it("returns null on Bun runtime", () => {
    (process.versions as { bun?: string }).bun = "1.1.0";
    expect(getVoiceRuntimeError()).toBeNull();
  });

  it("returns a non-empty error string on Node runtime", () => {
    expect(getVoiceRuntimeError()).not.toBeNull();
    expect(getVoiceRuntimeError()).toMatch(/Bun runtime/);
  });

  it("error message mentions STEP_BUN_BIN for actionable recovery", () => {
    expect(getVoiceRuntimeError()).toMatch(/STEP_BUN_BIN/);
  });
});
