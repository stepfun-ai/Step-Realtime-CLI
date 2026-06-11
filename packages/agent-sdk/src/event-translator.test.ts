import { describe, it, expect, beforeEach } from "vitest";
import { createEventTranslatorHooks } from "./event-translator.js";
import type { SDKMessage } from "./types.js";

describe("createEventTranslatorHooks", () => {
  let emitted: SDKMessage[];
  let hooks: ReturnType<typeof createEventTranslatorHooks>;

  beforeEach(() => {
    emitted = [];
    hooks = createEventTranslatorHooks({
      sessionId: "test-session",
      emit: (msg) => emitted.push(msg),
      includePartialMessages: true,
    });
  });

  describe("onStateChange", () => {
    it("emits status 'requesting' for model_request state", () => {
      hooks.onStateChange?.({
        state: "model_request",
        step: 1,
        toolCalls: 0,
        at: "",
      });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        type: "system",
        subtype: "status",
        status: "requesting",
        session_id: "test-session",
      });
    });

    it("emits status 'compacting' for context_compaction state", () => {
      hooks.onStateChange?.({
        state: "context_compaction",
        step: 1,
        toolCalls: 0,
        at: "",
      });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        type: "system",
        subtype: "status",
        status: "compacting",
      });
    });

    it("does not emit for other states", () => {
      const otherStates = [
        "goal_start",
        "prepare_context",
        "before_model_request_hooks",
        "tool_execution",
        "apply_tool_results",
        "final_response",
        "failed",
      ] as const;
      for (const state of otherStates) {
        hooks.onStateChange?.({ state, step: 1, toolCalls: 0, at: "" });
      }
      expect(emitted).toHaveLength(0);
    });

    it("does not emit duplicate consecutive statuses", () => {
      hooks.onStateChange?.({
        state: "model_request",
        step: 1,
        toolCalls: 0,
        at: "",
      });
      hooks.onStateChange?.({
        state: "model_request",
        step: 2,
        toolCalls: 0,
        at: "",
      });
      expect(emitted).toHaveLength(1);
    });
  });

  describe("onAssistantMessage", () => {
    it("text content produces a text block", () => {
      hooks.onAssistantMessage?.({
        step: 1,
        message: { role: "assistant", content: "hello world" },
      });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        type: "assistant",
        session_id: "test-session",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello world" }],
        },
      });
    });

    it("tool_calls produce tool_use blocks", () => {
      hooks.onAssistantMessage?.({
        step: 1,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Bash", arguments: '{"command":"ls"}' },
            },
          ],
        },
      });
      // includePartialMessages=true means we also get stream_event + assistant message
      const assistantMsg = emitted.find((m) => m.type === "assistant");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg).toMatchObject({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      });
    });
  });

  describe("onToolResult", () => {
    it("success produces user message with is_error: false", () => {
      hooks.onToolResult?.({
        toolName: "Bash",
        toolCallId: "call_1",
        result: { ok: true, summary: "file1.txt\nfile2.txt" },
      });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        type: "user",
        session_id: "test-session",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              is_error: false,
              content: "file1.txt\nfile2.txt",
            },
          ],
        },
      });
    });

    it("failure produces user message with is_error: true", () => {
      hooks.onToolResult?.({
        toolName: "Bash",
        toolCallId: "call_2",
        result: {
          ok: false,
          summary: "command failed",
          error: { code: "EXIT_1", message: "command failed" },
        },
      });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_2",
              is_error: true,
              content: "command failed",
            },
          ],
        },
      });
    });

    it("throws if toolCallId is missing", () => {
      expect(() =>
        hooks.onToolResult?.({
          toolName: "Bash",
          toolCallId: "" as string,
          result: { ok: true, summary: "" },
        }),
      ).toThrow("toolCallId");
    });
  });

  describe("onModelTextDelta", () => {
    it("emits text_delta when includePartialMessages is true", () => {
      hooks.onModelTextDelta?.({ step: 1, text: "hello" });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        type: "stream_event",
        session_id: "test-session",
        event: { type: "text_delta", text: "hello" },
      });
    });

    it("does nothing when includePartialMessages is false", () => {
      const hooksNoPartial = createEventTranslatorHooks({
        sessionId: "test-session",
        emit: (msg) => emitted.push(msg),
        includePartialMessages: false,
      });
      hooksNoPartial.onModelTextDelta?.({ step: 1, text: "hello" });
      expect(emitted).toHaveLength(0);
    });
  });
});
