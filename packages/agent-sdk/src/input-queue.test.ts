import { describe, it, expect } from "vitest";
import { userTurnTextFromMessage } from "./input-queue.js";
import type { SDKUserMessage } from "./types.js";

describe("userTurnTextFromMessage", () => {
  it("string content returns that string", () => {
    const msg: SDKUserMessage = { role: "user", content: "hello" };
    expect(userTurnTextFromMessage(msg)).toBe("hello");
  });

  it("array of text blocks joined by newline", () => {
    const msg: SDKUserMessage = {
      role: "user",
      content: [
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
        { type: "text", text: "line3" },
      ],
    };
    expect(userTurnTextFromMessage(msg)).toBe("line1\nline2\nline3");
  });

  it("array with no text blocks returns empty string", () => {
    const msg: SDKUserMessage = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "id1", content: "result" }],
    };
    expect(userTurnTextFromMessage(msg)).toBe("");
  });

  it("empty string content returns empty string", () => {
    const msg: SDKUserMessage = { role: "user", content: "" };
    expect(userTurnTextFromMessage(msg)).toBe("");
  });

  it("mixed array with text and non-text blocks only returns text joined", () => {
    const msg: SDKUserMessage = {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "tool_result", tool_use_id: "id1", content: "data" },
        { type: "text", text: "world" },
      ],
    };
    expect(userTurnTextFromMessage(msg)).toBe("hello\nworld");
  });
});
