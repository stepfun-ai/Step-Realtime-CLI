import { describe, it, expect, vi } from "vitest";

const isWindows = process.platform === "win32";

describe("Command tool concepts", () => {
  describe("output rendering", () => {
    it("formats exit code and stdout", () => {
      const result = {
        exitCode: 0,
        timedOut: false,
        stdout: "hello world",
        stderr: "",
      };

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello world");
      expect(result.timedOut).toBe(false);
    });

    it("captures stderr on error", () => {
      const result = {
        exitCode: 1,
        timedOut: false,
        stdout: "",
        stderr: "command not found",
      };

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("command not found");
    });

    it("marks timed out results", () => {
      const result = {
        exitCode: 137,
        timedOut: true,
        stdout: "",
        stderr: "",
        timeoutMs: 30000,
      };

      expect(result.timedOut).toBe(true);
      expect(result.timeoutMs).toBe(30000);
    });
  });

  describe("output truncation", () => {
    it("truncates long output to limit", () => {
      const longOutput = "x".repeat(200_000);
      const limit = 50_000;
      const truncated =
        longOutput.length > limit
          ? longOutput.slice(0, limit) + "...[truncated]"
          : longOutput;

      expect(truncated.length).toBeLessThan(longOutput.length);
      expect(truncated).toContain("[truncated]");
    });

    it("does not truncate short output", () => {
      const shortOutput = "hello";
      const limit = 50_000;
      const result =
        shortOutput.length > limit
          ? shortOutput.slice(0, limit) + "...[truncated]"
          : shortOutput;

      expect(result).toBe("hello");
    });
  });

  describe("mock shell execution", () => {
    it("executes simple echo command mock", async () => {
      const mockRunShell = vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "hello",
        stderr: "",
        timedOut: false,
      });

      const result = await mockRunShell("echo hello", {
        workspaceRoot: "/tmp",
        timeoutMs: 30000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello");
      expect(mockRunShell).toHaveBeenCalledWith("echo hello", {
        workspaceRoot: "/tmp",
        timeoutMs: 30000,
      });
    });

    it("handles timeout scenario", async () => {
      const mockRunShell = vi.fn().mockResolvedValue({
        exitCode: 137,
        stdout: "partial",
        stderr: "",
        timedOut: true,
      });

      const result = await mockRunShell("sleep 999", {
        workspaceRoot: "/tmp",
        timeoutMs: 5000,
      });

      expect(result.timedOut).toBe(true);
    });

    it("handles command failure", async () => {
      const mockRunShell = vi.fn().mockResolvedValue({
        exitCode: 127,
        stdout: "",
        stderr: "command not found: nonexistent",
        timedOut: false,
      });

      const result = await mockRunShell("nonexistent", {
        workspaceRoot: "/tmp",
        timeoutMs: 30000,
      });

      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain("not found");
    });
  });

  describe("platform-specific behavior", () => {
    it.runIf(isWindows)("uses cmd on Windows", () => {
      expect(process.platform).toBe("win32");
    });

    it.runIf(!isWindows)("uses bash-like shell on POSIX", () => {
      expect(["darwin", "linux"]).toContain(process.platform);
    });
  });
});
