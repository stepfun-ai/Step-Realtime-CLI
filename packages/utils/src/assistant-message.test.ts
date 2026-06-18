import { describe, it, expect } from "vitest";
import type { AssistantMessage } from "@step-cli/protocol";
import {
  pickAssistantReasoningFields,
  getAssistantReasoningLabel,
  extractAssistantReasoningSections,
  assistantMessagePreviewText,
  cloneAssistantMessage,
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

    it("ignores non-array thinking_blocks", () => {
      const sections = extractAssistantReasoningSections({
        thinking_blocks: "not-an-array",
      });
      expect(sections).toEqual([]);
    });

    it("filters out non-object entries in thinking_blocks", () => {
      const message = {
        thinking_blocks: [
          null,
          42,
          ["x"],
          { type: "thinking", thinking: "ok" },
        ],
      };
      const sections = extractAssistantReasoningSections(message);
      expect(sections).toHaveLength(1);
      expect(sections[0]!.text).toBe("ok");
    });

    it("classifies a typeless block by its analysis field", () => {
      const sections = extractAssistantReasoningSections({
        thinking_blocks: [{ analysis: "analysis only" }],
      });
      expect(sections).toHaveLength(1);
      expect(sections[0]!.kind).toBe("analysis");
      expect(sections[0]!.text).toBe("analysis only");
    });

    it("classifies a typeless block by its reasoning field", () => {
      const sections = extractAssistantReasoningSections({
        thinking_blocks: [{ reasoning: "reasoning only" }],
      });
      expect(sections).toHaveLength(1);
      expect(sections[0]!.kind).toBe("reasoning");
      expect(sections[0]!.text).toBe("reasoning only");
    });

    it("classifies a typeless block by data as redacted_thinking", () => {
      const sections = extractAssistantReasoningSections({
        thinking_blocks: [{ data: "secret-bytes" }],
      });
      expect(sections).toHaveLength(1);
      expect(sections[0]!.kind).toBe("redacted_thinking");
      expect(sections[0]!.text).toBe("secret-bytes");
    });

    it("classifies a typeless block with only thinking text", () => {
      const sections = extractAssistantReasoningSections({
        thinking_blocks: [{ thinking: "just thinking" }],
      });
      expect(sections).toHaveLength(1);
      expect(sections[0]!.kind).toBe("thinking");
    });

    it("falls back to text field for a typeless block", () => {
      const sections = extractAssistantReasoningSections({
        thinking_blocks: [{ text: "plain text" }],
      });
      expect(sections).toHaveLength(1);
      expect(sections[0]!.kind).toBe("thinking");
      expect(sections[0]!.text).toBe("plain text");
    });

    it("returns nothing for a block with no usable text", () => {
      const sections = extractAssistantReasoningSections({
        thinking_blocks: [{ type: "thinking" }],
      });
      expect(sections).toEqual([]);
    });

    it("uses text fallback for an analysis-typed block missing analysis field", () => {
      const sections = extractAssistantReasoningSections({
        thinking_blocks: [{ type: "analysis", text: "fallback analysis" }],
      });
      expect(sections).toHaveLength(1);
      expect(sections[0]!.kind).toBe("analysis");
      expect(sections[0]!.text).toBe("fallback analysis");
    });

    it("uses text fallback for a reasoning-typed block missing reasoning field", () => {
      const sections = extractAssistantReasoningSections({
        thinking_blocks: [{ type: "reasoning", text: "fallback reasoning" }],
      });
      expect(sections).toHaveLength(1);
      expect(sections[0]!.kind).toBe("reasoning");
    });

    it("uses data fallback for a redacted_thinking-typed block", () => {
      const sections = extractAssistantReasoningSections({
        thinking_blocks: [{ type: "redacted_thinking", data: "via-data" }],
      });
      expect(sections).toHaveLength(1);
      expect(sections[0]!.kind).toBe("redacted_thinking");
      expect(sections[0]!.text).toBe("via-data");
    });

    it("extracts all five reasoning text fields, deduped by kind text", () => {
      const sections = extractAssistantReasoningSections({
        reasoning_content: "rc",
        thinking: "th",
        analysis: "an",
        reasoning: "re",
        redacted_thinking: "rt",
      });
      expect(sections.map((s) => s.kind)).toEqual([
        "reasoning_content",
        "thinking",
        "analysis",
        "reasoning",
        "redacted_thinking",
      ]);
    });
  });

  // ---- cloneAssistantMessage ----

  describe("cloneAssistantMessage", () => {
    it("clones a minimal message", () => {
      const msg: AssistantMessage = { role: "assistant", content: "hi" };
      const clone = cloneAssistantMessage(msg);
      expect(clone).toEqual({ role: "assistant", content: "hi" });
      expect(clone).not.toBe(msg);
    });

    it("includes spanId when present", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "hi",
        spanId: "span-1",
      };
      const clone = cloneAssistantMessage(msg);
      expect(clone.spanId).toBe("span-1");
    });

    it("deep-clones tool_calls", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "do", arguments: "{}" },
          },
        ],
      };
      const clone = cloneAssistantMessage(msg);
      expect(clone.tool_calls).toEqual(msg.tool_calls);
      expect(clone.tool_calls).not.toBe(msg.tool_calls);
      expect(clone.tool_calls![0]!.function).not.toBe(
        msg.tool_calls![0]!.function,
      );
    });

    it("omits empty tool_calls", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "x",
        tool_calls: [],
      };
      const clone = cloneAssistantMessage(msg);
      expect(clone.tool_calls).toBeUndefined();
    });

    it("includes and deep-clones thinking_blocks", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "x",
        thinking_blocks: [{ type: "thinking", thinking: "deep" }],
      };
      const clone = cloneAssistantMessage(msg);
      expect(clone.thinking_blocks).toEqual(msg.thinking_blocks);
      expect(clone.thinking_blocks).not.toBe(msg.thinking_blocks);
      expect(clone.thinking_blocks![0]).not.toBe(msg.thinking_blocks![0]);
    });

    it("omits empty thinking_blocks", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "x",
        thinking_blocks: [],
      };
      const clone = cloneAssistantMessage(msg);
      expect(clone.thinking_blocks).toBeUndefined();
    });

    it("carries reasoning text fields through", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "x",
        thinking: "reasoned",
        reasoning_signature: "sig",
      };
      const clone = cloneAssistantMessage(msg);
      expect(clone.thinking).toBe("reasoned");
      expect(clone.reasoning_signature).toBe("sig");
    });
  });

  // ---- assistantMessagePreviewText (block fallbacks) ----

  describe("assistantMessagePreviewText block fallbacks", () => {
    it("uses block 'data' field as preview fallback", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "",
        thinking_blocks: [{ type: "redacted_thinking", data: "blob" }],
      };
      expect(assistantMessagePreviewText(msg)).toBe("blob");
    });

    it("uses block 'reasoning' field as preview when no section produced", () => {
      const msg = {
        role: "assistant",
        content: "",
        thinking_blocks: [{ foo: "bar", reasoning: "" }],
      } as unknown as AssistantMessage;
      // No section (empty reasoning) and previewTextFromThinkingBlock finds nothing
      expect(assistantMessagePreviewText(msg)).toBe("");
    });

    it("returns '' when content is empty and blocks have no usable text", () => {
      const msg: AssistantMessage = {
        role: "assistant",
        content: "",
        thinking_blocks: [{ type: "thinking" }],
      };
      expect(assistantMessagePreviewText(msg)).toBe("");
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
