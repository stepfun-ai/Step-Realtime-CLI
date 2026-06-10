import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCommandInvocation,
  resolvePnpmCommand,
} from "../scripts/package-manager-command.mjs";

describe("resolvePnpmCommand", () => {
  it("uses pnpm.cmd when launched directly on Windows", () => {
    assert.deepEqual(resolvePnpmCommand({}, "win32"), {
      command: "pnpm.cmd",
      prefixArgs: [],
    });
  });

  it("uses pnpm on non-Windows platforms", () => {
    assert.deepEqual(resolvePnpmCommand({}, "darwin"), {
      command: "pnpm",
      prefixArgs: [],
    });
  });

  it("uses npm_execpath when running inside a package manager lifecycle", () => {
    const resolved = resolvePnpmCommand(
      { npm_execpath: "C:\\Users\\runner\\pnpm.cjs" },
      "win32",
    );

    assert.equal(resolved.command, process.execPath);
    assert.deepEqual(resolved.prefixArgs, ["C:\\Users\\runner\\pnpm.cjs"]);
  });

  it("wraps Windows command shims with cmd.exe", () => {
    assert.deepEqual(
      resolveCommandInvocation(
        "pnpm.cmd",
        ["--filter", "@step-cli/core", "run", "build"],
        "win32",
        {},
      ),
      {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", "pnpm.cmd --filter @step-cli/core run build"],
      },
    );
    assert.deepEqual(resolveCommandInvocation("tool.bat", [], "win32", {}), {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "tool.bat"],
    });
  });

  it("does not wrap normal executables", () => {
    assert.deepEqual(
      resolveCommandInvocation("node.exe", ["--version"], "win32"),
      {
        command: "node.exe",
        args: ["--version"],
      },
    );
    assert.deepEqual(
      resolveCommandInvocation("pnpm", ["--version"], "darwin"),
      {
        command: "pnpm",
        args: ["--version"],
      },
    );
  });
});
