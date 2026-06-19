import { describe, it, expect } from "vitest";
import { LocalOpenTuiTranscriptBridge } from "./local-opentui-bridge.js";

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

describe("LocalOpenTuiTranscriptBridge streaming order", () => {
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
});
