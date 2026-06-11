import { describe, it, expect } from "vitest";
import { renderCommandOutput, enforceOutputLimit } from "./command-output.js";

// ---------------------------------------------------------------------------
// command-output.ts
// ---------------------------------------------------------------------------

describe("renderCommandOutput", () => {
  it("renders full output with stdout and stderr", () => {
    const result = renderCommandOutput({
      exitCode: 0,
      timedOut: false,
      stdout: "hello",
      stderr: "warning",
    });

    expect(result).toContain("exit_code: 0");
    expect(result).toContain("timed_out: false");
    expect(result).toContain("stdout:");
    expect(result).toContain("hello");
    expect(result).toContain("stderr:");
    expect(result).toContain("warning");
  });

  it("renders stdout-only output", () => {
    const result = renderCommandOutput({
      exitCode: 0,
      timedOut: false,
      stdout: "output",
      stderr: "",
    });

    expect(result).toContain("stdout:");
    expect(result).toContain("output");
    expect(result).not.toContain("stderr:");
  });

  it("renders stderr-only output", () => {
    const result = renderCommandOutput({
      exitCode: 1,
      timedOut: false,
      stdout: "",
      stderr: "error",
    });

    expect(result).toContain("stderr:");
    expect(result).toContain("error");
    expect(result).not.toContain("stdout:");
  });

  it("renders both-empty output with no stdout/stderr sections", () => {
    const result = renderCommandOutput({
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
    });

    expect(result).not.toContain("stdout:");
    expect(result).not.toContain("stderr:");
    expect(result).toContain("exit_code: 0");
    expect(result).toContain("timed_out: false");
  });

  it("includes timeout note when timedOut is true and timeoutMs is provided", () => {
    const result = renderCommandOutput({
      exitCode: 1,
      timedOut: true,
      stdout: "",
      stderr: "",
      timeoutMs: 5000,
    });

    expect(result).toContain("note: Process killed after timeout (5000ms).");
  });

  it("does not include timeout note when timedOut is false", () => {
    const result = renderCommandOutput({
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
      timeoutMs: 5000,
    });

    expect(result).not.toContain("note:");
  });

  it("does not include timeout note when timedOut is true but no timeoutMs", () => {
    const result = renderCommandOutput({
      exitCode: 1,
      timedOut: true,
      stdout: "",
      stderr: "",
    });

    expect(result).not.toContain("note:");
  });

  it("omits stdout when it contains only whitespace", () => {
    const result = renderCommandOutput({
      exitCode: 0,
      timedOut: false,
      stdout: "   \n\t  ",
      stderr: "actual error",
    });

    expect(result).not.toContain("stdout:");
    expect(result).toContain("stderr:");
  });

  it("renders non-zero exit code", () => {
    const result = renderCommandOutput({
      exitCode: 127,
      timedOut: false,
      stdout: "",
      stderr: "not found",
    });

    expect(result).toContain("exit_code: 127");
  });
});

describe("enforceOutputLimit", () => {
  it("returns value unchanged when under limit", () => {
    const value = "short";
    expect(enforceOutputLimit(value, 100)).toBe("short");
  });

  it("returns value unchanged when exactly at limit", () => {
    const value = "a".repeat(50);
    expect(enforceOutputLimit(value, 50)).toBe(value);
  });

  it("truncates and includes truncation indicator when over limit", () => {
    const value = "abcdefghij".repeat(10); // 100 chars
    const limit = 40;
    const result = enforceOutputLimit(value, limit);

    expect(result).toContain("[truncated");
    const tail = Math.floor(limit * 0.6); // 24
    const head = Math.max(0, limit - tail); // 16
    expect(result).toContain(value.slice(0, head));
    expect(result).toContain(value.slice(value.length - tail));
  });

  it("handles limit of 0", () => {
    const value = "some text";
    const result = enforceOutputLimit(value, 0);
    expect(result).toContain("[truncated");
  });

  it("produces output that includes the truncation count", () => {
    const value = "a".repeat(100);
    const limit = 40;
    const result = enforceOutputLimit(value, limit);
    expect(result).toContain("60 chars");
  });
});
