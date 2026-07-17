import { describe, it, expect, vi } from "vitest";
import type { SystemMessage } from "@step-cli/protocol";
import {
  ConversationMemory,
  type MemoryConfig,
} from "./conversation-memory.js";

function makeConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
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
    ...overrides,
  };
}

describe("ConversationMemory", () => {
  describe("addUser / addAssistant / addTool", () => {
    it("stores user and assistant messages in order", () => {
      const memory = new ConversationMemory(makeConfig());
      memory.addUser("hello");
      memory.addAssistant("hi there");

      const state = memory.exportState();
      expect(state.messages).toHaveLength(2);
      expect(state.messages[0]!.role).toBe("user");
      expect(state.messages[1]!.role).toBe("assistant");
    });

    it("stores tool result messages", () => {
      const memory = new ConversationMemory(makeConfig());
      memory.addAssistant("", [
        {
          id: "call-1",
          type: "function",
          function: { name: "Read", arguments: "{}" },
        },
      ]);
      memory.addTool("call-1", "Read", "file contents");

      const state = memory.exportState();
      expect(state.messages).toHaveLength(2);
      expect(state.messages[1]!.role).toBe("tool");
    });
  });

  describe("exportState / loadState", () => {
    it("round-trips state correctly", () => {
      const memory = new ConversationMemory(makeConfig());
      memory.addUser("hello");
      memory.addAssistant("world");

      const exported = memory.exportState();
      const memory2 = new ConversationMemory(makeConfig());
      memory2.loadState(exported);

      const exported2 = memory2.exportState();
      expect(exported2.messages).toHaveLength(2);
      expect(exported2.messages[0]!.content).toBe("hello");
    });

    it("exports empty state for fresh memory", () => {
      const memory = new ConversationMemory(makeConfig());
      const state = memory.exportState();
      expect(state.messages).toEqual([]);
      expect(state.summary).toBe("");
      expect(state.summarizedUntil).toBe(0);
    });
  });

  describe("clear", () => {
    it("removes all messages and resets state", () => {
      const memory = new ConversationMemory(makeConfig());
      memory.addUser("a");
      memory.addAssistant("b");
      memory.clear();

      const state = memory.exportState();
      expect(state.messages).toEqual([]);
      expect(state.summary).toBe("");
      expect(state.summarizedUntil).toBe(0);
    });
  });

  describe("addSystem", () => {
    it("stores system message", () => {
      const memory = new ConversationMemory(makeConfig());
      memory.addSystem("system instruction");

      const state = memory.exportState();
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0]!.role).toBe("system");
    });

    it("preserves hidden flag through export/load round-trip", () => {
      const memory = new ConversationMemory(makeConfig());
      memory.addSystem("hidden instruction", { hidden: true });
      memory.addSystem("visible instruction");

      const exported = memory.exportState();
      const memory2 = new ConversationMemory(makeConfig());
      memory2.loadState(exported);

      const restored = memory2.exportState();
      expect(restored.messages).toHaveLength(2);
      expect(restored.messages[0]!.role).toBe("system");
      expect((restored.messages[0]! as SystemMessage).hidden).toBe(true);
      expect(restored.messages[1]!.role).toBe("system");
      expect((restored.messages[1]! as SystemMessage).hidden).toBeUndefined();
    });
  });

  describe("recordDecision", () => {
    it("records decisions in the chain", () => {
      const memory = new ConversationMemory(makeConfig());
      memory.recordDecision("chose approach A");

      const state = memory.exportState();
      expect(state.decisionChain.length).toBeGreaterThanOrEqual(1);
      expect(state.decisionChain).toContain("chose approach A");
    });

    it("deduplicates consecutive identical decisions", () => {
      const memory = new ConversationMemory(makeConfig());
      memory.recordDecision("same decision");
      memory.recordDecision("same decision");

      const state = memory.exportState();
      const count = state.decisionChain.filter(
        (d) => d === "same decision",
      ).length;
      expect(count).toBe(1);
    });

    it("ignores empty decisions", () => {
      const memory = new ConversationMemory(makeConfig());
      memory.recordDecision("");

      const state = memory.exportState();
      expect(state.decisionChain).toEqual([]);
    });
  });

  describe("forceCompact", () => {
    it("returns zero compacted for few messages", () => {
      const memory = new ConversationMemory(makeConfig());
      memory.addUser("short");
      const result = memory.forceCompact();
      expect(result.compactedMessages).toBe(0);
    });

    it("compacts old messages when enough exist", () => {
      const memory = new ConversationMemory(
        makeConfig({ minRecentMessages: 2 }),
      );
      for (let i = 0; i < 20; i++) {
        memory.addUser(`message-${i}`);
        memory.addAssistant(`reply-${i}`);
      }

      const result = memory.forceCompact("test");
      expect(result.compactedMessages).toBeGreaterThan(0);
    });
  });

  describe("loadState with checkpoint", () => {
    it("preserves checkpoint through state round-trip", () => {
      const memory = new ConversationMemory(makeConfig());
      memory.addUser("test");

      const state = memory.exportState();
      state.checkpoint = {
        version: 1,
        objective: [{ text: "build tests", status: "still_active" }],
        hardConstraints: [],
        verifiedFacts: [],
        attemptedActions: [],
        openIssues: [],
        nextSteps: [],
        relevantPriors: [],
      };

      const memory2 = new ConversationMemory(makeConfig());
      memory2.loadState(state);

      const exported = memory2.exportState();
      expect(exported.checkpoint).toBeDefined();
      expect(exported.checkpoint!.objective).toHaveLength(1);
    });
  });

  describe("context assembly and recovery", () => {
    it("repairs unmatched tool calls before exporting context", () => {
      const memory = new ConversationMemory(makeConfig());
      memory.addAssistant("", [
        {
          id: "call-1",
          type: "function",
          function: { name: "Read", arguments: "{}" },
        },
      ]);
      expect(memory.repairIncompleteToolCalls()).toBe(1);
      expect(memory.exportMessages()).toMatchObject([
        { role: "assistant" },
        { role: "tool", tool_call_id: "call-1" },
      ]);
    });

    it("builds an assembly, compacts oversized tool output, and exposes usage", () => {
      const memory = new ConversationMemory(
        makeConfig({
          maxContextTokens: 300,
          reserveOutputTokens: 50,
          minRecentMessages: 1,
          microCompactKeepRecentToolMessages: 0,
          microCompactToolContentChars: 20,
        }),
      );
      memory.addUser("task");
      memory.addAssistant("", [
        {
          id: "c1",
          type: "function",
          function: { name: "Bash", arguments: "{}" },
        },
        {
          id: "c2",
          type: "function",
          function: { name: "Bash", arguments: "{}" },
        },
      ]);
      memory.addTool("c1", "Bash", "x".repeat(500));
      memory.addTool("c2", "Bash", "y".repeat(500));
      const assembled = memory.buildContextWithAssembly("system");
      expect(assembled.messages[0]).toMatchObject({ role: "system" });
      expect(memory.getLastContextAssembly()).toEqual(assembled.assembly);
      expect(memory.getLastContextUsage().selectedMessages).toBeGreaterThan(0);
      expect(memory.getStats().compactedToolMessages).toBeGreaterThan(0);
    });

    it("reports repeated context-rot issues and saves a fresh-attempt checkpoint", async () => {
      const transcriptStore = {
        save: vi
          .fn()
          .mockResolvedValue({ transcriptPath: "/tmp/transcript.jsonl" }),
      };
      const progressStore = {
        save: vi.fn().mockResolvedValue("/tmp/progress.md"),
      };
      const memory = new ConversationMemory(makeConfig(), {
        sessionId: "session",
        transcriptStore: transcriptStore as never,
        progressStore,
      });
      for (let index = 0; index < 3; index += 1) {
        memory.addTool(
          `call-${index}`,
          "Bash",
          JSON.stringify({
            ok: false,
            summary: "same failure",
            error: { code: "EFAIL", message: "same failure" },
          }),
        );
      }
      const report = memory.getContextRotReport();
      expect(report.shouldRestart).toBe(true);
      const checkpoint = await memory.prepareFreshAttempt({
        workspaceRoot: "/workspace",
        reason: "repeated failure",
        repeatedIssue: report.repeatedIssue,
      });
      expect(checkpoint.progressPath).toBe("/tmp/progress.md");
      expect(checkpoint.summary).toContain("Progress file");
      expect(memory.exportState().messages).toEqual([]);
    });

    it("degrades gracefully when stores fail and smart compaction is within budget or aborted", async () => {
      const memory = new ConversationMemory(makeConfig(), {
        transcriptStore: {
          save: vi.fn().mockRejectedValue(new Error("disk")),
        } as never,
        progressStore: { save: vi.fn().mockRejectedValue(new Error("disk")) },
      });
      memory.addUser("small");
      const skipped = await memory.smartCompactIfNeeded({
        systemPrompt: "system",
        model: "model",
        workspaceRoot: "/workspace",
        client: { countPromptTokens: vi.fn().mockResolvedValue(1) } as never,
      });
      expect(skipped).toMatchObject({
        compacted: false,
        reason: "within_budget",
      });
      const checkpoint = await memory.prepareFreshAttempt({
        workspaceRoot: "/workspace",
        reason: "disk failure",
      });
      expect(checkpoint.progressPath).toBeUndefined();
      const ac = new AbortController();
      ac.abort();
      await expect(
        memory.smartCompactIfNeeded({
          systemPrompt: "system",
          model: "model",
          workspaceRoot: "/workspace",
          signal: ac.signal,
          client: { countPromptTokens: vi.fn() } as never,
        }),
      ).rejects.toThrow();
    });
  });
});
