import { describe, it, expect } from "vitest";
import type { UserTurnInput } from "@step-cli/protocol";
import {
  extractInlineDelegationPresetFromUserTurn,
  parseInlineDelegationPresetSelector,
  buildDelegationPresetSystemPromptAppendix,
} from "./inline-preset-selector.js";

describe("parseInlineDelegationPresetSelector", () => {
  it("parses @presetName with remaining content", () => {
    expect(parseInlineDelegationPresetSelector("@coder fix the bug")).toEqual({
      preset: "coder",
      content: "fix the bug",
    });
  });

  it("parses preset=presetName syntax", () => {
    expect(
      parseInlineDelegationPresetSelector("preset=research summarize this"),
    ).toEqual({
      preset: "research",
      content: "summarize this",
    });
  });

  it("returns null when preset is not in knownPresets", () => {
    expect(
      parseInlineDelegationPresetSelector("@unknown do work", {
        knownPresets: ["coder", "research"],
      }),
    ).toBeNull();
  });

  it("returns null when content does not match", () => {
    expect(
      parseInlineDelegationPresetSelector("just a normal message"),
    ).toBeNull();
    expect(parseInlineDelegationPresetSelector("")).toBeNull();
  });

  it("accepts preset-only input with empty remaining content", () => {
    expect(parseInlineDelegationPresetSelector("@coder")).toEqual({
      preset: "coder",
      content: "",
    });
  });
});

describe("buildDelegationPresetSystemPromptAppendix", () => {
  it("includes the preset name in delegation guidance", () => {
    const appendix = buildDelegationPresetSystemPromptAppendix("coder");
    expect(appendix).toContain('prefer preset "coder"');
    expect(appendix).toContain("Delegation preset hint");
  });
});

describe("extractInlineDelegationPresetFromUserTurn", () => {
  it("extracts preset, strips selector prefix, and appends system prompt", () => {
    const input: UserTurnInput = {
      content: "@Coder implement auth",
      systemPromptAppendix: "existing hint",
    };

    const result = extractInlineDelegationPresetFromUserTurn(input, {
      knownPresets: ["coder"],
    });

    expect(result.content).toBe("implement auth");
    expect(result.systemPromptAppendix).toContain("existing hint");
    expect(result.systemPromptAppendix).toContain('prefer preset "coder"');
  });

  it("returns input unchanged when no inline preset is present", () => {
    const input: UserTurnInput = { content: "hello" };
    expect(extractInlineDelegationPresetFromUserTurn(input)).toBe(input);
  });
});
