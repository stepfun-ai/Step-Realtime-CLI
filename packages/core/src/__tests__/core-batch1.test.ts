import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// args.ts
// ---------------------------------------------------------------------------
import {
  parseJsonObject,
  readStringField,
  readRequiredStringField,
  readIntegerField,
  readBooleanField,
  readObjectField,
} from "../tools/args.js";

// ---------------------------------------------------------------------------
// presentation-profile.ts
// ---------------------------------------------------------------------------
import {
  parseToolPresentationProfile,
  normalizeToolPresentationProfile,
  describeToolPresentationProfileOptions,
  describeToolPresentationProfileInputs,
} from "../tools/presentation-profile.js";

// ---------------------------------------------------------------------------
// security.ts
// ---------------------------------------------------------------------------
import {
  getToolSecurityIssue,
  validateToolSecurity,
} from "../tools/security.js";

// ---------------------------------------------------------------------------
// agent-presets.ts
// ---------------------------------------------------------------------------
import {
  createAgentPresetRegistry,
  resolveAgentPreset,
  applyAgentPresetPromptAppendix,
  applyAgentPresetAllowedTools,
} from "../agent/agent-presets.js";

// ---------------------------------------------------------------------------
// harness-context.ts
// ---------------------------------------------------------------------------
import {
  resolveExecutionProfile,
  cloneExecutionProfile,
  isExecutionProfile,
  persistExecutionProfile,
  formatExecutionProfile,
  formatExecutionProfileForHarness,
  runWithHarnessContext,
  getHarnessContext,
} from "../agent/harness-context.js";
import type {
  AgentExecutionProfile,
  AgentHarnessKind,
} from "../runtime-context-types.js";

