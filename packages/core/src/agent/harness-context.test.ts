import { describe, it, expect } from "vitest";
import {
  resolveExecutionProfile,
  cloneExecutionProfile,
  isExecutionProfile,
  persistExecutionProfile,
  formatExecutionProfile,
  formatExecutionProfileForHarness,
  runWithHarnessContext,
  getHarnessContext,
} from "./harness-context.js";
import type {
  AgentExecutionProfile,
  AgentHarnessKind,
} from "../runtime-context-types.js";

describe("harness-context", () => {
  // -- resolveExecutionProfile -------------------------------------------
  describe("resolveExecutionProfile", () => {
    it("returns correct defaults for main", () => {
      const profile = resolveExecutionProfile("main");
      expect(profile).toEqual({
        workspaceMode: "shared",
        memoryMode: "session",
        priority: "interactive",
      });
    });

    it("returns correct defaults for subagent", () => {
      const profile = resolveExecutionProfile("subagent");
      expect(profile).toEqual({
        workspaceMode: "shared",
        memoryMode: "fresh",
        priority: "delegated",
      });
    });

    it("returns correct defaults for teammate", () => {
      const profile = resolveExecutionProfile("teammate");
      expect(profile).toEqual({
        workspaceMode: "shared",
        memoryMode: "persistent",
        priority: "background",
      });
    });

    it("applies overrides on top of defaults", () => {
      const profile = resolveExecutionProfile("main", {
        priority: "maintenance",
      });
      expect(profile.workspaceMode).toBe("shared");
      expect(profile.memoryMode).toBe("session");
      expect(profile.priority).toBe("maintenance");
    });

    it("applies multiple overrides", () => {
      const profile = resolveExecutionProfile("subagent", {
        workspaceMode: "isolated",
        memoryMode: "persistent",
        priority: "interactive",
      });
      expect(profile).toEqual({
        workspaceMode: "isolated",
        memoryMode: "persistent",
        priority: "interactive",
      });
    });
  });

  // -- cloneExecutionProfile ---------------------------------------------
  describe("cloneExecutionProfile", () => {
    it("returns a different reference with equal values", () => {
      const original: AgentExecutionProfile = {
        workspaceMode: "shared",
        memoryMode: "fresh",
        priority: "delegated",
      };
      const clone = cloneExecutionProfile(original);
      expect(clone).toEqual(original);
      expect(clone).not.toBe(original);
    });

    it("modifying the clone does not affect the original", () => {
      const original: AgentExecutionProfile = {
        workspaceMode: "shared",
        memoryMode: "fresh",
        priority: "delegated",
      };
      const clone = cloneExecutionProfile(original);
      clone.priority = "interactive";
      expect(original.priority).toBe("delegated");
    });
  });

  // -- isExecutionProfile ------------------------------------------------
  describe("isExecutionProfile", () => {
    it("returns true for a valid profile", () => {
      expect(
        isExecutionProfile({
          workspaceMode: "shared",
          memoryMode: "session",
          priority: "interactive",
        }),
      ).toBe(true);
    });

    it("returns false for a string", () => {
      expect(isExecutionProfile("shared/session/interactive")).toBe(false);
    });

    it("returns false for null", () => {
      expect(isExecutionProfile(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isExecutionProfile(undefined)).toBe(false);
    });

    it("returns false for an array", () => {
      expect(isExecutionProfile(["shared", "session", "interactive"])).toBe(
        false,
      );
    });

    it("returns false for an object with invalid workspaceMode", () => {
      expect(
        isExecutionProfile({
          workspaceMode: "unknown",
          memoryMode: "session",
          priority: "interactive",
        }),
      ).toBe(false);
    });

    it("returns false for an object with invalid memoryMode", () => {
      expect(
        isExecutionProfile({
          workspaceMode: "shared",
          memoryMode: "unknown",
          priority: "interactive",
        }),
      ).toBe(false);
    });

    it("returns false for an object with invalid priority", () => {
      expect(
        isExecutionProfile({
          workspaceMode: "shared",
          memoryMode: "session",
          priority: "unknown",
        }),
      ).toBe(false);
    });
  });

  // -- persistExecutionProfile -------------------------------------------
  describe("persistExecutionProfile", () => {
    it("returns an object with workspaceMode only", () => {
      const result = persistExecutionProfile({
        workspaceMode: "shared",
        memoryMode: "session",
        priority: "interactive",
      });
      expect(result).toEqual({ workspaceMode: "shared" });
    });

    it("returns undefined for undefined input", () => {
      expect(persistExecutionProfile(undefined)).toBeUndefined();
    });

    it("returns only workspaceMode, dropping other fields", () => {
      const result = persistExecutionProfile({
        workspaceMode: "isolated",
        memoryMode: "fresh",
        priority: "delegated",
      });
      expect(result).toEqual({ workspaceMode: "isolated" });
      // Ensure no extra keys
      expect(Object.keys(result!)).toEqual(["workspaceMode"]);
    });
  });

  // -- formatExecutionProfile --------------------------------------------
  describe("formatExecutionProfile", () => {
    it("formats a full profile as workspaceMode/memoryMode/priority", () => {
      const result = formatExecutionProfile({
        workspaceMode: "shared",
        memoryMode: "session",
        priority: "interactive",
      });
      expect(result).toBe("shared/session/interactive");
    });

    it("falls back to defaults for missing segments", () => {
      const result = formatExecutionProfile({});
      expect(result).toBe("unknown/unknown/unknown");
    });

    it("uses provided fallback values", () => {
      const result = formatExecutionProfile(undefined, {
        workspaceMode: "shared",
        memoryMode: "fresh",
        priority: "delegated",
      });
      expect(result).toBe("shared/fresh/delegated");
    });

    it("treats null input as unknown defaults", () => {
      const result = formatExecutionProfile(null);
      expect(result).toBe("unknown/unknown/unknown");
    });
  });

  // -- formatExecutionProfileForHarness ----------------------------------
  describe("formatExecutionProfileForHarness", () => {
    it("formats with main defaults when value is undefined", () => {
      const result = formatExecutionProfileForHarness("main", undefined);
      expect(result).toBe("shared/session/interactive");
    });

    it("formats with subagent defaults when value is undefined", () => {
      const result = formatExecutionProfileForHarness("subagent", undefined);
      expect(result).toBe("shared/fresh/delegated");
    });

    it("formats with teammate defaults when value is undefined", () => {
      const result = formatExecutionProfileForHarness("teammate", undefined);
      expect(result).toBe("shared/persistent/background");
    });

    it("uses the provided value when present", () => {
      const result = formatExecutionProfileForHarness("main", {
        workspaceMode: "isolated",
        memoryMode: "persistent",
        priority: "maintenance",
      });
      expect(result).toBe("isolated/persistent/maintenance");
    });
  });

  // -- runWithHarnessContext + getHarnessContext --------------------------
  describe("runWithHarnessContext + getHarnessContext", () => {
    it("returns the context inside the callback", async () => {
      const context = {
        id: "test-id",
        kind: "subagent" as AgentHarnessKind,
        name: "test-agent",
        depth: 1,
        workspaceRoot: "/tmp/workspace",
        sessionId: "session-1",
        goalId: "goal-1",
        executionProfile: {
          workspaceMode: "shared" as const,
          memoryMode: "fresh" as const,
          priority: "delegated" as const,
        },
        lifecycleState: "active" as const,
        attemptCount: 1,
        attemptId: "attempt-1",
        runStartedAt: "2025-01-01T00:00:00Z",
      };

      await runWithHarnessContext(context, async () => {
        const stored = getHarnessContext();
        expect(stored).toBe(context);
        expect(stored!.id).toBe("test-id");
        expect(stored!.kind).toBe("subagent");
      });
    });

    it("returns undefined outside of a harness context", () => {
      expect(getHarnessContext()).toBeUndefined();
    });

    it("restores context correctly after the callback completes", async () => {
      const context = {
        id: "outer",
        kind: "main" as AgentHarnessKind,
        name: "outer-agent",
        depth: 0,
        workspaceRoot: "/tmp",
        sessionId: "s1",
        goalId: "g1",
        executionProfile: {
          workspaceMode: "shared" as const,
          memoryMode: "session" as const,
          priority: "interactive" as const,
        },
        lifecycleState: "active" as const,
        attemptCount: 1,
        attemptId: "a1",
        runStartedAt: "2025-01-01T00:00:00Z",
      };

      await runWithHarnessContext(context, async () => {
        expect(getHarnessContext()).toBe(context);
      });

      // After the callback, context should be undefined again
      expect(getHarnessContext()).toBeUndefined();
    });
  });
});
