import { describe, it, expect } from "vitest";
import {
  createAgentPresetRegistry,
  resolveAgentPreset,
  applyAgentPresetPromptAppendix,
  applyAgentPresetAllowedTools,
} from "./agent-presets.js";

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
