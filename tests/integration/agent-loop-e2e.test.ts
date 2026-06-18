import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { AgentLoop } from "../../packages/core/src/agent/agent-loop.js";
import {
  ConversationMemory,
  type MemoryConfig,
} from "../../packages/core/src/agent/conversation-memory.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "step-e2e-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

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

describe("Agent Loop E2E", () => {
  it("AgentLoop constructor creates a valid instance", () => {
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
      systemPrompt: "You are a helpful assistant.",
      workspaceRoot: tmpDir,
      config: makeConfig(),
    });

    expect(loop).toBeInstanceOf(AgentLoop);
  });

  it("ConversationMemory tracks messages through addUser/addAssistant cycle", () => {
    const memory = new ConversationMemory(makeMemoryConfig());
    memory.addUser("Hello");
    memory.addAssistant("Hi there!");

    const state = memory.exportState();
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]!.role).toBe("user");
    expect(state.messages[1]!.role).toBe("assistant");
  });

  it("ConversationMemory round-trips state through export/load", () => {
    const memory = new ConversationMemory(makeMemoryConfig());
    memory.addUser("prompt");
    memory.addAssistant("response");
    memory.addUser("follow up");
    memory.addAssistant("another response");

    const state = memory.exportState();
    const memory2 = new ConversationMemory(makeMemoryConfig());
    memory2.loadState(state);

    const state2 = memory2.exportState();
    expect(state2.messages).toHaveLength(4);
    expect(state2.messages[0]!.content).toBe("prompt");
  });

  it("ConversationMemory clear resets all state", () => {
    const memory = new ConversationMemory(makeMemoryConfig());
    memory.addUser("test");
    memory.addAssistant("test reply");
    memory.clear();

    const state = memory.exportState();
    expect(state.messages).toHaveLength(0);
    expect(state.summary).toBe("");
  });

  it("ConversationMemory forceCompact compacts old messages", () => {
    const memory = new ConversationMemory(makeMemoryConfig());

    for (let i = 0; i < 20; i++) {
      memory.addUser(`message-${i} ${"x".repeat(100)}`);
      memory.addAssistant(`reply-${i} ${"y".repeat(100)}`);
    }

    const result = memory.forceCompact("test");
    expect(result.compactedMessages).toBeGreaterThan(0);
  });

  it("AgentLoop rejects when signal is already aborted", async () => {
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
      workspaceRoot: tmpDir,
      config: makeConfig(),
      signal: controller.signal,
    });

    await expect(loop.run("test")).rejects.toThrow();
  });

  it("ConversationMemory handles checkpoint round-trip", () => {
    const memory = new ConversationMemory(makeMemoryConfig());
    memory.addUser("goal");

    const state = memory.exportState();
    state.checkpoint = {
      version: 1,
      objective: [{ text: "build feature", status: "still_active" }],
      hardConstraints: [],
      verifiedFacts: [],
      attemptedActions: [],
      openIssues: [],
      nextSteps: [],
      relevantPriors: [],
    };

    const memory2 = new ConversationMemory(makeMemoryConfig());
    memory2.loadState(state);

    const exported = memory2.exportState();
    expect(exported.checkpoint).toBeDefined();
    expect(exported.checkpoint!.objective[0]!.text).toBe("build feature");
  });
});
