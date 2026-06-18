import { describe, it, expect } from "vitest";
import type { ToolSpec } from "@step-cli/protocol";
import { buildGroupedToolSpecs } from "./grouped-surface.js";

function makeSpec(name: string, grouping?: ToolSpec["grouping"]): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description: `Tool ${name}`,
        parameters: { type: "object", properties: {} },
      },
    },
    security: { risk: "read" },
    grouping,
    parseArgs: () => ({}),
    execute: async () => ({ ok: true, summary: "ok" }),
  } as ToolSpec;
}

function makeRichSpec(
  name: string,
  opts: {
    grouping?: ToolSpec["grouping"];
    risk?: ToolSpec["security"]["risk"];
    properties?: Record<string, unknown>;
    parseArgs?: ToolSpec["parseArgs"];
    execute?: ToolSpec["execute"];
    inspect?: ToolSpec["inspect"];
  } = {},
): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description: `Tool ${name}`,
        parameters: {
          type: "object",
          properties: opts.properties ?? {},
        },
      },
    },
    security: { risk: opts.risk ?? "read" },
    grouping: opts.grouping,
    parseArgs: opts.parseArgs ?? ((raw: string) => JSON.parse(raw)),
    execute: opts.execute ?? (async () => ({ ok: true, summary: "ok" })),
    inspect: opts.inspect,
  } as ToolSpec;
}

