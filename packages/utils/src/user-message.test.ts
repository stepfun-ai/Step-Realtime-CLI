import { describe, it, expect } from "vitest";
import type { UserTurnInput, UserAttachment } from "@step-cli/protocol";
import {
  normalizeUserTurnInput,
  isUserTurnEmpty,
  formatUserAttachmentSummary,
  userMessagePreviewText,
} from "./user-message.js";

// ---------------------------------------------------------------------------
// user-message
// ---------------------------------------------------------------------------

describe("user-message", () => {
  // ---- normalizeUserTurnInput ----

  describe("normalizeUserTurnInput", () => {
    it("wraps a plain string into a UserTurnInput object", () => {
      const result = normalizeUserTurnInput("hello");
      expect(result).toEqual({ content: "hello" });
    });

    it("passes through an object input preserving content", () => {
      const input: UserTurnInput = {
        content: "hello",
        attachments: [
          {
            kind: "image",
            source: { type: "url", url: "https://example.com/img.png" },
          },
        ],
      };
      const result = normalizeUserTurnInput(input);
      expect(result.content).toBe("hello");
      expect(result.attachments).toBeDefined();
      expect(result.attachments).toHaveLength(1);
    });

    it("does not include attachments when input has none", () => {
      const result = normalizeUserTurnInput({ content: "text" });
      expect(result.attachments).toBeUndefined();
    });

    it("preserves systemPromptAppendix when present and non-empty", () => {
      const result = normalizeUserTurnInput({
        content: "text",
        systemPromptAppendix: "extra instructions",
      });
      expect(result.systemPromptAppendix).toBe("extra instructions");
    });

    it("omits systemPromptAppendix when empty string", () => {
      const result = normalizeUserTurnInput({
        content: "text",
        systemPromptAppendix: "   ",
      });
      expect(result.systemPromptAppendix).toBeUndefined();
    });

    it("handles object with missing content gracefully", () => {
      const result = normalizeUserTurnInput({} as UserTurnInput);
      expect(result.content).toBe("");
    });
  });

  // ---- isUserTurnEmpty ----

  describe("isUserTurnEmpty", () => {
    it("returns true for empty string", () => {
      expect(isUserTurnEmpty("")).toBe(true);
    });

    it("returns true for whitespace-only string", () => {
      expect(isUserTurnEmpty("   ")).toBe(true);
    });

    it("returns false for non-empty string", () => {
      expect(isUserTurnEmpty("hello")).toBe(false);
    });

    it("returns true for object with empty content and no attachments", () => {
      expect(isUserTurnEmpty({ content: "" })).toBe(true);
    });

    it("returns true for object with whitespace content and no attachments", () => {
      expect(isUserTurnEmpty({ content: "  " })).toBe(true);
    });

    it("returns false when content is empty but attachments are present", () => {
      const input: UserTurnInput = {
        content: "",
        attachments: [
          { kind: "image", source: { type: "file", path: "/img.png" } },
        ],
      };
      expect(isUserTurnEmpty(input)).toBe(false);
    });

    it("returns false when content is non-empty", () => {
      expect(isUserTurnEmpty({ content: "hi" })).toBe(false);
    });
  });

  // ---- formatUserAttachmentSummary ----

  describe("formatUserAttachmentSummary", () => {
    it("returns empty string for undefined attachments", () => {
      expect(formatUserAttachmentSummary(undefined)).toBe("");
    });

    it("returns empty string for empty array", () => {
      expect(formatUserAttachmentSummary([])).toBe("");
    });

    it("uses singular for a single attachment", () => {
      const attachments: UserAttachment[] = [
        {
          kind: "image",
          source: { type: "url", url: "https://example.com/a.png" },
        },
      ];
      const summary = formatUserAttachmentSummary(attachments);
      expect(summary).toContain("Attached image:");
      expect(summary).not.toContain("Attached images:");
    });

    it("uses plural for multiple attachments", () => {
      const attachments: UserAttachment[] = [
        {
          kind: "image",
          source: { type: "url", url: "https://example.com/a.png" },
        },
        {
          kind: "image",
          source: { type: "url", url: "https://example.com/b.png" },
        },
      ];
      const summary = formatUserAttachmentSummary(attachments);
      expect(summary).toContain("Attached images:");
    });

    it("shows filename for file source by default", () => {
      const attachments: UserAttachment[] = [
        {
          kind: "image",
          source: { type: "file", path: "/home/user/photos/cat.png" },
        },
      ];
      const summary = formatUserAttachmentSummary(attachments);
      expect(summary).toContain("cat.png");
    });

    it("shows full path in verbose mode for file source", () => {
      const attachments: UserAttachment[] = [
        {
          kind: "image",
          source: { type: "file", path: "/home/user/photos/cat.png" },
        },
      ];
      const summary = formatUserAttachmentSummary(attachments, {
        verboseAttachments: true,
      });
      expect(summary).toContain("/home/user/photos/cat.png");
    });
  });

  // ---- userMessagePreviewText ----

  describe("userMessagePreviewText", () => {
    it("returns content when present without attachments", () => {
      const result = userMessagePreviewText({ content: "Hello world" });
      expect(result).toBe("Hello world");
    });

    it("returns attachment summary when content is empty", () => {
      const result = userMessagePreviewText({
        content: "",
        attachments: [
          { kind: "image", source: { type: "file", path: "/img.png" } },
        ],
      });
      expect(result).toContain("Attached image:");
    });

    it("combines content and attachment summary", () => {
      const result = userMessagePreviewText({
        content: "Check this",
        attachments: [
          { kind: "image", source: { type: "file", path: "/img.png" } },
        ],
      });
      expect(result).toContain("Check this");
      expect(result).toContain("Attached image:");
      expect(result.split("\n")).toHaveLength(2);
    });

    it("returns empty string when content and attachments are both empty", () => {
      const result = userMessagePreviewText({ content: "" });
      expect(result).toBe("");
    });

    it("handles undefined content", () => {
      const result = userMessagePreviewText({
        content: undefined as unknown as string,
      });
      expect(result).toBe("");
    });
  });
});
