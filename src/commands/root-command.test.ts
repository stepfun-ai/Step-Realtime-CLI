import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { shouldUseTui } from "./root-command.js";

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

describe("shouldUseTui", () => {
  it("returns false on Node.js even when all other conditions hold", () => {
    const result = shouldUseTui({
      options: {},
      prompt: undefined,
      attachments: undefined,
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    expect(result).toBe(false);
  });

  it("returns true on Bun when stdin/stdout are TTY and no prompt/attachments/json", () => {
    (process.versions as { bun?: string }).bun = "1.1.0";
    const result = shouldUseTui({
      options: {},
      prompt: undefined,
      attachments: undefined,
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    expect(result).toBe(true);
  });

  it("returns false when --json is passed (even on Bun)", () => {
    (process.versions as { bun?: string }).bun = "1.1.0";
    const result = shouldUseTui({
      options: { json: true },
      prompt: undefined,
      attachments: undefined,
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    expect(result).toBe(false);
  });

  it("returns false when a prompt is provided (one-shot mode)", () => {
    (process.versions as { bun?: string }).bun = "1.1.0";
    const result = shouldUseTui({
      options: {},
      prompt: "summarize src/index.ts",
      attachments: undefined,
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    expect(result).toBe(false);
  });

  it("returns false when stdin is not a TTY (piped input)", () => {
    (process.versions as { bun?: string }).bun = "1.1.0";
    const result = shouldUseTui({
      options: {},
      prompt: undefined,
      attachments: undefined,
      stdinIsTTY: false,
      stdoutIsTTY: true,
    });
    expect(result).toBe(false);
  });
});
