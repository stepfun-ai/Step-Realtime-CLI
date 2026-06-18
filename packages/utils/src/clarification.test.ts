import { describe, it, expect } from "vitest";
import type {
  UserClarificationRequest,
  UserClarificationOption,
  UserClarificationResponse,
  UserClarificationRuntimeState,
} from "@step-cli/protocol";
import {
  parseClarificationAnswer,
  formatClarificationOption,
  clarificationAllowsFreeform,
  normalizeUserClarificationRequest,
  buildClarificationHelpLines,
  cloneUserClarificationResponse,
  cloneUserClarificationRuntimeState,
  isUserClarificationRuntimeState,
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

    it("treats uppercase CANCEL as cancel", () => {
      const result = parseClarificationAnswer(makeRequest(), "CANCEL");
      expect(result.kind).toBe("cancel");
    });

    it("treats uppercase HELP as help", () => {
      const result = parseClarificationAnswer(makeRequest(), "HELP");
      expect(result.kind).toBe("help");
    });

    it("falls through to freeform when request has no options at all", () => {
      const result = parseClarificationAnswer(
        makeRequest({ options: undefined }),
        "anything goes",
      );
      expect(result.kind).toBe("answer");
      if (result.kind === "answer") {
        expect(result.response.source).toBe("freeform");
        expect(result.response.answer).toBe("anything goes");
      }
    });

    it("returns invalid for empty option list with freeform disabled", () => {
      const result = parseClarificationAnswer(
        makeRequest({ options: undefined, allowFreeform: false }),
        "anything",
      );
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.message).toContain("disabled");
      }
    });

    it("matches option by value when value differs from label", () => {
      const result = parseClarificationAnswer(makeRequest(), "REFACTOR");
      expect(result.kind).toBe("answer");
      if (result.kind === "answer") {
        expect(result.response.source).toBe("option");
        expect(result.response.answer).toBe("refactor");
      }
    });

    it("does not match numeric zero (out of 1-based range) and uses freeform", () => {
      const result = parseClarificationAnswer(makeRequest(), "0");
      expect(result.kind).toBe("answer");
      if (result.kind === "answer") {
        expect(result.response.source).toBe("freeform");
        expect(result.response.answer).toBe("0");
      }
    });
  });

  // ---- buildClarificationHelpLines ----

  describe("buildClarificationHelpLines", () => {
    it("lists number/label/value and freeform when options exist and freeform allowed", () => {
      const lines = buildClarificationHelpLines({
        question: "q?",
        options: [{ label: "A", value: "a" }],
      });
      expect(lines[0]).toBe(
        "Accepted input: number / label / value / freeform text",
      );
      expect(lines).toContain("Type cancel or c to abort the clarification.");
      expect(lines).toContain("Type ? or help to repeat these instructions.");
    });

    it("omits freeform text when freeform disabled but options exist", () => {
      const lines = buildClarificationHelpLines({
        question: "q?",
        options: [{ label: "A", value: "a" }],
        allowFreeform: false,
      });
      expect(lines[0]).toBe("Accepted input: number / label / value");
    });

    it("shows only freeform text when no options exist", () => {
      const lines = buildClarificationHelpLines({ question: "q?" });
      expect(lines[0]).toBe("Accepted input: freeform text");
    });

    it("falls back to default accepted-input line when nothing accepted", () => {
      const lines = buildClarificationHelpLines({
        question: "q?",
        options: [],
        allowFreeform: false,
      });
      expect(lines[0]).toBe("Accepted input: freeform text");
    });
  });

  // ---- cloneUserClarificationResponse ----

  describe("cloneUserClarificationResponse", () => {
    it("clones a cancelled response", () => {
      const response: UserClarificationResponse = {
        cancelled: true,
        reason: "nope",
      };
      const clone = cloneUserClarificationResponse(response);
      expect(clone).toEqual({ cancelled: true, reason: "nope" });
      expect(clone).not.toBe(response);
    });

    it("clones a freeform answer without matchedOption", () => {
      const response: UserClarificationResponse = {
        cancelled: false,
        answer: "hello",
        source: "freeform",
      };
      const clone = cloneUserClarificationResponse(response);
      expect(clone).toEqual({
        cancelled: false,
        answer: "hello",
        source: "freeform",
        matchedOption: undefined,
      });
    });

    it("deep-clones the matchedOption for option answers", () => {
      const option: UserClarificationOption = { label: "A", value: "a" };
      const response: UserClarificationResponse = {
        cancelled: false,
        answer: "a",
        source: "option",
        matchedOption: option,
      };
      const clone = cloneUserClarificationResponse(response);
      if (!clone.cancelled) {
        expect(clone.matchedOption).toEqual(option);
        expect(clone.matchedOption).not.toBe(option);
      }
    });
  });

  // ---- cloneUserClarificationRuntimeState ----

  describe("cloneUserClarificationRuntimeState", () => {
    function makeState(
      overrides: Partial<UserClarificationRuntimeState> = {},
    ): UserClarificationRuntimeState {
      return {
        maxPerTurn: 3,
        usedThisTurn: 1,
        remainingThisTurn: 2,
        totalRequests: 5,
        pending: null,
        history: [],
        ...overrides,
      };
    }

    it("clones a state with null pending and empty history", () => {
      const state = makeState();
      const clone = cloneUserClarificationRuntimeState(state);
      expect(clone).toEqual(state);
      expect(clone).not.toBe(state);
      expect(clone.history).not.toBe(state.history);
    });

    it("deep-clones pending and history entries", () => {
      const state = makeState({
        pending: {
          id: "p1",
          requestedAt: "2026-01-01T00:00:00Z",
          request: {
            question: "q?",
            allowFreeform: true,
            options: [{ label: "A", value: "a" }],
          },
        },
        history: [
          {
            id: "h1",
            requestedAt: "2026-01-01T00:00:00Z",
            completedAt: "2026-01-01T00:01:00Z",
            request: { question: "old?", allowFreeform: false },
            response: {
              cancelled: false,
              answer: "a",
              source: "option",
              matchedOption: { label: "A", value: "a" },
            },
          },
        ],
      });
      const clone = cloneUserClarificationRuntimeState(state);
      expect(clone.pending).toEqual(state.pending);
      expect(clone.pending).not.toBe(state.pending);
      expect(clone.history[0]).toEqual(state.history[0]);
      expect(clone.history[0]).not.toBe(state.history[0]);
    });
  });

  // ---- isUserClarificationRuntimeState ----

  describe("isUserClarificationRuntimeState", () => {
    const validState: UserClarificationRuntimeState = {
      maxPerTurn: 3,
      usedThisTurn: 1,
      remainingThisTurn: 2,
      totalRequests: 5,
      pending: null,
      history: [],
    };

    it("accepts a valid state", () => {
      expect(isUserClarificationRuntimeState(validState)).toBe(true);
    });

    it("accepts a valid state with pending and history", () => {
      const state: UserClarificationRuntimeState = {
        ...validState,
        pending: {
          id: "p1",
          requestedAt: "ts",
          request: { question: "q?", allowFreeform: true },
        },
        history: [
          {
            id: "h1",
            requestedAt: "ts",
            completedAt: "ts2",
            request: {
              question: "q?",
              allowFreeform: false,
              reason: "because",
              options: [{ label: "A", value: "a" }],
            },
            response: { cancelled: true, reason: "x" },
          },
        ],
      };
      expect(isUserClarificationRuntimeState(state)).toBe(true);
    });

    it("rejects non-objects", () => {
      expect(isUserClarificationRuntimeState(null)).toBe(false);
      expect(isUserClarificationRuntimeState(undefined)).toBe(false);
      expect(isUserClarificationRuntimeState("x")).toBe(false);
      expect(isUserClarificationRuntimeState([])).toBe(false);
    });

    it("rejects negative or non-integer counters", () => {
      expect(
        isUserClarificationRuntimeState({ ...validState, maxPerTurn: -1 }),
      ).toBe(false);
      expect(
        isUserClarificationRuntimeState({ ...validState, usedThisTurn: 1.5 }),
      ).toBe(false);
      expect(
        isUserClarificationRuntimeState({
          ...validState,
          remainingThisTurn: "2",
        }),
      ).toBe(false);
      expect(
        isUserClarificationRuntimeState({ ...validState, totalRequests: NaN }),
      ).toBe(false);
    });

    it("rejects an invalid pending object", () => {
      expect(
        isUserClarificationRuntimeState({
          ...validState,
          pending: { id: 1, requestedAt: "ts", request: {} },
        }),
      ).toBe(false);
    });

    it("rejects when history is not an array", () => {
      expect(
        isUserClarificationRuntimeState({ ...validState, history: "nope" }),
      ).toBe(false);
    });

    it("rejects when a history entry is malformed", () => {
      expect(
        isUserClarificationRuntimeState({
          ...validState,
          history: [{ id: "h1" }],
        }),
      ).toBe(false);
    });

    it("rejects history entry whose request is invalid", () => {
      expect(
        isUserClarificationRuntimeState({
          ...validState,
          history: [
            {
              id: "h1",
              requestedAt: "ts",
              completedAt: "ts2",
              request: { question: 5, allowFreeform: true },
              response: { cancelled: true },
            },
          ],
        }),
      ).toBe(false);
    });

    it("rejects history entry whose response is invalid", () => {
      expect(
        isUserClarificationRuntimeState({
          ...validState,
          history: [
            {
              id: "h1",
              requestedAt: "ts",
              completedAt: "ts2",
              request: { question: "q?", allowFreeform: true },
              response: { cancelled: false, answer: "a", source: "bogus" },
            },
          ],
        }),
      ).toBe(false);
    });

    it("rejects request with non-string reason", () => {
      expect(
        isUserClarificationRuntimeState({
          ...validState,
          pending: {
            id: "p1",
            requestedAt: "ts",
            request: { question: "q?", allowFreeform: true, reason: 7 },
          },
        }),
      ).toBe(false);
    });

    it("rejects request with malformed options entries", () => {
      expect(
        isUserClarificationRuntimeState({
          ...validState,
          pending: {
            id: "p1",
            requestedAt: "ts",
            request: {
              question: "q?",
              allowFreeform: true,
              options: [{ label: "A" }],
            },
          },
        }),
      ).toBe(false);
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
