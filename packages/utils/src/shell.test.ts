import { describe, it, expect } from "vitest";
import os from "node:os";
import { enforceOutputLimit, runShell } from "./shell.js";

const BIG_LIMIT = 1_000_000;

// ---------------------------------------------------------------------------
// shell.ts (from batch2)
// ---------------------------------------------------------------------------
describe("enforceOutputLimit", () => {
  it("returns the input unchanged when it is under the limit", () => {
    expect(enforceOutputLimit("hello", 100)).toBe("hello");
  });

  it("returns the input unchanged when length equals the limit", () => {
    const input = "a".repeat(50);
    expect(enforceOutputLimit(input, 50)).toBe(input);
  });

  it("truncates with head/tail split when over the limit", () => {
    const input = "a".repeat(200);
    const result = enforceOutputLimit(input, 100);
    expect(result.length).toBeGreaterThan(100); // marker adds chars
    expect(result).toContain("[truncated");
    // head is 40% of limit = 40 chars of 'a'
    const head = result.slice(0, 40);
    expect(head).toBe("a".repeat(40));
    // tail is 60% of limit = 60 chars of 'a'
    expect(result.endsWith("a".repeat(60))).toBe(true);
  });

  it("returns the input when limit is 0 and input is empty", () => {
    expect(enforceOutputLimit("", 0)).toBe("");
  });

  it("truncates when limit is 0 and input is non-empty", () => {
    const result = enforceOutputLimit("hello", 0);
    // head = max(0, 0 - 0) = 0, tail = floor(0 * 0.6) = 0
    // result = "" + marker + ""
    expect(result).toContain("[truncated");
  });

  it("truncates when limit is 1", () => {
    const input = "abcde";
    const result = enforceOutputLimit(input, 1);
    // head = max(0, 1 - floor(0.6)) = max(0, 1-0) = 1
    // tail = floor(1 * 0.6) = 0
    expect(result).toContain("[truncated");
    expect(result.startsWith("a")).toBe(true);
  });

  it("preserves beginning (head) and ending (tail) of output", () => {
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`line ${i.toString().padStart(3, "0")}`);
    }
    const input = lines.join("\n");
    const limit = 200;
    const result = enforceOutputLimit(input, limit);
    // Should contain first lines and last lines
    expect(result).toContain("line 000");
    expect(result).toContain("line 099");
    expect(result).not.toContain("line 050");
  });
});

// ---------------------------------------------------------------------------
// shell.ts (additional edge cases from batch4)
// ---------------------------------------------------------------------------
describe("enforceOutputLimit", () => {
  it("returns value unchanged when within limit", () => {
    expect(enforceOutputLimit("short", 100)).toBe("short");
  });

  it("returns value unchanged when exactly at limit", () => {
    const s = "a".repeat(50);
    expect(enforceOutputLimit(s, 50)).toBe(s);
  });

  it("truncates with head+tail when over limit", () => {
    const s = "a".repeat(200);
    const result = enforceOutputLimit(s, 100);
    expect(result).toContain("[truncated");
    // head = 40% of limit = 40 chars, tail = 60% = 60 chars
    expect(result.startsWith("a".repeat(40))).toBe(true);
    expect(result.endsWith("a".repeat(60))).toBe(true);
  });

  it("handles limit of 0", () => {
    const result = enforceOutputLimit("hello", 0);
    expect(result).toContain("[truncated");
  });

  it("handles empty string", () => {
    expect(enforceOutputLimit("", 10)).toBe("");
  });

  it("handles single-char limit", () => {
    const result = enforceOutputLimit("abcdef", 1);
    expect(result).toContain("[truncated");
  });
});

// ---------------------------------------------------------------------------
// runShell (real child processes via spawn)
// ---------------------------------------------------------------------------
describe("runShell", () => {
  const cwd = os.tmpdir();

  it("captures stdout from a successful command", async () => {
    const result = await runShell("echo hello-world", {
      cwd,
      timeoutMs: 10_000,
      outputLimit: BIG_LIMIT,
    });
    expect(result.stdout).toContain("hello-world");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.interrupted).toBe(false);
  });

  it("captures stderr and a non-zero exit code", async () => {
    const result = await runShell("echo oops 1>&2; exit 3", {
      cwd,
      timeoutMs: 10_000,
      outputLimit: BIG_LIMIT,
    });
    expect(result.stderr).toContain("oops");
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it("returns interrupted result immediately when signal already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runShell("echo never", {
      cwd,
      timeoutMs: 10_000,
      outputLimit: BIG_LIMIT,
      signal: controller.signal,
    });
    expect(result.interrupted).toBe(true);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toBe("Process interrupted before start.");
    expect(result.stdout).toBe("");
  });

  it("times out a long-running command and kills it", async () => {
    const result = await runShell("sleep 5", {
      cwd,
      timeoutMs: 100,
      outputLimit: BIG_LIMIT,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
    expect(result.interrupted).toBe(false);
    expect(result.stderr).toContain("Process killed after timeout");
  });

  it("interrupts a running command when the signal aborts mid-flight", async () => {
    const controller = new AbortController();
    const promise = runShell("sleep 5", {
      cwd,
      timeoutMs: 10_000,
      outputLimit: BIG_LIMIT,
      signal: controller.signal,
    });
    // Abort shortly after the child has started.
    setTimeout(() => controller.abort(), 100);
    const result = await promise;
    expect(result.interrupted).toBe(true);
    expect(result.exitCode).toBe(-1);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("Process interrupted by user.");
  });

  it("applies the output limit to large stdout", async () => {
    // Produce more than the limit so truncation kicks in.
    const result = await runShell(
      "for i in $(seq 1 200); do echo 0123456789; done",
      { cwd, timeoutMs: 10_000, outputLimit: 100 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[truncated");
  });

  it("returns exitCode -1 when the close code is null (killed by timeout)", async () => {
    const result = await runShell("sleep 5", {
      cwd,
      timeoutMs: 50,
      outputLimit: BIG_LIMIT,
    });
    expect(result.exitCode).toBe(-1);
  });
});
