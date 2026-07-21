import { describe, it, expect } from "vitest";
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
});
