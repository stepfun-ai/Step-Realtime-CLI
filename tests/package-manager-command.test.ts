import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePnpmCommand } from "../scripts/package-manager-command.mjs";

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
});
