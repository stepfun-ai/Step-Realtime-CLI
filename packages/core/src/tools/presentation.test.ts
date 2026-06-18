import { describe, it, expect } from "vitest";
import type { ToolSpec } from "@step-cli/protocol";
import {
  normalizeToolPresentationConfig,
  buildPresentedTools,
} from "./presentation.js";

function makeSpec(name: string): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description: `Description for ${name}`,
        parameters: {
          type: "object",
          properties: {
            input: { type: "string", description: "input value" },
          },
          required: ["input"],
        },
      },
    },
    security: { risk: "read" },
    parseArgs: (raw: string) => JSON.parse(raw),
    execute: async () => ({ ok: true, summary: "ok" }),
  } as ToolSpec;
}

function makeSpecWith(
  name: string,
  opts: {
    risk?: ToolSpec["security"]["risk"];
    properties?: Record<string, unknown>;
    description?: string;
  } = {},
): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description: opts.description ?? `Description for ${name}`,
        parameters: {
          type: "object",
          properties: opts.properties ?? {},
        },
      },
    },
    security: { risk: opts.risk ?? "read" },
    parseArgs: (raw: string) => JSON.parse(raw),
    execute: async () => ({ ok: true, summary: "ok" }),
  } as ToolSpec;
}

describe("normalizeToolPresentationConfig", () => {
  it("returns defaults for undefined input", () => {
    const config = normalizeToolPresentationConfig(undefined);
    expect(config.profile).toBe("grouped");
    expect(config.descriptionStyle).toBe("canonical");
    expect(config.searchIndex).toBe("presented");
  });

  it("preserves provided profile", () => {
    const config = normalizeToolPresentationConfig({ profile: "obfuscated" });
    expect(config.profile).toBe("obfuscated");
  });
});

describe("buildPresentedTools", () => {
  it("presents tools in canonical mode without aliasing", () => {
    const specs = [makeSpec("Read"), makeSpec("Write")];
    const presented = buildPresentedTools(specs, undefined);

    expect(presented).toHaveLength(2);
    expect(presented[0]!.internalName).toBe("Read");
    expect(presented[0]!.externalName).toBe("Read");
    expect(presented[1]!.internalName).toBe("Write");
  });

  it("generates alias names in obfuscated mode", () => {
    const specs = [makeSpec("Read"), makeSpec("Write"), makeSpec("Bash")];
    const presented = buildPresentedTools(specs, { profile: "obfuscated" });

    const externalNames = presented.map((p) => p.externalName);
    const internalNames = presented.map((p) => p.internalName);

    for (let i = 0; i < presented.length; i++) {
      if (internalNames[i] !== "exec" && internalNames[i] !== "wait") {
        expect(externalNames[i]).not.toBe(internalNames[i]);
      }
    }
  });

  it("builds catalog with risk and parameters", () => {
    const specs = [makeSpec("Read")];
    const presented = buildPresentedTools(specs, undefined);

    expect(presented[0]!.catalog.risk).toBe("read");
    expect(presented[0]!.catalog.parameterNames).toContain("input");
  });

  it("populates searchFields for each tool", () => {
    const specs = [makeSpec("Read")];
    const presented = buildPresentedTools(specs, undefined);

    expect(presented[0]!.searchFields.length).toBeGreaterThan(0);
    expect(
      presented[0]!.searchFields.some((f) => f.text.includes("Read")),
    ).toBe(true);
  });

  it("handles empty specs array", () => {
    expect(buildPresentedTools([], undefined)).toEqual([]);
  });
});

describe("normalizeToolPresentationConfig extras", () => {
  it("trims aliasSeed and drops blank values", () => {
    expect(
      normalizeToolPresentationConfig({ aliasSeed: "  seed-1  " }).aliasSeed,
    ).toBe("seed-1");
    expect(
      normalizeToolPresentationConfig({ aliasSeed: "   " }).aliasSeed,
    ).toBeUndefined();
  });

  it("preserves explicit descriptionStyle and searchIndex", () => {
    const config = normalizeToolPresentationConfig({
      descriptionStyle: "simple",
      searchIndex: "canonical",
    });
    expect(config.descriptionStyle).toBe("simple");
    expect(config.searchIndex).toBe("canonical");
  });

  it("maps legacy profile aliases", () => {
    expect(
      normalizeToolPresentationConfig({ profile: "compact" as never }).profile,
    ).toBe("grouped");
    expect(
      normalizeToolPresentationConfig({ profile: "canonical" as never })
        .profile,
    ).toBe("raw");
  });
});

