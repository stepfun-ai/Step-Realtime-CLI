import { describe, it, expect } from "vitest";
import type {
  ChatMessage,
  AssistantMessage,
  ToolMessage,
} from "@step-cli/protocol";
import { repairIncompleteToolCalls } from "./tool-call-repair.js";

// ---------------------------------------------------------------------------
// tool-call-repair
// ---------------------------------------------------------------------------

describe("tool-call-repair", () => {
  describe("repairIncompleteToolCalls", () => {
    it("returns empty array for empty input", () => {
      const result = repairIncompleteToolCalls([]);
      expect(result.messages).toEqual([]);
      expect(result.inserted).toBe(0);
      expect(result.insertions).toEqual([]);
    });

    it("passes through all messages when everything is intact", () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "fn", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "result", name: "fn", tool_call_id: "c1" },
        { role: "assistant", content: "done" },
      ];
      const result = repairIncompleteToolCalls(messages);
      expect(result.messages).toHaveLength(5);
      expect(result.inserted).toBe(0);
      expect(result.insertions).toEqual([]);
    });

    it("inserts synthetic assistant before orphaned tool messages at start", () => {
      const messages: ChatMessage[] = [
        { role: "tool", content: "result", name: "fn", tool_call_id: "c1" },
        { role: "assistant", content: "done" },
      ];
      const result = repairIncompleteToolCalls(messages);
      // Should have: [synthetic_assistant, tool_message, assistant]
      expect(result.messages).toHaveLength(3);
      expect(result.messages[0]!.role).toBe("assistant");
      expect(result.inserted).toBe(1);
      expect(result.insertions[0]!.position).toBe("before");
      expect(result.insertions[0]!.index).toBe(0);

      // Synthetic assistant should have tool_calls matching the orphaned tool messages
      const synthAssistant = result.messages[0] as AssistantMessage;
      expect(synthAssistant.tool_calls).toHaveLength(1);
      expect(synthAssistant.tool_calls![0]!.id).toBe("c1");
      expect(synthAssistant.tool_calls![0]!.function.name).toBe("fn");
    });

    it("inserts synthetic tool results for missing tool results", () => {
      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "fn", arguments: "{}" },
            },
            {
              id: "c2",
              type: "function",
              function: { name: "fn2", arguments: "{}" },
            },
          ],
        },
        // Only c1 has a tool result, c2 is missing
        { role: "tool", content: "result", name: "fn", tool_call_id: "c1" },
        { role: "user", content: "next" },
      ];
      const result = repairIncompleteToolCalls(messages);
      // assistant, tool(c1), synthetic_tool(c2), user
      expect(result.messages).toHaveLength(4);
      expect(result.inserted).toBe(1);
      expect(result.insertions[0]!.position).toBe("after");

      const synthTool = result.messages[2] as ToolMessage;
      expect(synthTool.role).toBe("tool");
      expect(synthTool.tool_call_id).toBe("c2");
      expect(synthTool.name).toBe("fn2");
      // Should contain the synthetic error marker
      const parsed = JSON.parse(synthTool.content);
      expect(parsed.ok).toBe(false);
      expect(parsed.synthetic_tool_result).toBe(true);
    });

    it("handles partially resolved tool_calls", () => {
      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "fn1", arguments: "{}" },
            },
            {
              id: "c2",
              type: "function",
              function: { name: "fn2", arguments: "{}" },
            },
            {
              id: "c3",
              type: "function",
              function: { name: "fn3", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "result1", name: "fn1", tool_call_id: "c1" },
        // c2 missing
        { role: "tool", content: "result3", name: "fn3", tool_call_id: "c3" },
      ];
      const result = repairIncompleteToolCalls(messages);
      // assistant, tool(c1), tool(c3), synthetic_tool(c2)
      expect(result.messages).toHaveLength(4);
      expect(result.inserted).toBe(1);

      const synthTool = result.messages[3] as ToolMessage;
      expect(synthTool.tool_call_id).toBe("c2");
    });

    it("handles mixed scenario with orphaned tools and missing results", () => {
      const messages: ChatMessage[] = [
        // orphaned tool at start
        { role: "tool", content: "orphan", name: "fnX", tool_call_id: "cX" },
        // assistant with tool_call missing result
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "fn1", arguments: "{}" },
            },
          ],
        },
        // no tool result for c1
        { role: "user", content: "follow-up" },
      ];
      const result = repairIncompleteToolCalls(messages);
      // synthetic_assistant(for orphan), tool(orphan), assistant, synthetic_tool(c1), user
      expect(result.messages).toHaveLength(5);
      expect(result.inserted).toBe(2);
    });

    it("passes through system and user messages unchanged", () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "You are a helper." },
        { role: "user", content: "hello" },
      ];
      const result = repairIncompleteToolCalls(messages);
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]).toEqual({
        role: "system",
        content: "You are a helper.",
      });
      expect(result.messages[1]).toEqual({ role: "user", content: "hello" });
      expect(result.inserted).toBe(0);
    });

    it("handles multiple consecutive orphaned tool messages", () => {
      const messages: ChatMessage[] = [
        { role: "tool", content: "r1", name: "fn1", tool_call_id: "c1" },
        { role: "tool", content: "r2", name: "fn2", tool_call_id: "c2" },
      ];
      const result = repairIncompleteToolCalls(messages);
      // synthetic_assistant (with 2 tool_calls), tool(c1), tool(c2)
      expect(result.messages).toHaveLength(3);
      expect(result.messages[0]!.role).toBe("assistant");
      const synth = result.messages[0] as AssistantMessage;
      expect(synth.tool_calls).toHaveLength(2);
      expect(result.inserted).toBe(1);
    });

    it("handles assistant message without tool_calls", () => {
      const messages: ChatMessage[] = [
        { role: "assistant", content: "just text" },
      ];
      const result = repairIncompleteToolCalls(messages);
      expect(result.messages).toHaveLength(1);
      expect(result.inserted).toBe(0);
    });
  });
});
