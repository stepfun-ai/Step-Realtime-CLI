import { describe, it, expect, afterEach } from "vitest";
import {
  isOpenTuiEnabledInCurrentBuild,
  isOpenTuiRuntimeSupported,
  parseOpenTuiEnabledValue,
  warnWhenOpenTuiRuntimeUnsupported,
} from "./open-tui-capability.js";

const originalBunVersion = process.versions.bun;

afterEach(() => {
  // Restore process.versions.bun between tests so mocks don't leak.
  if (originalBunVersion === undefined) {
    delete (process.versions as { bun?: string }).bun;
  } else {
    (process.versions as { bun?: string }).bun = originalBunVersion;
  }
});

describe("parseOpenTuiEnabledValue", () => {
  it("returns true when value is undefined", () => {
    expect(parseOpenTuiEnabledValue(undefined)).toBe(true);
  });

  it("returns false for '0' and 'false' (case-insensitive)", () => {
    expect(parseOpenTuiEnabledValue("0")).toBe(false);
    expect(parseOpenTuiEnabledValue("false")).toBe(false);
    expect(parseOpenTuiEnabledValue("FALSE")).toBe(false);
    expect(parseOpenTuiEnabledValue("  false  ")).toBe(false);
  });

  it("returns true for any other value", () => {
    expect(parseOpenTuiEnabledValue("1")).toBe(true);
    expect(parseOpenTuiEnabledValue("true")).toBe(true);
  });
});

describe("isOpenTuiEnabledInCurrentBuild", () => {
  it("reflects the STEP_CLI_ENABLE_OPENTUI env var parsed at module load", () => {
    // Module was loaded with whatever env was active at import time; we just
    // assert the function returns a boolean and does not throw.
    expect(typeof isOpenTuiEnabledInCurrentBuild()).toBe("boolean");
  });
});

describe("isOpenTuiRuntimeSupported", () => {
  it("returns true when process.versions.bun is a version string", () => {
    (process.versions as { bun?: string }).bun = "1.1.0";
    expect(isOpenTuiRuntimeSupported()).toBe(true);
  });

  it("returns false when process.versions.bun is undefined (Node.js)", () => {
    delete (process.versions as { bun?: string }).bun;
    expect(isOpenTuiRuntimeSupported()).toBe(false);
  });

  it("returns false when process.versions.bun is an empty string", () => {
    (process.versions as { bun?: string }).bun = "";
    expect(isOpenTuiRuntimeSupported()).toBe(false);
  });
});

describe("warnWhenOpenTuiRuntimeUnsupported", () => {
  it("warns only when the runtime is the sole blocker for an interactive TUI", () => {
    delete (process.versions as { bun?: string }).bun;
    const messages: string[] = [];
    const stderr = {
      isTTY: true,
      write: (message: string) => {
        messages.push(message);
        return true;
      },
    };

    warnWhenOpenTuiRuntimeUnsupported(true, stderr);
    warnWhenOpenTuiRuntimeUnsupported(false, stderr);

    expect(messages).toEqual([
      "warning: OpenTUI TUI requires Bun runtime; falling back to text CLI. Install Bun or use a Bun-based launcher.\n",
    ]);
  });

  it("does not warn when Bun supports the TUI runtime", () => {
    (process.versions as { bun?: string }).bun = "1.1.0";
    const messages: string[] = [];

    warnWhenOpenTuiRuntimeUnsupported(true, {
      isTTY: true,
      write: (message: string) => {
        messages.push(message);
        return true;
      },
    });

    expect(messages).toEqual([]);
  });
});
