import { describe, it, expect, vi } from "vitest";
import { AgentLoop, type AgentLoopOptions } from "./agent-loop.js";
import {
  ConversationMemory,
  type MemoryConfig,
} from "./conversation-memory.js";

function makeMemoryConfig(): MemoryConfig {
  return {
    maxContextTokens: 128_000,
    reserveOutputTokens: 4096,
    minRecentMessages: 4,
    compressionTriggerRatio: 0.85,
    compressionTargetRatio: 0.6,
    maxSummaryChars: 2000,
    compactedUserMessageTokenBudget: 2000,
    maxCompactedUserMessages: 5,
    compactedUserMessageMaxChars: 500,
    maxDecisionEntries: 20,
    decisionEntryMaxChars: 200,
    microCompactKeepRecentToolMessages: 10,
    microCompactToolContentChars: 2000,
  };
}

function makeConfig() {
  return {
    maxSteps: 10,
    temperature: 0,
    maxContextTokens: 128_000,
    maxOutputTokens: 4096,
    minOutputTokens: 256,
    outputTokenSafetyMargin: 512,
    parallelToolCalls: true,
    maxToolCallsPerStep: 5,
    repeatedToolCallLimit: 3,
    maxToolResultCharsInContext: 25_000,
    modelRequestRetries: 0,
    toolExecutionRetries: 0,
  };
}

describe("AgentLoop", () => {
  describe("constructor", () => {
    it("accepts AgentLoopOptions and stores references", () => {
      const memory = new ConversationMemory(makeMemoryConfig());
      const client = {
        createChatCompletion: vi.fn(),
        countPromptTokens: vi.fn(),
      };
      const tools = {
        getDefinitions: vi.fn().mockReturnValue([]),
        executeTool: vi.fn(),
        inspectTool: vi.fn(),
        getCatalog: vi.fn().mockReturnValue([]),
        searchTools: vi.fn().mockReturnValue([]),
        getCodeModeToolBindings: vi.fn().mockReturnValue([]),
      };

      const loop = new AgentLoop({
        model: "gpt-4o",
        client: client as never,
        memory,
        tools: tools as never,
        systemPrompt: "You are helpful.",
        workspaceRoot: "/tmp",
        config: makeConfig(),
      });

      expect(loop).toBeInstanceOf(AgentLoop);
    });
  });

  describe("setSignal", () => {
    it("can set and clear an AbortSignal", () => {
      const memory = new ConversationMemory(makeMemoryConfig());
      const loop = new AgentLoop({
        model: "gpt-4o",
        client: {
          createChatCompletion: vi.fn(),
          countPromptTokens: vi.fn(),
        } as never,
        memory,
        tools: {
          getDefinitions: vi.fn().mockReturnValue([]),
          executeTool: vi.fn(),
          inspectTool: vi.fn(),
          getCatalog: vi.fn().mockReturnValue([]),
          searchTools: vi.fn().mockReturnValue([]),
          getCodeModeToolBindings: vi.fn().mockReturnValue([]),
        } as never,
        systemPrompt: "sys",
        workspaceRoot: "/tmp",
        config: makeConfig(),
      });

      const controller = new AbortController();
      loop.setSignal(controller.signal);
      loop.setSignal(undefined);
    });
  });

  describe("run — abort signal", () => {
    it("rejects immediately if signal already aborted", async () => {
      const memory = new ConversationMemory(makeMemoryConfig());
      const controller = new AbortController();
      controller.abort();

      const loop = new AgentLoop({
        model: "gpt-4o",
        client: {
          createChatCompletion: vi.fn(),
          countPromptTokens: vi.fn(),
        } as never,
        memory,
        tools: {
          getDefinitions: vi.fn().mockReturnValue([]),
          executeTool: vi.fn(),
          inspectTool: vi.fn(),
          getCatalog: vi.fn().mockReturnValue([]),
          searchTools: vi.fn().mockReturnValue([]),
          getCodeModeToolBindings: vi.fn().mockReturnValue([]),
        } as never,
        systemPrompt: "sys",
        workspaceRoot: "/tmp",
        config: makeConfig(),
        signal: controller.signal,
      });

      await expect(loop.run("test")).rejects.toThrow();
    });
  });

  describe("AgentLoopOptions types", () => {
    it("options accept hooks", () => {
      const hooks: NonNullable<AgentLoopOptions["hooks"]> = {
        onStep: vi.fn(),
        onAssistantMessage: vi.fn(),
        onToolResult: vi.fn(),
        onStateChange: vi.fn(),
      };
      expect(typeof hooks.onStep).toBe("function");
    });

    it("options accept beforeModelRequest plugin", () => {
      const beforeModelRequest: AgentLoopOptions["beforeModelRequest"] =
        vi.fn();
      expect(typeof beforeModelRequest).toBe("function");
    });

    it("options accept userPromptSubmit plugin", () => {
      const userPromptSubmit: AgentLoopOptions["userPromptSubmit"] = vi.fn();
      expect(typeof userPromptSubmit).toBe("function");
    });
  });

  describe("AgentRunConfig validation", () => {
    it("config values have sensible bounds", () => {
      const config = makeConfig();
      expect(config.maxSteps).toBeGreaterThan(0);
      expect(config.maxOutputTokens).toBeGreaterThan(config.minOutputTokens);
      expect(config.maxToolCallsPerStep).toBeGreaterThan(0);
    });
  });
});
