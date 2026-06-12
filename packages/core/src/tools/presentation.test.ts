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
