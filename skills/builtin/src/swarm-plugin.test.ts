import { describe, expect, it, afterEach } from "vitest";
import { createSwarmPlugin, getSwarmMode } from "./swarm-plugin.js";

function resetSwarmMode(): void {
  const mode = getSwarmMode();
  mode.exit();
}

describe("createSwarmPlugin", () => {
  afterEach(resetSwarmMode);
  it("starts inactive", () => {
    const plugin = createSwarmPlugin();
    expect(plugin.getSwarmMode().isActive).toBe(false);
    expect(plugin.getSwarmMode().trigger).toBeNull();
  });

  it("enters mode and injects reminder for main harness", () => {
    const plugin = createSwarmPlugin();
    const mode = plugin.getSwarmMode();
    mode.enter("manual", "test-enter-manual");
    expect(mode.isActive).toBe(true);
    expect(mode.trigger).toBe("manual");

    const hook = plugin.hooks.beforeModelRequest?.({
      workspaceRoot: "/tmp",
      step: 1,
      toolCalls: 0,
      now: new Date().toISOString(),
      userMessages: [],
      harnessType: "main",
      harnessDepth: 0,
    });
    expect(hook?.messages?.length).toBe(1);
    expect(hook?.messages?.[0]?.role).toBe("system");
    expect(hook?.messages?.[0]?.content).toContain("Swarm Mode");
    mode.exit();
  });

  it("is idempotent on double enter", () => {
    const plugin = createSwarmPlugin();
    const mode = plugin.getSwarmMode();
    mode.enter("manual", "test-double-enter");
    mode.enter("manual", "test-double-enter");
    expect(mode.isActive).toBe(true);
    const hook = plugin.hooks.beforeModelRequest?.({
      workspaceRoot: "/tmp",
      step: 1,
      toolCalls: 0,
      now: new Date().toISOString(),
      userMessages: [],
      harnessType: "main",
      harnessDepth: 0,
    });
    expect(hook?.messages?.length).toBe(1);
    mode.exit();
  });

  it("dedupes repeated prompt for same trigger", () => {
    const plugin = createSwarmPlugin();
    const mode = plugin.getSwarmMode();
    mode.enter("task", "test-dedup-src");
    mode.exit();
    mode.enter("task", "test-dedup-src");
    expect(mode.trigger).toBeNull();
  });

  it("allows same trigger with different prompt", () => {
    const plugin = createSwarmPlugin();
    const mode = plugin.getSwarmMode();
    mode.enter("task", "test-allow-a");
    mode.exit();
    mode.enter("task", "test-allow-b");
    expect(mode.trigger).toBe("task");
    mode.exit();
  });

  it("exits and stops injecting", () => {
    const plugin = createSwarmPlugin();
    const mode = plugin.getSwarmMode();
    mode.enter("manual", "test-exit");
    mode.exit();
    expect(mode.isActive).toBe(false);
    const hook = plugin.hooks.beforeModelRequest?.({
      harnessType: "main",
      harnessDepth: 0,
    } as never);
    expect(hook?.messages?.length).toBeUndefined();
  });

  it("does not inject for non-main harness", () => {
    const plugin = createSwarmPlugin();
    plugin.getSwarmMode().enter("manual", "test-non-main");
    const hook = plugin.hooks.beforeModelRequest?.({
      workspaceRoot: "/tmp",
      step: 1,
      toolCalls: 0,
      now: new Date().toISOString(),
      userMessages: [],
      harnessType: "teammate",
      harnessDepth: 1,
    });
    expect(hook?.messages?.length).toBeUndefined();
    plugin.getSwarmMode().exit();
  });

  it("does not inject for deep main harness", () => {
    const plugin = createSwarmPlugin();
    plugin.getSwarmMode().enter("manual", "test-deep-main");
    const hook = plugin.hooks.beforeModelRequest?.({
      workspaceRoot: "/tmp",
      step: 1,
      toolCalls: 0,
      now: new Date().toISOString(),
      userMessages: [],
      harnessType: "main",
      harnessDepth: 2,
    });
    expect(hook?.messages?.length).toBeUndefined();
    plugin.getSwarmMode().exit();
  });
});

describe("getSwarmMode", () => {
  afterEach(resetSwarmMode);

  it("returns the shared swarm mode state", () => {
    const mode = getSwarmMode();
    expect(mode.isActive).toBe(false);
    mode.enter("manual", "shared-state-test");
    expect(mode.isActive).toBe(true);
    mode.exit();
  });
});