// ====================================================================
// args.ts
// ====================================================================
describe("args", () => {
  // -- parseJsonObject ---------------------------------------------------
  describe("parseJsonObject", () => {
    it("returns a parsed valid JSON object", () => {
      const result = parseJsonObject('{"foo":1,"bar":"baz"}');
      expect(result).toEqual({ foo: 1, bar: "baz" });
    });

    it("throws when the input is a JSON array", () => {
      expect(() => parseJsonObject("[1,2,3]")).toThrow(
        "Tool arguments must be a JSON object",
      );
    });

    it("throws when the input is a JSON primitive", () => {
      expect(() => parseJsonObject("42")).toThrow(
        "Tool arguments must be a JSON object",
      );
    });

    it("throws when the input is a JSON string primitive", () => {
      expect(() => parseJsonObject('"hello"')).toThrow(
        "Tool arguments must be a JSON object",
      );
    });

    it("throws for malformed JSON and includes the raw string in the message", () => {
      const raw = "{not valid json!!!";
      expect(() => parseJsonObject(raw)).toThrow(
        `Tool arguments must be a JSON object: ${raw}`,
      );
    });

    it("throws for the JSON literal null", () => {
      expect(() => parseJsonObject("null")).toThrow(
        "Tool arguments must be a JSON object",
      );
    });
  });

  // -- readStringField ---------------------------------------------------
  describe("readStringField", () => {
    it("returns the string value when input is a string", () => {
      expect(readStringField("hello")).toBe("hello");
    });

    it("returns undefined for a number", () => {
      expect(readStringField(42)).toBeUndefined();
    });

    it("returns undefined for undefined", () => {
      expect(readStringField(undefined)).toBeUndefined();
    });

    it("returns undefined for null", () => {
      expect(readStringField(null)).toBeUndefined();
    });

    it("returns undefined for a boolean", () => {
      expect(readStringField(true)).toBeUndefined();
    });
  });

  // -- readRequiredStringField -------------------------------------------
  describe("readRequiredStringField", () => {
    it("returns the string value when input is a string", () => {
      expect(readRequiredStringField("value", "myField")).toBe("value");
    });

    it("throws when input is a number, including the field name", () => {
      expect(() => readRequiredStringField(42, "myField")).toThrow(
        "myField must be a string",
      );
    });

    it("throws when input is null, including the field name", () => {
      expect(() => readRequiredStringField(null, "anotherField")).toThrow(
        "anotherField must be a string",
      );
    });

    it("throws when input is undefined", () => {
      expect(() => readRequiredStringField(undefined, "f")).toThrow(
        "f must be a string",
      );
    });
  });

  // -- readIntegerField --------------------------------------------------
  describe("readIntegerField", () => {
    it("returns the integer value when input is an integer", () => {
      expect(readIntegerField(7, "count")).toBe(7);
    });

    it("returns undefined when input is undefined", () => {
      expect(readIntegerField(undefined, "count")).toBeUndefined();
    });

    it("throws when input is a float", () => {
      expect(() => readIntegerField(3.14, "count")).toThrow(
        "count must be an integer",
      );
    });

    it("throws when input is a string", () => {
      expect(() => readIntegerField("5", "count")).toThrow(
        "count must be an integer",
      );
    });

    it("throws when input is null", () => {
      expect(() => readIntegerField(null, "count")).toThrow(
        "count must be an integer",
      );
    });

    it("accepts zero as a valid integer", () => {
      expect(readIntegerField(0, "count")).toBe(0);
    });

    it("accepts negative integers", () => {
      expect(readIntegerField(-10, "count")).toBe(-10);
    });
  });

  // -- readBooleanField --------------------------------------------------
  describe("readBooleanField", () => {
    it("returns true when input is true", () => {
      expect(readBooleanField(true, "flag")).toBe(true);
    });

    it("returns false when input is false", () => {
      expect(readBooleanField(false, "flag")).toBe(false);
    });

    it("returns undefined when input is undefined", () => {
      expect(readBooleanField(undefined, "flag")).toBeUndefined();
    });

    it("throws for a truthy non-boolean (string)", () => {
      expect(() => readBooleanField("true", "flag")).toThrow(
        "flag must be a boolean",
      );
    });

    it("throws for a truthy non-boolean (number 1)", () => {
      expect(() => readBooleanField(1, "flag")).toThrow(
        "flag must be a boolean",
      );
    });

    it("throws for a falsy non-boolean (empty string)", () => {
      expect(() => readBooleanField("", "flag")).toThrow(
        "flag must be a boolean",
      );
    });

    it("throws for a falsy non-boolean (number 0)", () => {
      expect(() => readBooleanField(0, "flag")).toThrow(
        "flag must be a boolean",
      );
    });

    it("throws for null", () => {
      expect(() => readBooleanField(null, "flag")).toThrow(
        "flag must be a boolean",
      );
    });
  });

  // -- readObjectField ---------------------------------------------------
  describe("readObjectField", () => {
    it("returns a plain object", () => {
      const obj = { a: 1, b: "two" };
      expect(readObjectField(obj, "data")).toBe(obj);
    });

    it("returns undefined when input is undefined", () => {
      expect(readObjectField(undefined, "data")).toBeUndefined();
    });

    it("throws when input is an array", () => {
      expect(() => readObjectField([1, 2], "data")).toThrow(
        "data must be an object",
      );
    });

    it("throws when input is null", () => {
      expect(() => readObjectField(null, "data")).toThrow(
        "data must be an object",
      );
    });

    it("throws when input is a string", () => {
      expect(() => readObjectField("hello", "data")).toThrow(
        "data must be an object",
      );
    });
  });
});

