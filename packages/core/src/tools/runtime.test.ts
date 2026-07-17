import { describe, expect, it, vi } from "vitest";
import {
  ToolRuntime,
  isWorkspacePathEscapeError,
  toolResultFromExecutionError,
} from "./runtime.js";
import type { ToolSpec } from "@step-cli/protocol";

function spec(
  name: string,
  options: {
    risk?: "meta" | "read" | "write" | "execute";
    parse?: (raw: string) => unknown;
    execute?: ToolSpec["execute"];
    supportsParallel?: boolean;
  } = {},
): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description: `${name} description`,
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    },
    security: { risk: options.risk ?? "read", defaultMode: "allow" },
    parseArgs: options.parse ?? ((raw) => JSON.parse(raw)),
    execute:
      options.execute ?? vi.fn(async () => ({ ok: true, summary: name })),
    supportsParallel: options.supportsParallel,
  } as ToolSpec;
}

const context = {
  workspaceRoot: "/workspace",
  commandTimeoutMs: 1_000,
  commandOutputLimit: 1_000,
};

describe("ToolRuntime", () => {
  it("returns defensive catalog data, searches tools, and rejects duplicates", () => {
    const read = spec("Read");
    const runtime = new ToolRuntime([read], context);
    expect(runtime.listToolNames()).toEqual(["Read"]);
    expect(runtime.searchTools("read")[0]?.tool.name).toBe("Read");
    const definitions = runtime.getDefinitions();
    definitions[0]!.function.name = "changed";
    expect(runtime.getDefinitions()[0]!.function.name).toBe("Read");
    expect(() => new ToolRuntime([read, read], context)).toThrow(
      "Duplicate tool definition",
    );
  });

  it("normalizes unknown tools, invalid arguments, thrown errors, and path escapes", async () => {
    const bad = spec("Bad", {
      parse: () => {
        throw new Error("bad args");
      },
    });
    const throwing = spec("Throw", {
      execute: async () => {
        throw new Error("boom");
      },
    });
    const runtime = new ToolRuntime([bad, throwing], context);
    await expect(runtime.executeTool("unknown", "{}")).resolves.toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_TOOL" },
    });
    await expect(runtime.executeTool("Bad", "{}")).resolves.toMatchObject({
      error: { code: "INVALID_ARGUMENTS" },
    });
    await expect(runtime.executeTool("Throw", "{}")).resolves.toMatchObject({
      error: { code: "TOOL_EXECUTION_FAILED" },
    });
    const error = new Error("Path escapes workspace root: /etc/passwd");
    expect(isWorkspacePathEscapeError(error)).toBe(true);
    expect(toolResultFromExecutionError("Read", error)).toMatchObject({
      error: { code: "PATH_ESCAPES_WORKSPACE_ROOT" },
    });
  });

  it("enforces deny and confirmation decisions and caches allow-always", async () => {
    const execute = vi.fn(async () => ({ ok: true, summary: "ran" }));
    const policy = {
      evaluate: vi.fn(() => ({
        mode: "confirm",
        reason: "review",
        risk: "write",
      })),
    };
    const approval = vi.fn().mockResolvedValue("allow-always");
    const runtime = new ToolRuntime(
      [spec("Write", { risk: "write", execute })],
      context,
      {
        permissionPolicy: policy as never,
        approvalHandler: approval,
      },
    );
    await expect(
      runtime.executeTool("Write", '{"value":"x"}'),
    ).resolves.toMatchObject({ ok: true });
    await runtime.executeTool("Write", '{"value":"x"}');
    expect(approval).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(runtime.exportState().approvedFingerprints).toHaveLength(1);

    const denied = new ToolRuntime([spec("No")], context, {
      permissionPolicy: {
        evaluate: () => ({ mode: "deny", reason: "no", risk: "read" }),
      } as never,
    });
    await expect(denied.executeTool("No", "{}")).resolves.toMatchObject({
      error: { code: "PERMISSION_DENIED" },
    });
  });

  it("runs nested hooks, converts workspace escapes, and restores approvals", async () => {
    const before = vi.fn();
    const after = vi.fn();
    const runtime = new ToolRuntime([spec("Read")], context, {
      beforeNestedToolExecution: before,
      afterNestedToolExecution: after,
    });
    await runtime.executeNestedTool("Read", "{}");
    expect(before).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "Read" }),
    );
    expect(after).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "Read",
        result: { ok: true, summary: "Read" },
      }),
    );
    runtime.loadState({ approvedFingerprints: ["one", "two"] });
    expect(runtime.exportState().approvedFingerprints).toEqual(["one", "two"]);
    runtime.loadState({ approvedFingerprints: "bad" });
    expect(runtime.exportState().approvedFingerprints).toEqual(["one", "two"]);
  });

  it("serializes writers while allowing read-capable tools to run", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const write = spec("Write", {
      risk: "write",
      execute: async () => {
        order.push("write-start");
        await first;
        order.push("write-end");
        return { ok: true, summary: "write" };
      },
    });
    const read = spec("Read", {
      supportsParallel: true,
      execute: async () => {
        order.push("read");
        return { ok: true, summary: "read" };
      },
    });
    const runtime = new ToolRuntime([write, read], context);
    const writing = runtime.executeTool("Write", "{}");
    await vi.waitFor(() => expect(order).toEqual(["write-start"]));
    const reading = runtime.executeTool("Read", "{}");
    await Promise.resolve();
    expect(order).toEqual(["write-start"]);
    releaseFirst();
    await Promise.all([writing, reading]);
    expect(order).toEqual(["write-start", "write-end", "read"]);
  });
});
