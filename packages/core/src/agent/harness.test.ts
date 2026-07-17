import { describe, expect, it, vi } from "vitest";
import {
  AgentHarness,
  AgentHarnessFactory,
  filterToolSpecsForOperatingMode,
} from "./harness.js";
import {
  ConversationMemory,
  type MemoryConfig,
} from "./conversation-memory.js";
import type { ToolSpec } from "@step-cli/protocol";

const memoryConfig: MemoryConfig = {
  maxContextTokens: 8_000,
  reserveOutputTokens: 1_000,
  minRecentMessages: 2,
  compressionTriggerRatio: 0.8,
  compressionTargetRatio: 0.6,
  maxSummaryChars: 500,
  compactedUserMessageTokenBudget: 100,
  maxCompactedUserMessages: 2,
  compactedUserMessageMaxChars: 100,
  maxDecisionEntries: 5,
  decisionEntryMaxChars: 100,
  microCompactKeepRecentToolMessages: 2,
  microCompactToolContentChars: 100,
};

function identity() {
  return {
    id: "h-1",
    kind: "main" as const,
    name: "main",
    depth: 0,
    workspaceRoot: "/workspace",
    sessionId: "session",
    goalId: "goal",
    executionProfile: {
      workspaceMode: "shared" as const,
      memoryMode: "session" as const,
      priority: "interactive" as const,
    },
    lifecycleState: "inactive" as const,
    attemptCount: 0,
  };
}

function makeHarness(overrides: Record<string, unknown> = {}) {
  const memory = new ConversationMemory(memoryConfig);
  const tools = {
    setSignal: vi.fn(),
    exportState: vi.fn(() => ({ approvedFingerprints: [] })),
  };
  const result = {
    output: "done",
    steps: 1,
    toolCalls: 0,
    actions: [],
    stateTimeline: [],
    run: {
      harnessId: "h-1",
      harnessType: "main",
      harnessName: "main",
      sessionId: "session",
      goalId: "goal",
    },
  };
  const agent = {
    setSignal: vi.fn(),
    run: vi.fn().mockResolvedValue(result),
    dispatchExternalAction: vi.fn(() => ({ kind: "fresh_attempt_restart" })),
  };
  const harness = new AgentHarness({
    context: identity(),
    memory,
    tools: tools as never,
    agent: agent as never,
    allowedTools: ["Read"],
    ...overrides,
  });
  return { harness, memory, tools, agent, result };
}

function tool(
  name: string,
  risk: "read" | "write" | "execute" = "read",
): ToolSpec {
  return {
    definition: {
      type: "function",
      function: { name, description: name, parameters: {} },
    },
    security: { risk, defaultMode: "allow" },
    parseArgs: () => ({}),
    execute: async () => ({ ok: true, summary: name }),
  } as ToolSpec;
}

describe("AgentHarness", () => {
  it("runs with an attempt context, resets signals, and exports isolated state", async () => {
    const { harness, agent, tools, memory } = makeHarness();
    memory.addUser("hello");
    const result = await harness.run("hello");
    expect(result.output).toBe("done");
    expect(agent.run).toHaveBeenCalledWith("hello");
    expect(agent.setSignal).toHaveBeenLastCalledWith(undefined);
    expect(tools.setSignal).toHaveBeenLastCalledWith(undefined);
    const exported = harness.exportState();
    exported.allowedTools.push("Write");
    expect(harness.exportState().allowedTools).toEqual(["Read"]);
    expect(harness.getContext().attemptCount).toBe(1);
  });

  it("rejects re-entry and finalizes only an inactive harness", async () => {
    const { harness, agent } = makeHarness();
    agent.run.mockImplementation(async () => {
      await expect(harness.run("again")).rejects.toThrow("already running");
      return {
        output: "done",
        steps: 0,
        toolCalls: 0,
        actions: [],
        stateTimeline: [],
        run: {},
      };
    });
    await harness.run("first");
    harness.finalize();
    harness.finalize();
    await expect(harness.run("after")).rejects.toThrow(
      "already been finalized",
    );
  });

  it("filters operating-mode tool surfaces", () => {
    const specs = [
      tool("Read"),
      tool("Write", "write"),
      tool("Bash", "execute"),
    ];
    expect(filterToolSpecsForOperatingMode(specs, "normal").specs).toHaveLength(
      3,
    );
    const plan = filterToolSpecsForOperatingMode(specs, "plan");
    expect(plan.specs.map((entry) => entry.definition.function.name)).toEqual([
      "Read",
    ]);
    expect(plan.hidden).toEqual(["Bash", "Write"]);
  });

  it("builds a harness, applies tool filtering, and reports plugin registration errors", () => {
    const factory = new AgentHarnessFactory({
      model: "model",
      client: {} as never,
      defaultSystemPrompt: "system",
      memoryConfig,
      runConfig: { maxSteps: 2 } as never,
      commandTimeoutMs: 1_000,
      commandOutputLimit: 1_000,
      interactionProfile: { kind: "cli" } as never,
      plugins: [
        {
          source: "builtin",
          plugin: {
            id: "good",
            description: "good",
            register: () => [tool("Read"), tool("Write", "write")],
          },
        },
        {
          source: "builtin",
          plugin: {
            id: "bad",
            description: "bad",
            register: () => {
              throw new Error("broken");
            },
          },
        },
      ],
    });
    const created = factory.createHarness({
      id: "id",
      kind: "subagent",
      name: "sub",
      depth: 1,
      workspaceRoot: "/workspace",
      allowedTools: ["Read"],
    });
    expect(created.harness.getTools().listToolNames()).toEqual(["Read"]);
    expect(created.warnings).toContainEqual(expect.stringContaining("broken"));
    expect(factory.getDefaultExecutionProfile("subagent").priority).toBe(
      "delegated",
    );
  });
});