// ====================================================================
// presentation-profile.ts
// ====================================================================
describe("presentation-profile", () => {
  // -- parseToolPresentationProfile --------------------------------------
  describe("parseToolPresentationProfile", () => {
    it('maps "grouped" to "grouped"', () => {
      expect(parseToolPresentationProfile("grouped")).toBe("grouped");
    });

    it('maps "compact" to "grouped" (legacy alias)', () => {
      expect(parseToolPresentationProfile("compact")).toBe("grouped");
    });

    it('maps "raw" to "raw"', () => {
      expect(parseToolPresentationProfile("raw")).toBe("raw");
    });

    it('maps "canonical" to "raw" (legacy alias)', () => {
      expect(parseToolPresentationProfile("canonical")).toBe("raw");
    });

    it('maps "obfuscated" to "obfuscated"', () => {
      expect(parseToolPresentationProfile("obfuscated")).toBe("obfuscated");
    });

    it("returns undefined for null", () => {
      expect(parseToolPresentationProfile(null)).toBeUndefined();
    });

    it("returns undefined for undefined", () => {
      expect(parseToolPresentationProfile(undefined)).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      expect(parseToolPresentationProfile("")).toBeUndefined();
    });

    it("returns undefined for unknown value", () => {
      expect(parseToolPresentationProfile("fancy")).toBeUndefined();
    });
  });

  // -- normalizeToolPresentationProfile ----------------------------------
  describe("normalizeToolPresentationProfile", () => {
    it("passes through parseable values", () => {
      expect(normalizeToolPresentationProfile("grouped")).toBe("grouped");
      expect(normalizeToolPresentationProfile("raw")).toBe("raw");
      expect(normalizeToolPresentationProfile("obfuscated")).toBe("obfuscated");
      expect(normalizeToolPresentationProfile("compact")).toBe("grouped");
      expect(normalizeToolPresentationProfile("canonical")).toBe("raw");
    });

    it('defaults null to "grouped"', () => {
      expect(normalizeToolPresentationProfile(null)).toBe("grouped");
    });

    it('defaults undefined to "grouped"', () => {
      expect(normalizeToolPresentationProfile(undefined)).toBe("grouped");
    });

    it('defaults empty string to "grouped"', () => {
      expect(normalizeToolPresentationProfile("")).toBe("grouped");
    });

    it('defaults unknown values to "grouped"', () => {
      expect(normalizeToolPresentationProfile("unknown")).toBe("grouped");
    });
  });

  // -- describeToolPresentationProfileOptions ----------------------------
  describe("describeToolPresentationProfileOptions", () => {
    it('returns "grouped, raw, or obfuscated"', () => {
      expect(describeToolPresentationProfileOptions()).toBe(
        "grouped, raw, or obfuscated",
      );
    });
  });

  // -- describeToolPresentationProfileInputs -----------------------------
  describe("describeToolPresentationProfileInputs", () => {
    it("returns a string that includes legacy aliases", () => {
      const result = describeToolPresentationProfileInputs();
      expect(result).toContain("compact");
      expect(result).toContain("canonical");
      expect(result).toContain("grouped");
      expect(result).toContain("raw");
      expect(result).toContain("obfuscated");
    });
  });
});

// ====================================================================
// security.ts
// ====================================================================
describe("security", () => {
  // -- getToolSecurityIssue ----------------------------------------------
  describe("getToolSecurityIssue", () => {
    it("returns an issue when security is missing (undefined)", () => {
      const result = getToolSecurityIssue({
        definition: { function: { name: "myTool" } } as any,
        security: undefined,
      });
      expect(result).toMatch(/myTool/);
      expect(result).toContain("missing required security metadata");
    });

    it("returns an issue when security is null", () => {
      const result = getToolSecurityIssue({
        definition: { function: { name: "myTool" } } as any,
        security: null,
      });
      expect(result).toMatch(/myTool/);
      expect(result).toContain("missing required security metadata");
    });

    it("returns an issue when security is an array", () => {
      const result = getToolSecurityIssue({
        definition: { function: { name: "myTool" } } as any,
        security: [{ risk: "read" }],
      });
      expect(result).toContain("missing required security metadata");
    });

    it("returns null for valid security with a valid risk", () => {
      const result = getToolSecurityIssue({
        definition: { function: { name: "myTool" } } as any,
        security: { risk: "read" },
      });
      expect(result).toBeNull();
    });

    it("returns null for valid security with risk and valid defaultMode", () => {
      const result = getToolSecurityIssue({
        definition: { function: { name: "myTool" } } as any,
        security: { risk: "write", defaultMode: "confirm" },
      });
      expect(result).toBeNull();
    });

    it("returns an issue for an invalid risk value", () => {
      const result = getToolSecurityIssue({
        definition: { function: { name: "riskTool" } } as any,
        security: { risk: "invalid" },
      });
      expect(result).toContain("invalid security risk");
      expect(result).toMatch(/riskTool/);
    });

    it("returns an issue for valid risk with invalid defaultMode", () => {
      const result = getToolSecurityIssue({
        definition: { function: { name: "modeTool" } } as any,
        security: { risk: "read", defaultMode: "auto" },
      });
      expect(result).toContain("invalid default security mode");
      expect(result).toMatch(/modeTool/);
    });

    it("includes the tool name in the error message for missing security", () => {
      const result = getToolSecurityIssue({
        definition: { function: { name: "specificTool" } } as any,
      });
      expect(result).toMatch(/specificTool/);
    });

    it("uses <unknown> when definition is not provided", () => {
      const result = getToolSecurityIssue({ security: null });
      expect(result).toContain("<unknown>");
    });

    it("accepts all valid risk levels", () => {
      for (const risk of ["meta", "read", "write", "execute"]) {
        expect(
          getToolSecurityIssue({
            definition: { function: { name: "t" } } as any,
            security: { risk },
          }),
        ).toBeNull();
      }
    });

    it("accepts all valid defaultModes", () => {
      for (const mode of ["allow", "confirm", "deny"]) {
        expect(
          getToolSecurityIssue({
            definition: { function: { name: "t" } } as any,
            security: { risk: "read", defaultMode: mode },
          }),
        ).toBeNull();
      }
    });
  });

  // -- validateToolSecurity ----------------------------------------------
  describe("validateToolSecurity", () => {
    it("does not throw for a valid spec", () => {
      expect(() =>
        validateToolSecurity({
          definition: { function: { name: "okTool" } },
          security: { risk: "read" },
        } as any),
      ).not.toThrow();
    });

    it("throws for an invalid spec", () => {
      expect(() =>
        validateToolSecurity({
          definition: { function: { name: "badTool" } },
          security: "nope",
        } as any),
      ).toThrow(/badTool/);
    });
  });
});

