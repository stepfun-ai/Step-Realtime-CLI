import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@step-cli/protocol";
import {
  selectMessagesWithinWindow,
  alignBoundaryToToolCallGroup,
} from "./context-window.js";

function userMsg(content: string): ChatMessage {
  return { role: "user", content };
}

function assistantMsg(content: string): ChatMessage {
  return { role: "assistant", content };
}

function toolCallAssistant(ids: string[]): ChatMessage {
  return {
    role: "assistant",
    content: "",
    tool_calls: ids.map((id) => ({
      id,
      type: "function" as const,
      function: { name: "tool", arguments: "{}" },
    })),
  };
}

function toolResult(id: string): ChatMessage {
  return { role: "tool", name: "tool", tool_call_id: id, content: "ok" };
}

describe("selectMessagesWithinWindow", () => {
  it("returns empty for empty messages", () => {
    const result = selectMessagesWithinWindow([], 1000, 2);
    expect(result.messages).toEqual([]);
    expect(result.estimatedTokens).toBe(0);
    expect(result.firstIncludedIndex).toBe(0);
    expect(result.omittedTokens).toBe(0);
  });

  it("includes all messages when budget is large", () => {
    const messages = [userMsg("hello"), assistantMsg("world")];
    const result = selectMessagesWithinWindow(messages, 100_000, 1);
    expect(result.messages).toHaveLength(2);
    expect(result.firstIncludedIndex).toBe(0);
  });

  it("enforces minimum budget of 256", () => {
    const messages = [userMsg("a"), assistantMsg("b")];
    const result = selectMessagesWithinWindow(messages, 0, 1);
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
  });

  it("drops older messages when budget is tight", () => {
    const messages = Array.from({ length: 20 }, () => userMsg("x".repeat(200)));
    const result = selectMessagesWithinWindow(messages, 300, 2);
    expect(result.messages.length).toBeLessThan(20);
    expect(result.firstIncludedIndex).toBeGreaterThan(0);
    expect(result.omittedTokens).toBeGreaterThan(0);
  });

  it("respects minTailMessages", () => {
    const messages = [
      userMsg("old"),
      assistantMsg("old reply"),
      userMsg("recent"),
    ];
    const result = selectMessagesWithinWindow(messages, 100_000, 3);
    expect(result.messages).toHaveLength(3);
  });

  it("keeps tool call groups together", () => {
    const messages = [
      userMsg("start"),
      toolCallAssistant(["c1"]),
      toolResult("c1"),
      userMsg("next"),
    ];
    const result = selectMessagesWithinWindow(messages, 100_000, 1);
    expect(result.messages).toHaveLength(4);
  });
});

describe("alignBoundaryToToolCallGroup", () => {
  it("returns 0 for empty messages", () => {
    expect(alignBoundaryToToolCallGroup([], 0)).toBe(0);
  });

  it("does not adjust boundary on user message", () => {
    const messages = [userMsg("a"), assistantMsg("b"), userMsg("c")];
    expect(alignBoundaryToToolCallGroup(messages, 2)).toBe(2);
  });

  it("moves boundary back to include assistant with tool calls", () => {
    const messages = [
      userMsg("start"),
      toolCallAssistant(["c1"]),
      toolResult("c1"),
      userMsg("next"),
    ];
    expect(alignBoundaryToToolCallGroup(messages, 2)).toBe(1);
  });

  it("clamps boundary to valid range", () => {
    const messages = [userMsg("a")];
    expect(alignBoundaryToToolCallGroup(messages, 10)).toBe(1);
    expect(alignBoundaryToToolCallGroup(messages, -5)).toBe(0);
  });
});
