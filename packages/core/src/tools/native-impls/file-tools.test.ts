import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildEditTool, buildReadTool, buildWriteTool } from "./file-tools.js";

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "step-core-file-"));
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

const context = () => ({
  workspaceRoot,
  commandTimeoutMs: 1_000,
  commandOutputLimit: 10_000,
});

describe("core file tools", () => {
  it("exposes typed definitions and rejects malformed arguments", async () => {
    const read = buildReadTool();
    expect(read.definition.function.name).toBe("Read");
    expect(() => read.parseArgs("{}")).toThrow(
      'Read: required string field "file_path" is missing',
    );
    expect(() => buildWriteTool().parseArgs('{"file_path":"x"}')).toThrow(
      'Write: required string field "content" is missing',
    );
  });

  it("writes nested files and reads a one-based line slice", async () => {
    const write = buildWriteTool();
    const read = buildReadTool();
    const writeResult = await write.execute(
      write.parseArgs(
        '{"file_path":"nested/a.txt","content":"one\\ntwo\\nthree"}',
      ),
      context(),
      undefined as never,
    );
    expect(writeResult).toMatchObject({ ok: true });
    expect(
      await fs.readFile(path.join(workspaceRoot, "nested/a.txt"), "utf8"),
    ).toBe("one\ntwo\nthree");

    const result = await read.execute(
      read.parseArgs('{"file_path":"nested/a.txt","offset":2,"limit":1}'),
      context(),
      undefined as never,
    );
    expect(result).toEqual({ ok: true, summary: "2\ttwo" });
  });

  it("reports read failures and directory targets", async () => {
    const read = buildReadTool();
    const missing = await read.execute(
      read.parseArgs('{"file_path":"missing.txt"}'),
      context(),
      undefined as never,
    );
    expect(missing).toMatchObject({ ok: false, error: { code: "ENOENT" } });

    await fs.mkdir(path.join(workspaceRoot, "dir"));
    const directory = await read.execute(
      read.parseArgs('{"file_path":"dir"}'),
      context(),
      undefined as never,
    );
    expect(directory).toMatchObject({
      ok: false,
      error: { code: "IS_DIRECTORY" },
    });
  });

  it("edits a unique occurrence and handles no-match, ambiguity, and replace-all", async () => {
    const edit = buildEditTool();
    await fs.writeFile(
      path.join(workspaceRoot, "edit.txt"),
      "a\nb\na\n",
      "utf8",
    );

    const ambiguous = await edit.execute(
      edit.parseArgs(
        '{"file_path":"edit.txt","old_string":"a","new_string":"z"}',
      ),
      context(),
      undefined as never,
    );
    expect(ambiguous).toMatchObject({
      ok: false,
      error: { code: "AMBIGUOUS_MATCH" },
    });

    const all = await edit.execute(
      edit.parseArgs(
        '{"file_path":"edit.txt","old_string":"a","new_string":"z","replace_all":true}',
      ),
      context(),
      undefined as never,
    );
    expect(all).toMatchObject({ ok: true });
    expect(
      await fs.readFile(path.join(workspaceRoot, "edit.txt"), "utf8"),
    ).toBe("z\nb\nz\n");

    const noMatch = await edit.execute(
      edit.parseArgs(
        '{"file_path":"edit.txt","old_string":"missing","new_string":"x"}',
      ),
      context(),
      undefined as never,
    );
    expect(noMatch).toMatchObject({ ok: false, error: { code: "NO_MATCH" } });
  });

  it.skipIf(process.platform === "win32")(
    "rejects Windows drive paths on POSIX hosts",
    async () => {
      const result = await buildReadTool().execute(
        buildReadTool().parseArgs('{"file_path":"C:\\\\temp\\\\file.txt"}'),
        context(),
        undefined as never,
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: "INVALID_PATH" },
      });
    },
  );
});