// ====================================================================
// agent-presets.ts
// ====================================================================
describe("agent-presets", () => {
  // -- createAgentPresetRegistry -----------------------------------------
  describe("createAgentPresetRegistry", () => {
    it("returns built-in presets when called with no config", () => {
      const registry = createAgentPresetRegistry(undefined);
      expect(registry.presets.length).toBeGreaterThan(0);
      // Check that known built-in presets are present
      expect(registry.byKey.has("subagent:general")).toBe(true);
      expect(registry.byKey.has("teammate:general")).toBe(true);
      expect(registry.byKey.has("subagent:explore")).toBe(true);
      expect(registry.byKey.has("subagent:review")).toBe(true);
      expect(registry.byKey.has("subagent:planner")).toBe(true);
    });

    it("allows config to override a built-in preset", () => {
      const customDescription = "Custom overridden description";
      const registry = createAgentPresetRegistry([
        {
          name: "general",
          targetHarnessKind: "subagent",
          description: customDescription,
          promptAppendix: "Custom prompt appendix for general.",
        },
      ]);
      const preset = registry.byKey.get("subagent:general");
      expect(preset).toBeDefined();
      expect(preset!.description).toBe(customDescription);
    });

    it("sorts presets by targetHarnessKind then name", () => {
      const registry = createAgentPresetRegistry(undefined);
      for (let i = 1; i < registry.presets.length; i++) {
        const prev = registry.presets[i - 1];
        const curr = registry.presets[i];
        const targetCmp = prev.targetHarnessKind.localeCompare(
          curr.targetHarnessKind,
        );
        expect(targetCmp <= 0).toBe(true);
        if (targetCmp === 0) {
          expect(prev.name.localeCompare(curr.name)).toBeLessThanOrEqual(0);
        }
      }
    });
  });

  // -- resolveAgentPreset ------------------------------------------------
  describe("resolveAgentPreset", () => {
    const registry = createAgentPresetRegistry(undefined);

    it("resolves a preset by kind and name", () => {
      const preset = resolveAgentPreset(registry, "subagent", "general");
      expect(preset).toBeDefined();
      expect(preset!.name).toBe("general");
      expect(preset!.targetHarnessKind).toBe("subagent");
    });

    it("resolves teammate presets independently from subagent", () => {
      const preset = resolveAgentPreset(registry, "teammate", "general");
      expect(preset).toBeDefined();
      expect(preset!.targetHarnessKind).toBe("teammate");
    });

    it("returns undefined for undefined name", () => {
      expect(
        resolveAgentPreset(registry, "subagent", undefined),
      ).toBeUndefined();
    });

    it("returns undefined for empty name", () => {
      expect(resolveAgentPreset(registry, "subagent", "")).toBeUndefined();
    });

    it("returns undefined for whitespace-only name", () => {
      expect(resolveAgentPreset(registry, "subagent", "   ")).toBeUndefined();
    });

    it("returns undefined for unknown preset name", () => {
      expect(
        resolveAgentPreset(registry, "subagent", "nonexistent"),
      ).toBeUndefined();
    });

    it("returns undefined when registry is undefined", () => {
      expect(
        resolveAgentPreset(undefined, "subagent", "general"),
      ).toBeUndefined();
    });

    it("performs case-insensitive lookup", () => {
      const preset = resolveAgentPreset(registry, "subagent", "General");
      expect(preset).toBeDefined();
      expect(preset!.name).toBe("general");
    });
  });

  // -- applyAgentPresetPromptAppendix ------------------------------------
  describe("applyAgentPresetPromptAppendix", () => {
    it("returns unchanged prompt when preset is undefined", () => {
      const prompt = "Base system prompt";
      expect(applyAgentPresetPromptAppendix(prompt, undefined)).toBe(prompt);
    });

    it("returns unchanged prompt when preset has an empty appendix", () => {
      const prompt = "Base system prompt";
      const preset = {
        name: "test",
        description: "",
        targetHarnessKind: "subagent" as const,
        promptAppendix: "",
      };
      expect(applyAgentPresetPromptAppendix(prompt, preset)).toBe(prompt);
    });

    it("returns unchanged prompt when preset has a whitespace-only appendix", () => {
      const prompt = "Base system prompt";
      const preset = {
        name: "test",
        description: "",
        targetHarnessKind: "subagent" as const,
        promptAppendix: "   ",
      };
      expect(applyAgentPresetPromptAppendix(prompt, preset)).toBe(prompt);
    });

    it("appends the prompt appendix with a double-newline separator", () => {
      const prompt = "Base system prompt";
      const appendix = "Additional instructions";
      const preset = {
        name: "test",
        description: "",
        targetHarnessKind: "subagent" as const,
        promptAppendix: appendix,
      };
      const result = applyAgentPresetPromptAppendix(prompt, preset);
      expect(result).toBe(`${prompt}\n\n${appendix}`);
    });
  });

  // -- applyAgentPresetAllowedTools --------------------------------------
  describe("applyAgentPresetAllowedTools", () => {
    it("returns explicit allowedTools when provided (wins over preset)", () => {
      const result = applyAgentPresetAllowedTools({
        allowedTools: ["tool_a", "tool_b"],
        preset: {
          name: "test",
          description: "",
          targetHarnessKind: "subagent" as const,
          promptAppendix: "x",
          allowedTools: ["tool_c"],
        },
      });
      expect(result).toEqual(["tool_a", "tool_b"]);
    });

    it("merges preset allowedTools with mandatoryTools and deduplicates", () => {
      const result = applyAgentPresetAllowedTools({
        preset: {
          name: "test",
          description: "",
          targetHarnessKind: "subagent" as const,
          promptAppendix: "x",
          allowedTools: ["tool_a", "tool_b"],
        },
        mandatoryTools: ["tool_b", "tool_c"],
      });
      expect(result).toEqual(["tool_a", "tool_b", "tool_c"]);
    });

    it("returns undefined when no allowedTools and no preset allowedTools", () => {
      const result = applyAgentPresetAllowedTools({
        preset: {
          name: "test",
          description: "",
          targetHarnessKind: "subagent" as const,
          promptAppendix: "x",
        },
      });
      expect(result).toBeUndefined();
    });

    it("returns undefined when all inputs are undefined", () => {
      const result = applyAgentPresetAllowedTools({});
      expect(result).toBeUndefined();
    });

    it("returns undefined when preset is undefined", () => {
      const result = applyAgentPresetAllowedTools({ preset: undefined });
      expect(result).toBeUndefined();
    });

    it("returns preset allowedTools when no mandatoryTools provided", () => {
      const result = applyAgentPresetAllowedTools({
        preset: {
          name: "test",
          description: "",
          targetHarnessKind: "subagent" as const,
          promptAppendix: "x",
          allowedTools: ["find_tools", "read_file"],
        },
      });
      expect(result).toEqual(["find_tools", "read_file"]);
    });

    it("deduplicates within preset allowedTools", () => {
      const result = applyAgentPresetAllowedTools({
        allowedTools: ["tool_a", "tool_a", "tool_b"],
      });
      expect(result).toEqual(["tool_a", "tool_b"]);
    });
  });
});

