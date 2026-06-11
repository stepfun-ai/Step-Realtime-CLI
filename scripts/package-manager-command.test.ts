import { describe, it, expect } from "vitest";
import {
  resolveCommandInvocation,
  resolvePnpmCommand,
} from "./package-manager-command.mjs";

describe("resolvePnpmCommand", () => {
  it("uses pnpm.cmd when launched directly on Windows", () => {
    expect(resolvePnpmCommand({}, "win32")).toEqual({
      command: "pnpm.cmd",
      prefixArgs: [],
    });
  });

  it("uses pnpm on non-Windows platforms", () => {
    expect(resolvePnpmCommand({}, "darwin")).toEqual({
      command: "pnpm",
      prefixArgs: [],
    });
  });

  it("uses npm_execpath when running inside a package manager lifecycle", () => {
    const resolved = resolvePnpmCommand(
      { npm_execpath: "C:\\Users\\runner\\pnpm.cjs" },
      "win32",
    );

    expect(resolved.command).toBe(process.execPath);
    expect(resolved.prefixArgs).toEqual(["C:\\Users\\runner\\pnpm.cjs"]);
  });

  it("wraps Windows command shims with cmd.exe", () => {
    expect(
      resolveCommandInvocation(
        "pnpm.cmd",
        ["--filter", "@step-cli/core", "run", "build"],
        "win32",
        {},
      ),
    ).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd --filter @step-cli/core run build"],
    });
    expect(resolveCommandInvocation("tool.bat", [], "win32", {})).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "tool.bat"],
    });
  });

  it("does not wrap normal executables", () => {
    expect(
      resolveCommandInvocation("node.exe", ["--version"], "win32"),
    ).toEqual({
      command: "node.exe",
      args: ["--version"],
    });
    expect(resolveCommandInvocation("pnpm", ["--version"], "darwin")).toEqual({
      command: "pnpm",
      args: ["--version"],
    });
  });
});
