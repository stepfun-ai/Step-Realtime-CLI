import { describe, expect, it, vi } from "vitest";
import { createMutableRef } from "@step-cli/utils/mutable-ref.js";

const { compileTeammateHarness } = vi.hoisted(() => ({
  compileTeammateHarness: vi.fn(),
}));
vi.mock("./scaffolding.js", () => ({ compileTeammateHarness }));

import { AgentTeam } from "./agent-team.js";

function makeHarness(name = "worker") {
  const state = {
    identity: {
      executionProfile: {
        workspaceMode: "shared",
        memoryMode: "persistent",
        priority: "background",
      },
    },
    allowedTools: ["Read"],
    memory: {
      messages: [],
      summary: "",
      summarizedUntil: 0,
      decisionChain: [],
      compactedUserMessages: [],
      compactedToolMessages: 0,
    },
    toolRuntime: { approvedFingerprints: [] },
  };
  return {
    getContext: vi.fn(() => ({
      id: `teammate:${name}`,
      name,
      executionProfile: state.identity.executionProfile,
    })),
    getMemory: vi.fn(() => ({ exportState: () => state.memory })),
    exportState: vi.fn(() => state),
    finalize: vi.fn(),
    run: vi.fn().mockResolvedValue({
      output: "finished",
      steps: 1,
      toolCalls: 0,
      actions: [],
      stateTimeline: [],
      run: { sessionId: "s", goalId: "g", attemptId: "a" },
    }),
  };
}

function setup() {
  const messages: any[] = [];
  const inboxStore = {
    append: vi.fn(async (message) => {
      messages.push(message);
    }),
    read: vi.fn(async (inbox: string, sessionId?: string) =>
      messages.filter(
        (message) =>
          message.to === inbox &&
          (!sessionId || message.sessionId === sessionId),
      ),
    ),
  };
  const ref = createMutableRef<any>("factory");
  ref.set({});
  const team = new AgentTeam({ inboxStore, harnessFactoryRef: ref });
  return { team, messages, inboxStore };
}

describe("AgentTeam", () => {
  it("spawns a normalized persistent teammate, sends its initial message, and reuses it", async () => {
    const harness = makeHarness("dev");
    compileTeammateHarness.mockReturnValue({
      harness,
      systemPrompt: "sys",
      warnings: ["warning"],
    });
    const { team, messages } = setup();
    const created = await team.spawnTeammate({
      name: " Dev ",
      role: "developer",
      requester: " Lead ",
      parentDepth: 0,
      parentId: "main",
      workspaceRoot: "/workspace",
      prompt: "implement",
    });
    expect(created.teammate).toMatchObject({
      name: "Dev",
      lead: "Lead",
      status: "working",
    });
    expect(created.warnings).toEqual(["warning"]);
    expect(messages[0]).toMatchObject({
      from: "Lead",
      to: "Dev",
      type: "message",
      content: "implement",
    });
    const again = await team.spawnTeammate({
      name: "Dev",
      role: "other",
      requester: "lead",
      parentDepth: 0,
      parentId: "main",
      workspaceRoot: "/workspace",
      prompt: "next",
    });
    expect(again.warnings).toContainEqual(
      expect.stringContaining("already exists with role"),
    );
    expect(compileTeammateHarness).toHaveBeenCalledTimes(1);
    await team.close({ abortRunning: true });
  });

  it("tracks inbox cursors per reader/session and respects markRead and limits", async () => {
    const { team } = setup();
    await team.sendMessage({
      from: "lead",
      to: "dev",
      content: "one",
      sessionId: "s1",
    });
    await team.sendMessage({
      from: "lead",
      to: "dev",
      content: "two",
      sessionId: "s1",
    });
    await team.sendMessage({
      from: "lead",
      to: "dev",
      content: "other",
      sessionId: "s2",
    });
    const first = await team.readInbox({
      inboxName: "dev",
      reader: "reader",
      sessionId: "s1",
      limit: 1,
    });
    expect(first).toMatchObject({ remaining: 1, total: 2 });
    const unread = await team.readInbox({
      inboxName: "dev",
      reader: "reader",
      sessionId: "s1",
      markRead: false,
    });
    expect(unread.messages).toHaveLength(1);
    const other = await team.readInbox({
      inboxName: "dev",
      reader: "reader",
      sessionId: "s2",
    });
    expect(other.messages.map((message) => message.content)).toEqual(["other"]);
  });

  it("handles shutdown and plan approval protocols with ownership checks", async () => {
    const harness = makeHarness("dev");
    compileTeammateHarness.mockReturnValue({
      harness,
      systemPrompt: "sys",
      warnings: [],
    });
    const { team } = setup();
    await team.spawnTeammate({
      name: "dev",
      role: "developer",
      requester: "lead",
      parentDepth: 0,
      parentId: "main",
      workspaceRoot: "/workspace",
      prompt: "work",
    });
    const shutdown = await team.requestShutdown({
      from: "lead",
      to: "dev",
      requestId: "stop",
      sessionId: "s",
    });
    await expect(
      team.respondShutdown({
        from: "other",
        requestId: shutdown.request.requestId,
        approve: true,
      }),
    ).rejects.toThrow("assigned");
    const answered = await team.respondShutdown({
      from: "dev",
      requestId: "stop",
      approve: true,
    });
    expect(answered.request.status).toBe("approved");
    const plan = await team.requestPlanApproval({
      from: "dev",
      to: "lead",
      content: "plan",
      requestId: "plan-1",
    });
    const approved = await team.respondPlanApproval({
      from: "lead",
      requestId: plan.request.requestId,
      approve: false,
    });
    expect(approved.request).toMatchObject({
      status: "rejected",
      response: "Plan rejected.",
    });
    await team.close({ abortRunning: true });
  });

  it("exports and reloads durable team state and rejects invalid state", async () => {
    const harness = makeHarness("dev");
    compileTeammateHarness.mockReturnValue({
      harness,
      systemPrompt: "sys",
      warnings: [],
    });
    const { team } = setup();
    await team.spawnTeammate({
      name: "dev",
      role: "developer",
      requester: "lead",
      parentDepth: 0,
      parentId: "main",
      workspaceRoot: "/workspace",
      prompt: "work",
      sessionId: "s",
    });
    const state = team.exportState();
    expect(state.version).toBe(4);
    const restored = setup().team;
    restored.loadState(state);
    expect(restored.getTeammate("dev")).toMatchObject({
      name: "dev",
      sessionId: "s",
    });
    restored.loadState({ version: 99, teammates: [] });
    expect(restored.listTeammates()).toEqual([]);
    await team.close({ abortRunning: true });
    await restored.close({ abortRunning: true });
  });
});
