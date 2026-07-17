import { describe, expect, it } from "vitest";
import { LocalOpenTuiTranscriptBridge } from "./local-opentui-bridge.js";
import type { ChatMessage } from "@step-cli/protocol";

function createBridge(): LocalOpenTuiTranscriptBridge {
  return new LocalOpenTuiTranscriptBridge();
}

function createUiFactoryInput(): Parameters<
  ReturnType<LocalOpenTuiTranscriptBridge["createInteractiveUiFactory"]>
>[0] {
  return {
    workspaceRoot: "/tmp",
    model: "test-model",
    provider: "test-provider",
    approvalMode: "interactive",
    nonInteractiveApproval: "deny",
    maxContextTokens: 8192,
    sessionSummary: "",
    pluginIds: [],
    commands: [],
    delegationPresetNames: [],
    useAlternateScreen: true,
    workspaceTrusted: true,
    activeTeammateName: null,
    getTeammateSnapshot: () => null,
    getTeammateSummary: () => null,
    onInterrupt: async () => false,
    onOpenTeammate: async () => false,
    onInterruptTeammate: async () => false,
    onTrustWorkspace: async () => {},
    onSubmit: async () => "continue" as const,
  };
}

describe("LocalOpenTuiTranscriptBridge", () => {
  describe("reconcileWithSessionMessages with reasoning", () => {
    it("splits assistant messages with reasoning into two entries", () => {
      const bridge = createBridge();
      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: "Final answer.",
          reasoning: "First I thought about X.\nThen I considered Y.",
        },
      ];

      bridge.reconcileWithSessionMessages(messages);
      const entries = bridge.getEntries();

      expect(entries).toHaveLength(2);
      expect(entries[0]?.role).toBe("reasoning");
      expect(entries[0]?.content).toBe(
        "First I thought about X.\nThen I considered Y.",
      );
      expect(entries[1]?.role).toBe("assistant");
      expect(entries[1]?.content).toBe("Final answer.");
    });

    it("keeps a single assistant entry when there is no reasoning", () => {
      const bridge = createBridge();
      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: "Just the answer.",
        },
      ];

      bridge.reconcileWithSessionMessages(messages);
      const entries = bridge.getEntries();

      expect(entries).toHaveLength(1);
      expect(entries[0]?.role).toBe("assistant");
      expect(entries[0]?.content).toBe("Just the answer.");
    });

    it("uses reasoning_content over reasoning when both are present", () => {
      const bridge = createBridge();
      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: "Answer.",
          reasoning: "Old reasoning.",
          reasoning_content: "New reasoning.\nMore details.",
        },
      ];

      bridge.reconcileWithSessionMessages(messages);
      const entries = bridge.getEntries();

      expect(entries).toHaveLength(2);
      expect(entries[0]?.role).toBe("reasoning");
      expect(entries[0]?.content).toBe("New reasoning.\nMore details.");
    });

    it("ignores empty reasoning fields", () => {
      const bridge = createBridge();
      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: "Answer.",
          reasoning: "   ",
        },
      ];

      bridge.reconcileWithSessionMessages(messages);
      const entries = bridge.getEntries();

      expect(entries).toHaveLength(1);
      expect(entries[0]?.role).toBe("assistant");
    });

    it("returns only the reasoning entry when assistant content is empty", () => {
      const bridge = createBridge();
      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: "",
          reasoning: "Planning the next tool call.",
        },
      ];

      bridge.reconcileWithSessionMessages(messages);
      const entries = bridge.getEntries();

      expect(entries).toHaveLength(1);
      expect(entries[0]?.role).toBe("reasoning");
      expect(entries[0]?.content).toBe("Planning the next tool call.");
    });
  });

  describe("streaming order", () => {
    it("marks Markdown entries as streaming until the final assistant message", () => {
      const bridge = createBridge();
      const ui = bridge.createInteractiveUiFactory()(createUiFactoryInput());

      bridge.submitUserTurn({ content: "hello" });
      ui.onModelStreamReset();
      ui.onModelTextDelta({ text: "```ts" });

      expect(bridge.getEntries().at(-1)?.streaming).toBe(true);

      ui.onAssistantMessage({ text: "```ts\nconst answer = 42;\n```" });

      expect(bridge.getEntries().at(-1)?.streaming).toBe(false);
    });

    it("keeps tool-call entries after the assistant text that triggered them", () => {
      const bridge = createBridge();
      const ui = bridge.createInteractiveUiFactory()(createUiFactoryInput());

      bridge.submitUserTurn({ content: "hello" });

      ui.onModelStreamReset();
      ui.onModelTextDelta({ text: "Let me search" });
      ui.onModelToolCall({ toolName: "search", rawArgs: '{"q":"x"}' });
      ui.onAssistantMessage({ text: "Let me search" });

      const entries = bridge.getEntries();
      const roles = entries.map((entry) => entry.role);

      expect(roles).toEqual(["user", "assistant", "tool"]);
    });

    it("creates a new assistant entry after a tool call when more text streams in", () => {
      const bridge = createBridge();
      const ui = bridge.createInteractiveUiFactory()(createUiFactoryInput());

      bridge.submitUserTurn({ content: "hello" });

      ui.onModelStreamReset();
      ui.onModelTextDelta({ text: "Before tool. " });
      ui.onModelToolCall({ toolName: "read_file", rawArgs: '{"path":"x"}' });
      ui.onModelTextDelta({ text: "After tool." });
      ui.onAssistantMessage({ text: "Before tool. After tool." });

      const entries = bridge.getEntries();
      const roles = entries.map((entry) => entry.role);

      // The streaming text after the tool call should not be merged into the
      // pre-tool assistant entry.
      expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
    });

    it("commits final assistant text to the streaming entry even after tool-call reset", () => {
      const bridge = createBridge();
      const ui = bridge.createInteractiveUiFactory()(createUiFactoryInput());

      bridge.submitUserTurn({ content: "hello" });

      ui.onModelStreamReset();
      ui.onModelTextDelta({ text: "Streaming text" });
      ui.onModelToolCall({ toolName: "search", rawArgs: "{}" });
      ui.onAssistantMessage({ text: "Final text" });

      const entries = bridge.getEntries();
      const assistantEntries = entries.filter(
        (entry) => entry.role === "assistant",
      );

      expect(assistantEntries).toHaveLength(1);
      expect(assistantEntries[0]?.content).toBe("Final text");
    });

    it("handles multiple consecutive tool calls without creating duplicate assistant entries", () => {
      const bridge = createBridge();
      const ui = bridge.createInteractiveUiFactory()(createUiFactoryInput());

      bridge.submitUserTurn({ content: "hello" });

      ui.onModelStreamReset();
      ui.onModelTextDelta({ text: "Use tools" });
      ui.onModelToolCall({ toolName: "tool_a", rawArgs: "{}" });
      ui.onModelToolCall({ toolName: "tool_b", rawArgs: "{}" });
      ui.onAssistantMessage({ text: "Use tools" });

      const entries = bridge.getEntries();
      const roles = entries.map((entry) => entry.role);

      expect(roles).toEqual(["user", "assistant", "tool", "tool"]);
    });

    it("resets streaming state between separate model requests", () => {
      const bridge = createBridge();
      const ui = bridge.createInteractiveUiFactory()(createUiFactoryInput());

      bridge.submitUserTurn({ content: "hello" });

      // First step
      ui.onModelStreamReset();
      ui.onModelTextDelta({ text: "First step." });
      ui.onModelToolCall({ toolName: "search", rawArgs: "{}" });
      ui.onAssistantMessage({ text: "First step." });

      // Tool execution
      ui.onToolStart({ toolName: "search", rawArgs: "{}" });
      ui.onToolResult({
        toolName: "search",
        toolCallId: "c1",
        result: { ok: true, summary: "done" },
      });

      // Second step
      ui.onModelStreamReset();
      ui.onModelTextDelta({ text: "Second step." });
      ui.onAssistantMessage({ text: "Second step." });

      const entries = bridge.getEntries();
      const roles = entries.map((entry) => entry.role);

      expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
    });

    it("preserves user entries across multiple turns without tool calls", () => {
      const bridge = createBridge();
      const ui = bridge.createInteractiveUiFactory()(createUiFactoryInput());

      // Turn 1
      bridge.submitUserTurn({ content: "介绍一下这个项目" });
      ui.onModelStreamReset();
      ui.onModelTextDelta({ text: "这是 Step Realtime CLI 项目。" });
      ui.onAssistantMessage({ text: "这是 Step Realtime CLI 项目。" });
      ui.endRun(true);

      // Turn 2
      bridge.submitUserTurn({ content: "你刚才做了什么" });
      ui.onModelStreamReset();
      ui.onModelTextDelta({ text: "我刚才读取了 README。" });
      ui.onAssistantMessage({ text: "我刚才读取了 README。" });
      ui.endRun(true);

      const entries = bridge.getEntries();
      const roles = entries.map((entry) => entry.role);
      const contents = entries.map((entry) => entry.content);

      expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
      expect(contents).toContain("介绍一下这个项目");
      expect(contents).toContain("你刚才做了什么");
    });

    it("does not leave an orphaned pre-tool fragment after settle", () => {
      const bridge = createBridge();
      const ui = bridge.createInteractiveUiFactory()(createUiFactoryInput());

      const turnId = bridge.submitUserTurn({ content: "hello" });

      ui.onModelStreamReset();
      ui.onModelTextDelta({ text: "Before tool. " });
      ui.onModelToolCall({ toolName: "read_file", rawArgs: '{"path":"x"}' });
      ui.onModelTextDelta({ text: "After tool." });
      ui.onAssistantMessage({ text: "Before tool. After tool." });

      ui.endRun(true);

      // Settle the turn with the authoritative session message.
      bridge.reconcileWithSessionMessages(
        [
          {
            role: "assistant",
            content: "Before tool. After tool.",
          },
        ],
        turnId,
      );

      const entries = bridge.getEntries();
      const assistantContents = entries
        .filter((entry) => entry.role === "assistant")
        .map((entry) => entry.content);

      expect(assistantContents).toEqual(["Before tool. After tool."]);
    });
  });
});