// ====================================================================
// harness-context.ts
// ====================================================================
describe("harness-context", () => {
  // -- resolveExecutionProfile -------------------------------------------
  describe("resolveExecutionProfile", () => {
    it("returns correct defaults for main", () => {
      const profile = resolveExecutionProfile("main");
      expect(profile).toEqual({
        workspaceMode: "shared",
        memoryMode: "session",
        priority: "interactive",
      });
    });

    it("returns correct defaults for subagent", () => {
      const profile = resolveExecutionProfile("subagent");
      expect(profile).toEqual({
        workspaceMode: "shared",
        memoryMode: "fresh",
        priority: "delegated",
      });
    });

    it("returns correct defaults for teammate", () => {
      const profile = resolveExecutionProfile("teammate");
      expect(profile).toEqual({
        workspaceMode: "shared",
        memoryMode: "persistent",
        priority: "background",
      });
    });

    it("applies overrides on top of defaults", () => {
      const profile = resolveExecutionProfile("main", {
        priority: "maintenance",
      });
      expect(profile.workspaceMode).toBe("shared");
      expect(profile.memoryMode).toBe("session");
      expect(profile.priority).toBe("maintenance");
    });

    it("applies multiple overrides", () => {
      const profile = resolveExecutionProfile("subagent", {
        workspaceMode: "isolated",
        memoryMode: "persistent",
        priority: "interactive",
      });
      expect(profile).toEqual({
        workspaceMode: "isolated",
        memoryMode: "persistent",
        priority: "interactive",
      });
    });
  });

  // -- cloneExecutionProfile ---------------------------------------------
  describe("cloneExecutionProfile", () => {
    it("returns a different reference with equal values", () => {
      const original: AgentExecutionProfile = {
        workspaceMode: "shared",
        memoryMode: "fresh",
        priority: "delegated",
      };
      const clone = cloneExecutionProfile(original);
      expect(clone).toEqual(original);
      expect(clone).not.toBe(original);
    });

    it("modifying the clone does not affect the original", () => {
      const original: AgentExecutionProfile = {
        workspaceMode: "shared",
        memoryMode: "fresh",
        priority: "delegated",
      };
      const clone = cloneExecutionProfile(original);
      clone.priority = "interactive";
      expect(original.priority).toBe("delegated");
    });
  });

  // -- isExecutionProfile ------------------------------------------------
  describe("isExecutionProfile", () => {
    it("returns true for a valid profile", () => {
      expect(
        isExecutionProfile({
          workspaceMode: "shared",
          memoryMode: "session",
          priority: "interactive",
        }),
      ).toBe(true);
    });

    it("returns false for a string", () => {
      expect(isExecutionProfile("shared/session/interactive")).toBe(false);
    });

    it("returns false for null", () => {
      expect(isExecutionProfile(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isExecutionProfile(undefined)).toBe(false);
    });

    it("returns false for an array", () => {
      expect(isExecutionProfile(["shared", "session", "interactive"])).toBe(
        false,
      );
    });

    it("returns false for an object with invalid workspaceMode", () => {
      expect(
        isExecutionProfile({
          workspaceMode: "unknown",
          memoryMode: "session",
          priority: "interactive",
        }),
      ).toBe(false);
    });

    it("returns false for an object with invalid memoryMode", () => {
      expect(
        isExecutionProfile({
          workspaceMode: "shared",
          memoryMode: "unknown",
          priority: "interactive",
        }),
      ).toBe(false);
    });

    it("returns false for an object with invalid priority", () => {
      expect(
        isExecutionProfile({
          workspaceMode: "shared",
          memoryMode: "session",
          priority: "unknown",
        }),
      ).toBe(false);
    });
  });

  // -- persistExecutionProfile -------------------------------------------
  describe("persistExecutionProfile", () => {
    it("returns an object with workspaceMode only", () => {
      const result = persistExecutionProfile({
        workspaceMode: "shared",
        memoryMode: "session",
        priority: "interactive",
      });
      expect(result).toEqual({ workspaceMode: "shared" });
    });

    it("returns undefined for undefined input", () => {
      expect(persistExecutionProfile(undefined)).toBeUndefined();
    });

    it("returns only workspaceMode, dropping other fields", () => {
      const result = persistExecutionProfile({
        workspaceMode: "isolated",
        memoryMode: "fresh",
        priority: "delegated",
      });
      expect(result).toEqual({ workspaceMode: "isolated" });
      // Ensure no extra keys
      expect(Object.keys(result!)).toEqual(["workspaceMode"]);
    });
  });

  // -- formatExecutionProfile --------------------------------------------
  describe("formatExecutionProfile", () => {
    it("formats a full profile as workspaceMode/memoryMode/priority", () => {
      const result = formatExecutionProfile({
        workspaceMode: "shared",
        memoryMode: "session",
        priority: "interactive",
      });
      expect(result).toBe("shared/session/interactive");
    });

    it("falls back to defaults for missing segments", () => {
      const result = formatExecutionProfile({});
      expect(result).toBe("unknown/unknown/unknown");
    });

    it("uses provided fallback values", () => {
      const result = formatExecutionProfile(undefined, {
        workspaceMode: "shared",
        memoryMode: "fresh",
        priority: "delegated",
      });
      expect(result).toBe("shared/fresh/delegated");
    });

    it("treats null input as unknown defaults", () => {
      const result = formatExecutionProfile(null);
      expect(result).toBe("unknown/unknown/unknown");
    });
  });

  // -- formatExecutionProfileForHarness ----------------------------------
  describe("formatExecutionProfileForHarness", () => {
    it("formats with main defaults when value is undefined", () => {
      const result = formatExecutionProfileForHarness("main", undefined);
      expect(result).toBe("shared/session/interactive");
    });

    it("formats with subagent defaults when value is undefined", () => {
      const result = formatExecutionProfileForHarness("subagent", undefined);
      expect(result).toBe("shared/fresh/delegated");
    });

    it("formats with teammate defaults when value is undefined", () => {
      const result = formatExecutionProfileForHarness("teammate", undefined);
      expect(result).toBe("shared/persistent/background");
    });

    it("uses the provided value when present", () => {
      const result = formatExecutionProfileForHarness("main", {
        workspaceMode: "isolated",
        memoryMode: "persistent",
        priority: "maintenance",
      });
      expect(result).toBe("isolated/persistent/maintenance");
    });
  });

  // -- runWithHarnessContext + getHarnessContext --------------------------
  describe("runWithHarnessContext + getHarnessContext", () => {
    it("returns the context inside the callback", async () => {
      const context = {
        id: "test-id",
        kind: "subagent" as AgentHarnessKind,
        name: "test-agent",
        depth: 1,
        workspaceRoot: "/tmp/workspace",
        sessionId: "session-1",
        goalId: "goal-1",
        executionProfile: {
          workspaceMode: "shared" as const,
          memoryMode: "fresh" as const,
          priority: "delegated" as const,
        },
        lifecycleState: "active" as const,
        attemptCount: 1,
        attemptId: "attempt-1",
        runStartedAt: "2025-01-01T00:00:00Z",
      };

      await runWithHarnessContext(context, async () => {
        const stored = getHarnessContext();
        expect(stored).toBe(context);
        expect(stored!.id).toBe("test-id");
        expect(stored!.kind).toBe("subagent");
      });
    });

    it("returns undefined outside of a harness context", () => {
      expect(getHarnessContext()).toBeUndefined();
    });

    it("restores context correctly after the callback completes", async () => {
      const context = {
        id: "outer",
        kind: "main" as AgentHarnessKind,
        name: "outer-agent",
        depth: 0,
        workspaceRoot: "/tmp",
        sessionId: "s1",
        goalId: "g1",
        executionProfile: {
          workspaceMode: "shared" as const,
          memoryMode: "session" as const,
          priority: "interactive" as const,
        },
        lifecycleState: "active" as const,
        attemptCount: 1,
        attemptId: "a1",
        runStartedAt: "2025-01-01T00:00:00Z",
      };

      await runWithHarnessContext(context, async () => {
        expect(getHarnessContext()).toBe(context);
      });

      // After the callback, context should be undefined again
      expect(getHarnessContext()).toBeUndefined();
    });
  });
});
