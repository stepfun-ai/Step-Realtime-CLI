import { describe, it, expect } from "vitest";
import type { UserClarificationRequest, UserClarificationOption } from "@step-cli/protocol";
import {
  parseClarificationAnswer,
  formatClarificationOption,
  clarificationAllowsFreeform,
  normalizeUserClarificationRequest,
} from "./clarification.js";

// ---------------------------------------------------------------------------
// clarification
// ---------------------------------------------------------------------------

describe("clarification", () => {
  // ---- parseClarificationAnswer ----

  describe("parseClarificationAnswer", () => {
    const options: UserClarificationOption[] = [
      { label: "Option A", value: "a" },
      { label: "Option B", value: "b" },
      { label: "Refactor code", value: "refactor" },
    ];

    function makeRequest(
      overrides: Partial<UserClarificationRequest> = {},
    ): UserClarificationRequest {
      return {
        question: "Pick one",
        options,
        ...overrides,
      };
    }

    it("parses numeric input to select an option", () => {
      const result = parseClarificationAnswer(makeRequest(), "1");
      expect(result.kind).toBe("answer");
      if (result.kind === "answer") {
        expect(result.response.cancelled).toBe(false);
        expect(result.response.answer).toBe("a");
        expect(result.response.source).toBe("option");
        expect(result.response.matchedOption!.value).toBe("a");
      }
    });

    it("parses numeric input for second option", () => {
      const result = parseClarificationAnswer(makeRequest(), "2");
      expect(result.kind).toBe("answer");
      if (result.kind === "answer") {
        expect(result.response.answer).toBe("b");
      }
    });

    it("parses label input (case-insensitive)", () => {
      const result = parseClarificationAnswer(makeRequest(), "option a");
      expect(result.kind).toBe("answer");
      if (result.kind === "answer") {
        expect(result.response.answer).toBe("a");
        expect(result.response.source).toBe("option");
      }
    });

    it("parses value input (case-insensitive)", () => {
      const result = parseClarificationAnswer(makeRequest(), "refactor");
      expect(result.kind).toBe("answer");
      if (result.kind === "answer") {
        expect(result.response.answer).toBe("refactor");
      }
    });

    it("parses freeform text when no option matches and freeform is allowed", () => {
      const result = parseClarificationAnswer(
        makeRequest(),
        "some custom answer",
      );
      expect(result.kind).toBe("answer");
      if (result.kind === "answer") {
        expect(result.response.cancelled).toBe(false);
        expect(result.response.answer).toBe("some custom answer");
        expect(result.response.source).toBe("freeform");
        expect(result.response.matchedOption).toBeUndefined();
      }
    });

    it("returns invalid for freeform when allowFreeform is false and no match", () => {
      const result = parseClarificationAnswer(
        makeRequest({ allowFreeform: false }),
        "random text",
      );
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.message).toContain("options");
      }
    });

    it("parses 'cancel' as cancel response", () => {
      const result = parseClarificationAnswer(makeRequest(), "cancel");
      expect(result.kind).toBe("cancel");
      if (result.kind === "cancel") {
        expect(result.response.cancelled).toBe(true);
        expect(result.response.reason).toBeDefined();
      }
    });

    it("parses 'c' as cancel response", () => {
      const result = parseClarificationAnswer(makeRequest(), "c");
      expect(result.kind).toBe("cancel");
    });

    it("parses '?' as help request", () => {
      const result = parseClarificationAnswer(makeRequest(), "?");
      expect(result.kind).toBe("help");
    });

    it("parses 'help' as help request", () => {
      const result = parseClarificationAnswer(makeRequest(), "help");
      expect(result.kind).toBe("help");
    });

    it("returns invalid for empty input", () => {
      const result = parseClarificationAnswer(makeRequest(), "");
      expect(result.kind).toBe("invalid");
    });

    it("returns invalid for whitespace-only input", () => {
      const result = parseClarificationAnswer(makeRequest(), "   ");
      expect(result.kind).toBe("invalid");
    });

    it("returns invalid for out-of-range numeric input", () => {
      const result = parseClarificationAnswer(makeRequest(), "99");
      // 99 doesn't match any option, falls through to freeform
      expect(result.kind).toBe("answer");
      if (result.kind === "answer") {
        expect(result.response.source).toBe("freeform");
        expect(result.response.answer).toBe("99");
      }
    });

    it("returns invalid when freeform is disabled and no options exist", () => {
      const result = parseClarificationAnswer(
        makeRequest({ allowFreeform: false, options: [] }),
        "anything",
      );
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.message).toContain("disabled");
      }
    });

    it("trims input before processing", () => {
      const result = parseClarificationAnswer(makeRequest(), "  help  ");
      expect(result.kind).toBe("help");
    });
  });

  // ---- formatClarificationOption ----

  describe("formatClarificationOption", () => {
    it("omits value suffix when label equals value", () => {
      const option: UserClarificationOption = { label: "Yes", value: "Yes" };
      expect(formatClarificationOption(option, 0)).toBe("1. Yes");
    });

    it("omits value suffix when label equals value case-insensitively", () => {
      const option: UserClarificationOption = { label: "Yes", value: "yes" };
      expect(formatClarificationOption(option, 0)).toBe("1. Yes");
    });

    it("includes value suffix when label differs from value", () => {
      const option: UserClarificationOption = {
        label: "Refactor",
        value: "refactor_code",
      };
      expect(formatClarificationOption(option, 0)).toBe(
        "1. Refactor (refactor_code)",
      );
    });

    it("uses 1-based index", () => {
      const option: UserClarificationOption = { label: "Yes", value: "yes" };
      expect(formatClarificationOption(option, 2)).toBe("3. Yes");
    });
  });

  // ---- clarificationAllowsFreeform ----

  describe("clarificationAllowsFreeform", () => {
    it("returns true by default (undefined allowFreeform)", () => {
      const request: UserClarificationRequest = { question: "q?" };
      expect(clarificationAllowsFreeform(request)).toBe(true);
    });

    it("returns true when explicitly set to true", () => {
      const request: UserClarificationRequest = {
        question: "q?",
        allowFreeform: true,
      };
      expect(clarificationAllowsFreeform(request)).toBe(true);
    });

    it("returns false when explicitly set to false", () => {
      const request: UserClarificationRequest = {
        question: "q?",
        allowFreeform: false,
      };
      expect(clarificationAllowsFreeform(request)).toBe(false);
    });
  });

  // ---- normalizeUserClarificationRequest ----

  describe("normalizeUserClarificationRequest", () => {
    it("normalizes a basic request", () => {
      const request: UserClarificationRequest = {
        question: "Which approach?",
        options: [{ label: "A", value: "a" }],
      };
      const normalized = normalizeUserClarificationRequest(request);
      expect(normalized.question).toBe("Which approach?");
      expect(normalized.allowFreeform).toBe(true);
      expect(normalized.options).toHaveLength(1);
      expect(normalized.options![0]!.label).toBe("A");
    });

    it("preserves reason if present", () => {
      const request: UserClarificationRequest = {
        question: "q?",
        reason: "needs clarification",
      };
      const normalized = normalizeUserClarificationRequest(request);
      expect(normalized.reason).toBe("needs clarification");
    });

    it("does not include reason if absent", () => {
      const request: UserClarificationRequest = { question: "q?" };
      const normalized = normalizeUserClarificationRequest(request);
      expect(normalized.reason).toBeUndefined();
    });

    it("respects explicit allowFreeform=false", () => {
      const request: UserClarificationRequest = {
        question: "q?",
        allowFreeform: false,
      };
      const normalized = normalizeUserClarificationRequest(request);
      expect(normalized.allowFreeform).toBe(false);
    });
  });
});
