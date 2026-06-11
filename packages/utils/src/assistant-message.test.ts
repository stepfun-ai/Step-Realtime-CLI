import { describe, it, expect } from "vitest";
import type { AssistantMessage } from "@step-cli/protocol";
import {
  pickAssistantReasoningFields,
  getAssistantReasoningLabel,
  extractAssistantReasoningSections,
  assistantMessagePreviewText,
} from "./assistant-message.js";

// ---------------------------------------------------------------------------
// assistant-message
// ---------------------------------------------------------------------------

describe("assistant-message", () => {
  // ---- pickAssistantReasoningFields ----

  describe("pickAssistantReasoningFields", () => {
    it("returns empty object when message has no reasoning fields", () => {
      const result = pickAssistantReasoningFields({
        role: "assistant",
        content: "hello",
      });
      expect(result).toEqual({});
    });

    it("extracts reasoning text fields", () => {
      const result = pickAssistantReasoningFields({
        role: "assistant",
        content: "response",
        thinking: "I need to analyze...",
        reasoning: "Step 1: ...",
      });
      expect(result.thinking).toBe("I need to analyze...");
      expect(result.reasoning).toBe("Step 1: ...");
    });

    it("extracts reasoning_content field", () => {
      const result = pickAssistantReasoningFields({
        reasoning_content: "deep thought",
      });
      expect(result.reasoning_content).toBe("deep thought");
    });

    it("extracts analysis field", () => {
      const result = pickAssistantReasoningFields({
        analysis: "analysis text",
      });
      expect(result.analysis).toBe("analysis text");
    });

    it("extracts redacted_thinking field", () => {
      const result = pickAssistantReasoningFields({
        redacted_thinking: "[redacted]",
      });
      expect(result.redacted_thinking).toBe("[redacted]");
    });

    it("extracts reasoning_signature field", () => {
      const result = pickAssistantReasoningFields({
        reasoning_signature: "sig_123",
      });
      expect(result.reasoning_signature).toBe("sig_123");
    });

    it("extracts thinking_blocks field", () => {
      const blocks = [{ type: "thinking", thinking: "hmm" }];
      const result = pickAssistantReasoningFields({
        thinking_blocks: blocks,
      });
      expect(result.thinking_blocks).toEqual(blocks);
    });

    it("does not extract empty string values", () => {
      const result = pickAssistantReasoningFields({
        thinking: "   ",
        reasoning: "",
      });
      expect(result.thinking).toBeUndefined();
      expect(result.reasoning).toBeUndefined();
    });

    it("handles non-object input gracefully", () => {
      expect(pickAssistantReasoningFields(null)).toEqual({});
      expect(pickAssistantReasoningFields(undefined)).toEqual({});
      expect(pickAssistantReasoningFields("string")).toEqual({});
      expect(pickAssistantReasoningFields(42)).toEqual({});
    });
  });

  // ---- getAssistantReasoningLabel ----

  describe("getAssistantReasoningLabel", () => {
    it("returns full label for reasoning_content", () => {
      expect(getAssistantReasoningLabel("reasoning_content")).toBe("Reasoning");
    });

    it("returns full label for thinking", () => {
      expect(getAssistantReasoningLabel("thinking")).toBe("Thinking");
    });

    it("returns full label for analysis", () => {
      expect(getAssistantReasoningLabel("analysis")).toBe("Analysis");
    });

    it("returns full label for reasoning", () => {
      expect(getAssistantReasoningLabel("reasoning")).toBe("Reasoning");
    });

    it("returns full label for redacted_thinking", () => {
      expect(getAssistantReasoningLabel("redacted_thinking")).toBe(
        "Redacted thinking",
      );
    });

    it("returns compact label for reasoning_content", () => {
      expect(
        getAssistantReasoningLabel("reasoning_content", { compact: true }),
      ).toBe("reasoning");
    });

    it("returns compact label for thinking", () => {
      expect(getAssistantReasoningLabel("thinking", { compact: true })).toBe(
        "thinking",
      );
    });

    it("returns compact label for analysis", () => {
      expect(getAssistantReasoningLabel("analysis", { compact: true })).toBe(
        "analysis",
      );
    });

    it("returns compact label for reasoning", () => {
      expect(getAssistantReasoningLabel("reasoning", { compact: true })).toBe(
        "reasoning",
      );
    });

    it("returns compact label for redacted_thinking", () => {
      expect(
        getAssistantReasoningLabel("redacted_thinking", { compact: true }),
      ).toBe("redacted");
    });
  });

  // ---- extractAssistantReasoningSections ----

  describe("extractAssistantReasoningSections", () => {
    it("returns empty array for object without reasoning data", () => {
      expect(extractAssistantReasoningSections({ content: "hi" })).toEqual([]);
    });

    it("extracts sections from thinking_blocks", () => {
      const message = {
        thinking_blocks: [{ type: "thinking", thinking: "Let me think..." }],
      };
      const sections = extractAssistantReasoningSections(message);
      expect(sections).toHaveLength(1);
      expect(sections[0]!.kind).toBe("thinking");
      expect(sections[0]!.text).toBe("Let me think...");
      expect(sections[0]!.label).toBe("Thinking");
    });

    it("extracts sections from text fields", () => {
      const message = {
        thinking: "I reasoned about it",
      };
      const sections = extractAssistantReasoningSections(message);
      expect(sections).toHaveLength(1);
      expect(sections[0]!.kind).toBe("thinking");
      expect(sections[0]!.text).toBe("I reasoned about it");
    });

    it("deduplicates sections with identical normalized text", () => {
      const message = {
        thinking: "  same reasoning  ",
        reasoning: "same reasoning", // normalized to same text
      };
      const sections = extractAssistantReasoningSections(message);
      // Should deduplicate based on normalized whitespace
      expect(sections).toHaveLength(1);
    });

    it("deduplicates thinking_blocks against text fields", () => {
      const message = {
        thinking_blocks: [{ type: "thinking", thinking: "my analysis" }],
        thinking: "my analysis",
      };
      const sections = extractAssistantReasoningSections(message);
      // thinking_blocks extracted first, text field deduped
      expect(sections).toHaveLength(1);
    });

    it("keeps sections with different text", () => {
      const message = {
        thinking_blocks: [{ type: "thinking", thinking: "first thought" }],
        analysis: "second analysis",
      };
      const sections = extractAssistantReasoningSections(message);
      expect(sections).toHaveLength(2);
      expect(sections[0]!.kind).toBe("thinking");
      expect(sections[1]!.kind).toBe("analysis");
    });

    it("handles multiple thinking block types", () => {
      const message = {
        thinking_blocks: [
          { type: "thinking", thinking: "thought process" },
          { type: "redacted_thinking", redacted_thinking: "hidden" },
          { type: "analysis", analysis: "analytical" },
        ],
      };
      const sections = extractAssistantReasoningSections(message);
      expect(sections).toHaveLength(3);
      expect(sections[0]!.kind).toBe("thinking");
      expect(sections[1]!.kind).toBe("redacted_thinking");
      expect(sections[2]!.kind).toBe("analysis");
    });

    it("extracts redacted_thinking from blocks with data field", () => {
      const message = {
        thinking_blocks: [
          { type: "redacted_thinking", data: "redacted-data-here" },
        ],
      };
      const sections = extractAssistantReasoningSections(message);
      expect(sections).toHaveLength(1);
      expect(sections[0]!.kind).toBe("redacted_thinking");
      expect(sections[0]!.text).toBe("redacted-data-here");
    });

    it("handles empty or invalid thinking_blocks gracefully", () => {
      const message = {
        thinking_blocks: [],
      };
      const sections = extractAssistantReasoningSections(message);
      expect(sections).toEqual([]);
    });

    it("skips blocks with empty text", () => {
      const message = {
        thinking_blocks: [{ type: "thinking", thinking: "   " }],
      };
      const sections = extractAssistantReasoningSections(message);
      expect(sections).toEqual([]);
    });
  });

  // ---- assistantMessagePreviewText ----

  describe("assistantMessagePreviewText", () => {
    it("returns content when non-empty", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "Here is the answer.",
      };
      expect(assistantMessagePreviewText(msg)).toBe("Here is the answer.");
    });

    it("falls back to reasoning sections when content is empty", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "",
        thinking: "I thought about it",
      };
      expect(assistantMessagePreviewText(msg)).toBe("I thought about it");
    });

    it("returns empty string when no content and no reasoning", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "",
      };
      expect(assistantMessagePreviewText(msg)).toBe("");
    });

    it("uses thinking_blocks as fallback", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "",
        thinking_blocks: [{ type: "thinking", thinking: "internal reasoning" }],
      };
      expect(assistantMessagePreviewText(msg)).toBe("internal reasoning");
    });

    it("prefers content over reasoning sections", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "visible content",
        thinking: "hidden reasoning",
      };
      expect(assistantMessagePreviewText(msg)).toBe("visible content");
    });

    it("handles whitespace-only content as empty", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "   ",
        thinking: "fallback reasoning",
      };
      expect(assistantMessagePreviewText(msg)).toBe("fallback reasoning");
    });
  });
});
