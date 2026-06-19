import { describe, expect, it } from "vitest";
import { LocalOpenTuiTranscriptBridge } from "./local-opentui-bridge.js";
import type { ChatMessage } from "@step-cli/protocol";

function createBridge(): LocalOpenTuiTranscriptBridge {
  return new LocalOpenTuiTranscriptBridge();
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
  });
});
