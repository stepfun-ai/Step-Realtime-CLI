import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildBashTool, buildGlobTool, buildGrepTool } from "./shell-tools.js";

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "step-core-shell-"));
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const context = () => ({
  workspaceRoot,
  commandTimeoutMs: 1_000,
  commandOutputLimit: 10_000,
});

describe("core shell tools", () => {
  it("parses tool arguments and executes a successful Bash command", async () => {
    const bash = buildBashTool();
    expect(bash.definition.function.name).toBe("Bash");
    expect(() => bash.parseArgs("{}")).toThrow();
    const result = await bash.execute(
      bash.parseArgs(
        process.platform === "win32"
          ? '{"command":"echo hello"}'
          : '{"command":"printf hello"}',
      ),
      context(),
      undefined as never,
    );
    expect(result).toEqual({ ok: true, summary: "hello" });
  });

  it("maps Bash timeout, interruption, and non-zero exits to tool errors", async () => {
    const bash = buildBashTool();
    const timeout = await bash.execute(
      bash.parseArgs(
        process.platform === "win32"
          ? '{"command":"ping -n 3 127.0.0.1","timeout":1}'
          : '{"command":"sleep 1","timeout":1}',
      ),
      context(),
      undefined as never,
    );
    expect(timeout).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });

    const ac = new AbortController();
    ac.abort();
    const interrupted = await bash.execute(
      bash.parseArgs(
        process.platform === "win32"
          ? '{"command":"echo x"}'
          : '{"command":"echo x"}',
      ),
      { ...context(), signal: ac.signal },
      undefined as never,
    );
    expect(interrupted).toMatchObject({
      ok: false,
      error: { code: "INTERRUPTED" },
    });

    const failed = await bash.execute(
      bash.parseArgs(
        process.platform === "win32"
          ? '{"command":"cmd /c exit 7"}'
          : '{"command":"sh -c \'exit 7\'"}',
      ),
      context(),
      undefined as never,
    );
    expect(failed).toMatchObject({
      ok: false,
      error: { code: "NONZERO_EXIT" },
    });
  });

  it("globs files recursively while skipping generated directories", async () => {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "node_modules", "pkg"), {
      recursive: true,
    });
    await fs.writeFile(path.join(workspaceRoot, "src", "a.ts"), "x");
    await fs.writeFile(
      path.join(workspaceRoot, "node_modules", "pkg", "skip.ts"),
      "x",
    );

    const glob = buildGlobTool();
    const result = await glob.execute(
      glob.parseArgs('{"pattern":"**/*.ts"}'),
      context(),
      undefined as never,
    );
    expect(result).toMatchObject({ ok: true });
    expect(result.summary).toContain(path.join(workspaceRoot, "src", "a.ts"));
    expect(result.summary).not.toContain("skip.ts");
  });

  it("greps matching files and returns no-match output", async () => {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "src", "a.ts"),
      "const needle = 1;\n",
    );
    const grep = buildGrepTool();
    const found = await grep.execute(
      grep.parseArgs('{"pattern":"needle","include":"*.ts"}'),
      context(),
      undefined as never,
    );
    expect(found).toMatchObject({ ok: true });
    expect(found.summary).toContain("needle");
    const missing = await grep.execute(
      grep.parseArgs('{"pattern":"absent"}'),
      context(),
      undefined as never,
    );
    expect(missing).toEqual({ ok: true, summary: "" });
  });
});
