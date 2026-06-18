import { describe, it, expect, vi } from "vitest";
import { createAgentLoopBundle } from "./stepcli-cache.js";
import type { CreateAgentLoopArgs } from "./stepcli-cache.js";
import { resolvePresetToolSpecs } from "./preset.js";
import { AgentLoop } from "@step-cli/core/agent/agent-loop.js";
import { ConversationMemory } from "@step-cli/core/agent/conversation-memory.js";
import { ToolRuntime } from "@step-cli/core/tools/runtime.js";
import type { ChatCompletionClient } from "@step-cli/core/model-client.js";

function fakeClient(): ChatCompletionClient {
  return {
    createChatCompletion: vi.fn(),
  } as unknown as ChatCompletionClient;
}

function baseArgs(
  overrides: Partial<CreateAgentLoopArgs> = {},
): CreateAgentLoopArgs {
  return {
    client: fakeClient(),
    model: "test-model",
    workspaceRoot: "/tmp/workspace",
    systemPrompt: "you are a test agent",
    toolSpecs: [],
    ...overrides,
  };
}

describe("createAgentLoopBundle", () => {
  it("returns agent, memory, tools, and setSignal", () => {
    const bundle = createAgentLoopBundle(baseArgs());
    expect(bundle.agent).toBeInstanceOf(AgentLoop);
    expect(bundle.memory).toBeInstanceOf(ConversationMemory);
    expect(bundle.tools).toBeInstanceOf(ToolRuntime);
    expect(typeof bundle.setSignal).toBe("function");
  });

  it("registers the supplied preset tool specs in the runtime", () => {
    const toolSpecs = resolvePresetToolSpecs("stepfun_code");
    const bundle = createAgentLoopBundle(baseArgs({ toolSpecs }));
    // ToolRuntime exposes its tool names; at minimum Read should exist.
    const names = bundle.tools.listToolNames();
    expect(names).toContain("Read");
    expect(names).toContain("Bash");
  });

  it("loads provided memory state via memory.loadState", () => {
    const exported = createAgentLoopBundle(baseArgs()).memory.exportState();
    exported.summary = "restored-summary";
    const bundle = createAgentLoopBundle(baseArgs({ memoryState: exported }));
    expect(bundle.memory.exportState().summary).toBe("restored-summary");
  });

  it("does not call loadState when no memory state is given (fresh memory)", () => {
    const bundle = createAgentLoopBundle(baseArgs());
    // Fresh memory has the default empty summary.
    expect(bundle.memory.exportState().summary).toBe("");
  });

  it("honors a custom maxSteps in the run config", () => {
    const bundle = createAgentLoopBundle(baseArgs({ maxSteps: 7 }));
    // The agent should be constructed without throwing; memory config derives
    // from the run config. We assert the agent exists as a smoke check.
    expect(bundle.agent).toBeInstanceOf(AgentLoop);
    expect(() =>
      createAgentLoopBundle(baseArgs({ maxSteps: 1 })),
    ).not.toThrow();
  });

  it("setSignal forwards to the underlying agent", () => {
    const bundle = createAgentLoopBundle(baseArgs());
    const spy = vi.spyOn(bundle.agent, "setSignal");
    const ac = new AbortController();
    bundle.setSignal(ac.signal);
    expect(spy).toHaveBeenCalledWith(ac.signal);
    bundle.setSignal(undefined);
    expect(spy).toHaveBeenCalledWith(undefined);
  });

  it("passes the abort signal through to construction without error", () => {
    const ac = new AbortController();
    expect(() =>
      createAgentLoopBundle(baseArgs({ signal: ac.signal })),
    ).not.toThrow();
  });
});
