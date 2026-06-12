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
});