describe("buildGroupedToolSpecs", () => {
  it("returns ungrouped specs unchanged", () => {
    const specs = [makeSpec("Read"), makeSpec("Write")];
    const result = buildGroupedToolSpecs(specs);
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.definition.function.name)).toEqual([
      "Read",
      "Write",
    ]);
  });

  it("groups specs sharing the same family into one wrapper", () => {
    const specs = [
      makeSpec("file_read", {
        family: "file",
        action: "read",
        summary: "File operations",
      }),
      makeSpec("file_write", {
        family: "file",
        action: "write",
        summary: "File operations",
      }),
      makeSpec("Bash"),
    ];

    const result = buildGroupedToolSpecs(specs);
    const names = result.map((s) => s.definition.function.name);
    expect(names).toContain("file");
    expect(names).toContain("Bash");
    expect(result.length).toBeLessThan(specs.length);
  });

  it("skips grouping when family name collides with existing tool", () => {
    const specs = [
      makeSpec("file"),
      makeSpec("file_read", {
        family: "file",
        action: "read",
        summary: "File ops",
      }),
    ];

    const result = buildGroupedToolSpecs(specs);
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.definition.function.name)).toContain("file");
    expect(result.map((s) => s.definition.function.name)).toContain(
      "file_read",
    );
  });

  it("handles empty input", () => {
    expect(buildGroupedToolSpecs([])).toEqual([]);
  });

  it("builds a wrapper whose parameters union child properties plus action enum", () => {
    const specs = [
      makeRichSpec("file_read", {
        grouping: { family: "file", action: "read", summary: "File ops." },
        properties: { path: { type: "string" } },
      }),
      makeRichSpec("file_write", {
        grouping: { family: "file", action: "write", summary: "File ops." },
        properties: { path: { type: "string" }, content: { type: "string" } },
      }),
    ];

    const [wrapper] = buildGroupedToolSpecs(specs);
    const params = wrapper!.definition.function.parameters;
    expect(params.required).toEqual(["action"]);
    expect(params.additionalProperties).toBe(false);
    expect(Object.keys(params.properties ?? {}).sort()).toEqual([
      "action",
      "content",
      "path",
    ]);
    expect((params.properties!.action as { enum: string[] }).enum).toEqual([
      "read",
      "write",
    ]);
    expect(wrapper!.definition.function.description).toContain(
      "Available actions: read, write",
    );
  });

  it("applies property overrides from the grouping descriptor", () => {
    const override = { type: "string", description: "custom path" };
    const specs = [
      makeRichSpec("file_read", {
        grouping: {
          family: "file",
          action: "read",
          summary: "File ops.",
          propertyOverrides: { path: override as never },
        },
        properties: { path: { type: "number" } },
      }),
    ];

    const [wrapper] = buildGroupedToolSpecs(specs);
    expect(wrapper!.definition.function.parameters.properties!.path).toEqual(
      override,
    );
  });

  it("parseArgs resolves actions (including aliases) and forwards child args", () => {
    let received: unknown;
    const specs = [
      makeRichSpec("file_read", {
        grouping: {
          family: "file",
          action: "read",
          summary: "File ops.",
          aliases: ["open"],
        },
        properties: { path: { type: "string" } },
        parseArgs: (raw: string) => {
          received = JSON.parse(raw);
          return { parsed: true };
        },
      }),
    ];

    const [wrapper] = buildGroupedToolSpecs(specs);
    const parsed = wrapper!.parseArgs(
      JSON.stringify({ action: "open", path: "/a.txt" }),
    ) as { action: string; toolName: string; childArgs: unknown };

    expect(parsed.action).toBe("read");
    expect(parsed.toolName).toBe("file_read");
    expect(parsed.childArgs).toEqual({ parsed: true });
    // action stripped before forwarding to the child parser
    expect(received).toEqual({ path: "/a.txt" });
  });

  it("parseArgs throws for an unknown action", () => {
    const specs = [
      makeRichSpec("file_read", {
        grouping: { family: "file", action: "read", summary: "File ops." },
      }),
    ];
    const [wrapper] = buildGroupedToolSpecs(specs);
    expect(() =>
      wrapper!.parseArgs(JSON.stringify({ action: "delete" })),
    ).toThrow(/action must be one of: read/);
  });

  it("execute dispatches to the matching child spec", async () => {
    const calls: unknown[] = [];
    const specs = [
      makeRichSpec("file_read", {
        grouping: { family: "file", action: "read", summary: "File ops." },
        execute: async (args: unknown) => {
          calls.push(args);
          return { ok: true, summary: "read done" };
        },
      }),
    ];
    const [wrapper] = buildGroupedToolSpecs(specs);
    const result = await wrapper!.execute(
      { action: "read", toolName: "file_read", childArgs: { x: 1 } } as never,
      {} as never,
      {} as never,
    );
    expect(result).toEqual({ ok: true, summary: "read done" });
    expect(calls[0]).toEqual({ x: 1 });
  });

  it("execute throws when the grouped action target is unknown", async () => {
    const specs = [
      makeRichSpec("file_read", {
        grouping: { family: "file", action: "read", summary: "File ops." },
      }),
    ];
    const [wrapper] = buildGroupedToolSpecs(specs);
    await expect(
      wrapper!.execute(
        { action: "read", toolName: "missing", childArgs: {} } as never,
        {} as never,
        {} as never,
      ),
    ).rejects.toThrow(/Unknown grouped action target: missing/);
  });

  it("inspect delegates to child inspect, returns undefined when absent", () => {
    const withInspect = makeRichSpec("file_read", {
      grouping: { family: "file", action: "read", summary: "File ops." },
      inspect: ({ args }: { args: unknown }) =>
        ({ title: `inspect ${JSON.stringify(args)}` }) as never,
    });
    const withoutInspect = makeRichSpec("file_write", {
      grouping: { family: "file", action: "write", summary: "File ops." },
    });

    const [wrapper] = buildGroupedToolSpecs([withInspect, withoutInspect]);
    const inspected = wrapper!.inspect!({
      args: { action: "read", toolName: "file_read", childArgs: { y: 2 } },
      rawArgs: "{}",
      result: undefined,
    } as never);
    expect(inspected).toEqual({ title: 'inspect {"y":2}' });

    const none = wrapper!.inspect!({
      args: { action: "write", toolName: "file_write", childArgs: {} },
      rawArgs: "{}",
      result: undefined,
    } as never);
    expect(none).toBeUndefined();
  });

  it("picks the highest child risk when family has no explicit risk", () => {
    const specs = [
      makeRichSpec("file_read", {
        grouping: { family: "file", action: "read", summary: "File ops." },
        risk: "read",
      }),
      makeRichSpec("file_run", {
        grouping: { family: "file", action: "run", summary: "File ops." },
        risk: "execute",
      }),
    ];
    const [wrapper] = buildGroupedToolSpecs(specs);
    expect(wrapper!.security.risk).toBe("execute");
  });

  it("honors explicit family security risk and default mode", () => {
    const specs = [
      makeRichSpec("file_read", {
        grouping: {
          family: "file",
          action: "read",
          summary: "File ops.",
          security: { risk: "write", defaultMode: "confirm" },
        },
        risk: "read",
      }),
    ];
    const [wrapper] = buildGroupedToolSpecs(specs);
    expect(wrapper!.security.risk).toBe("write");
    expect(wrapper!.security.defaultMode).toBe("confirm");
  });
});