describe("buildPresentedTools description styles", () => {
  it("renders simple descriptions with capitalized risk and inputs", () => {
    const specs = [
      makeSpecWith("Write", {
        risk: "write",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
      }),
    ];
    const presented = buildPresentedTools(specs, {
      descriptionStyle: "simple",
    });
    expect(presented[0]!.definition.function.description).toBe(
      "Write tool. Inputs: content, path.",
    );
    expect(presented[0]!.catalog.description).toBe(
      "Write tool. Inputs: content, path.",
    );
  });

  it("renders simple description without inputs when no parameters", () => {
    const specs = [makeSpecWith("Ping", { risk: "meta" })];
    const presented = buildPresentedTools(specs, {
      descriptionStyle: "simple",
    });
    expect(presented[0]!.definition.function.description).toBe("Meta tool.");
  });

  it("keeps canonical descriptions by default", () => {
    const specs = [makeSpecWith("Read", { description: "Read a file" })];
    const presented = buildPresentedTools(specs, undefined);
    expect(presented[0]!.definition.function.description).toBe("Read a file");
  });
});

describe("buildPresentedTools search index", () => {
  it("adds canonical fields when searchIndex is canonical", () => {
    const specs = [
      makeSpecWith("Read", {
        properties: { path: { type: "string" } },
      }),
    ];
    const presented = buildPresentedTools(specs, {
      profile: "obfuscated",
      searchIndex: "canonical",
    });
    const fields = presented[0]!.searchFields;
    // canonical index appends 3 extra fields (7 total vs 4 default)
    expect(fields).toHaveLength(7);
    // internal name appears even when external is an alias
    expect(fields.some((f) => f.text === "Read" && f.weight === 5)).toBe(true);
  });

  it("uses only presented fields by default", () => {
    const specs = [makeSpecWith("Read")];
    const presented = buildPresentedTools(specs, undefined);
    expect(presented[0]!.searchFields).toHaveLength(4);
  });
});

describe("buildPresentedTools obfuscation", () => {
  it("preserves reserved names exec and wait but aliases others", () => {
    const specs = [makeSpec("exec"), makeSpec("wait"), makeSpec("Read")];
    const presented = buildPresentedTools(specs, { profile: "obfuscated" });
    const byInternal = new Map(presented.map((p) => [p.internalName, p]));
    expect(byInternal.get("exec")!.externalName).toBe("exec");
    expect(byInternal.get("wait")!.externalName).toBe("wait");
    const readAlias = byInternal.get("Read")!.externalName;
    expect(readAlias).not.toBe("Read");
    expect(readAlias).toMatch(/^A[0-9A-F]{6}$/);
  });

  it("produces deterministic aliases for the same seed", () => {
    const specsA = [makeSpec("Read"), makeSpec("Write")];
    const specsB = [makeSpec("Read"), makeSpec("Write")];
    const a = buildPresentedTools(specsA, {
      profile: "obfuscated",
      aliasSeed: "fixed",
    });
    const b = buildPresentedTools(specsB, {
      profile: "obfuscated",
      aliasSeed: "fixed",
    });
    expect(a.map((p) => p.externalName)).toEqual(b.map((p) => p.externalName));
  });

  it("produces unique aliases across many tools", () => {
    const specs = Array.from({ length: 20 }, (_, i) => makeSpec(`Tool${i}`));
    const presented = buildPresentedTools(specs, { profile: "obfuscated" });
    const aliases = presented.map((p) => p.externalName);
    expect(new Set(aliases).size).toBe(aliases.length);
  });
});
