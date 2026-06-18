import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks for heavy dependencies ------------------------------------------
// stepcli-cache.createAgentLoopBundle is the only thing that touches the real
// AgentLoop/model client. We replace it with a controllable fake so we can
// drive query()'s turn loop deterministically.
const bundleState: {
  runImpl: (input: string) => Promise<unknown>;
  createImpl: (() => unknown) | null;
  exportStateImpl: () => unknown;
} = {
  runImpl: async () => ({
    output: "ok",
    actions: [],
    steps: 1,
  }),
  createImpl: null,
  exportStateImpl: () => ({ summary: "snap" }),
};

const createAgentLoopBundle = vi.fn((..._args: unknown[]) => {
  if (bundleState.createImpl) return bundleState.createImpl();
  return {
    agent: {
      run: (input: string) => bundleState.runImpl(input),
      setSignal: vi.fn(),
    },
    memory: {
      exportState: () => bundleState.exportStateImpl(),
      loadState: vi.fn(),
    },
    tools: {},
    setSignal: vi.fn(),
  };
});

vi.mock("./stepcli-cache.js", () => ({
  createAgentLoopBundle: (...args: unknown[]) =>
    (createAgentLoopBundle as (...a: unknown[]) => unknown)(...args),
}));

import { query } from "./query.js";
import { getSessionStore } from "./session-store.js";
import {
  ERR_SESSION_NOT_FOUND,
  ERR_SESSION_BUSY,
  ERR_SESSION_CORRUPT,
} from "./error-codes.js";
import type {
  QueryOptions,
  SDKUserMessage,
  SDKMessage,
  SDKResultMessage,
} from "./types.js";
import type { ChatCompletionClient } from "@step-cli/core/model-client.js";

function fakeClient(): ChatCompletionClient {
  return {} as unknown as ChatCompletionClient;
}

function baseOptions(overrides: Partial<QueryOptions> = {}): QueryOptions {
  return {
    client: fakeClient(),
    model: "m",
    cwd: "/tmp/ws",
    ...overrides,
  };
}

async function* promptOf(...messages: SDKUserMessage[]) {
  for (const m of messages) yield m;
}

function userMsg(content: string): SDKUserMessage {
  return { role: "user", content };
}

async function drain(q: AsyncIterable<SDKMessage>): Promise<SDKMessage[]> {
  const out: SDKMessage[] = [];
  for await (const m of q) out.push(m);
  return out;
}

function resultOf(messages: SDKMessage[]): SDKResultMessage {
  const r = messages.find((m) => m.type === "result");
  if (!r) throw new Error("no result message emitted");
  return r as SDKResultMessage;
}

describe("query", () => {
  beforeEach(() => {
    getSessionStore().clear();
    createAgentLoopBundle.mockClear();
    bundleState.runImpl = async () => ({ output: "ok", actions: [], steps: 1 });
    bundleState.createImpl = null;
    bundleState.exportStateImpl = () => ({ summary: "snap" });
  });

  afterEach(() => {
    getSessionStore().clear();
  });

  it("runs a single turn and emits a success result", async () => {
    bundleState.runImpl = async () => ({
      output: "done!",
      actions: [{ kind: "goal_complete", success: true }],
      steps: 1,
    });
    const q = query({
      prompt: promptOf(userMsg("hi")),
      options: baseOptions(),
    });
    const messages = await drain(q);
    const result = resultOf(messages);
    expect(result.subtype).toBe("success");
    expect(result.result).toBe("done!");
    expect(result.num_turns).toBe(1);
    expect(result.session_id).toBeTruthy();
  });

  it("marks session busy during query and releases it afterward", async () => {
    const q = query({
      prompt: promptOf(userMsg("hi")),
      options: baseOptions(),
    });
    const messages = await drain(q);
    const sessionId = resultOf(messages).session_id;
    expect(getSessionStore().isBusy(sessionId)).toBe(false);
  });

  it("defaults to success subtype when no goal_complete action present", async () => {
    bundleState.runImpl = async () => ({
      output: "partial",
      actions: [{ kind: "tool_call" }],
      steps: 1,
    });
    const messages = await drain(
      query({ prompt: promptOf(userMsg("x")), options: baseOptions() }),
    );
    expect(resultOf(messages).subtype).toBe("success");
  });

  it("maps a failed goal_complete (within turn budget) to error_during_execution", async () => {
    bundleState.runImpl = async () => ({
      output: "failed",
      actions: [{ kind: "goal_complete", success: false }],
      steps: 1,
    });
    const messages = await drain(
      query({
        prompt: promptOf(userMsg("x")),
        options: baseOptions({ maxTurns: 5 }),
      }),
    );
    expect(resultOf(messages).subtype).toBe("error_during_execution");
  });

  it("maps a failed goal_complete at max steps to error_max_turns", async () => {
    bundleState.runImpl = async () => ({
      output: "exhausted",
      actions: [{ kind: "goal_complete", success: false }],
      steps: 3,
    });
    const messages = await drain(
      query({
        prompt: promptOf(userMsg("x")),
        options: baseOptions({ maxTurns: 3 }),
      }),
    );
    expect(resultOf(messages).subtype).toBe("error_max_turns");
  });

  it("processes multiple prompts as multiple turns", async () => {
    const seen: string[] = [];
    bundleState.runImpl = async (input: string) => {
      seen.push(input);
      return { output: input, actions: [], steps: 1 };
    };
    const messages = await drain(
      query({
        prompt: promptOf(userMsg("first"), userMsg("second")),
        options: baseOptions(),
      }),
    );
    expect(seen).toEqual(["first", "second"]);
    expect(resultOf(messages).num_turns).toBe(2);
  });

  it("emits an error_during_execution result when agent.run throws (not aborted)", async () => {
    bundleState.runImpl = async () => {
      throw new Error("model exploded");
    };
    const q = query({ prompt: promptOf(userMsg("x")), options: baseOptions() });
    const messages = await drain(q);
    const result = resultOf(messages);
    expect(result.subtype).toBe("error_during_execution");
    expect(result.result).toBe("model exploded");
  });

  it("persists a memory snapshot to the session store after running", async () => {
    bundleState.exportStateImpl = () => ({ summary: "persisted-state" });
    const messages = await drain(
      query({ prompt: promptOf(userMsg("x")), options: baseOptions() }),
    );
    const sessionId = resultOf(messages).session_id;
    expect(getSessionStore().get(sessionId)).toEqual({
      summary: "persisted-state",
    });
  });

  it("interrupt aborts the controller and closes the stream cleanly", async () => {
    const ac = new AbortController();
    // run() resolves only once the signal aborts, mimicking a cooperative
    // long-running turn that bails out on cancellation.
    bundleState.runImpl = (_input: string) =>
      new Promise((resolve) => {
        if (ac.signal.aborted) {
          resolve({ output: "", actions: [], steps: 0 });
          return;
        }
        ac.signal.addEventListener("abort", () => {
          resolve({ output: "", actions: [], steps: 0 });
        });
      });
    const q = query({
      prompt: promptOf(userMsg("x")),
      options: baseOptions({ abortController: ac }),
    });
    // Give the driver a tick to start the (blocked) run.
    await new Promise((r) => setTimeout(r, 5));
    await q.interrupt();
    expect(ac.signal.aborted).toBe(true);
    // Stream terminates without hanging; collect whatever was emitted.
    const messages = await drain(q);
    expect(messages.every((m) => m.type === "result" || m.type)).toBe(true);
  });
});

describe("query - resume handling", () => {
  beforeEach(() => {
    getSessionStore().clear();
    createAgentLoopBundle.mockClear();
    bundleState.runImpl = async () => ({ output: "ok", actions: [], steps: 1 });
    bundleState.createImpl = null;
    bundleState.exportStateImpl = () => ({ summary: "snap" });
  });

  it("throws ERR_SESSION_NOT_FOUND for an unknown resume id", () => {
    try {
      query({
        prompt: promptOf(userMsg("x")),
        options: baseOptions({ resume: "missing" }),
      });
      throw new Error("expected throw");
    } catch (error: any) {
      expect(error.code).toBe(ERR_SESSION_NOT_FOUND);
    }
  });

  it("throws ERR_SESSION_BUSY when resuming a busy session", () => {
    const store = getSessionStore();
    store.set("s1", { summary: "x" } as never);
    store.markBusy("s1");
    try {
      query({
        prompt: promptOf(userMsg("x")),
        options: baseOptions({ resume: "s1" }),
      });
      throw new Error("expected throw");
    } catch (error: any) {
      expect(error.code).toBe(ERR_SESSION_BUSY);
    }
  });

  it("resumes an existing session and loads its memory state into the bundle", async () => {
    const store = getSessionStore();
    store.set("s2", { summary: "prior" } as never);
    let receivedMemoryState: unknown;
    createAgentLoopBundle.mockImplementationOnce((args: any) => {
      receivedMemoryState = args.memoryState;
      return {
        agent: {
          run: (input: string) => bundleState.runImpl(input),
          setSignal: vi.fn(),
        },
        memory: {
          exportState: () => ({ summary: "after" }),
          loadState: vi.fn(),
        },
        tools: {},
        setSignal: vi.fn(),
      };
    });
    const messages = await drain(
      query({
        prompt: promptOf(userMsg("x")),
        options: baseOptions({ resume: "s2" }),
      }),
    );
    expect(receivedMemoryState).toEqual({ summary: "prior" });
    expect(resultOf(messages).session_id).toBe("s2");
  });

  it("maps a bundle build failure during resume to ERR_SESSION_CORRUPT and releases busy", () => {
    const store = getSessionStore();
    store.set("s3", { summary: "bad" } as never);
    bundleState.createImpl = () => {
      throw new Error("loadState failed: corrupt memory");
    };
    try {
      query({
        prompt: promptOf(userMsg("x")),
        options: baseOptions({ resume: "s3" }),
      });
      throw new Error("expected throw");
    } catch (error: any) {
      expect(error.code).toBe(ERR_SESSION_CORRUPT);
    }
    expect(store.isBusy("s3")).toBe(false);
  });

  it("rethrows a non-state bundle build error and releases busy (fresh session)", () => {
    bundleState.createImpl = () => {
      throw new Error("unrelated boom");
    };
    expect(() =>
      query({ prompt: promptOf(userMsg("x")), options: baseOptions() }),
    ).toThrow("unrelated boom");
  });
});

describe("query - tool wiring", () => {
  beforeEach(() => {
    getSessionStore().clear();
    createAgentLoopBundle.mockClear();
    bundleState.runImpl = async () => ({ output: "ok", actions: [], steps: 1 });
    bundleState.createImpl = null;
    bundleState.exportStateImpl = () => ({ summary: "snap" });
  });

  it("forwards an explicit ToolSpec array to the bundle", async () => {
    const toolSpec = {
      definition: {
        type: "function",
        function: { name: "MyTool", parameters: {} },
      },
      security: { risk: "read", defaultMode: "allow" },
      parseArgs: () => ({}),
      execute: async () => ({ ok: true }),
    } as never;
    await drain(
      query({
        prompt: promptOf(userMsg("x")),
        options: baseOptions({ tools: [toolSpec] }),
      }),
    );
    const passed = createAgentLoopBundle.mock.calls[0]![0] as any;
    expect(
      passed.toolSpecs.map((t: any) => t.definition.function.name),
    ).toEqual(["MyTool"]);
  });

  it("resolves preset tools and applies allowedTools filtering", async () => {
    await drain(
      query({
        prompt: promptOf(userMsg("x")),
        options: baseOptions({
          tools: { type: "preset", preset: "stepfun_code" },
          allowedTools: ["Read"],
        }),
      }),
    );
    const passed = createAgentLoopBundle.mock.calls[0]![0] as any;
    const names = passed.toolSpecs.map((t: any) => t.definition.function.name);
    expect(names).toEqual(["Read"]);
  });

  it("builds the default system prompt from cwd when none provided", async () => {
    await drain(
      query({
        prompt: promptOf(userMsg("x")),
        options: baseOptions({ cwd: "/my/cwd" }),
      }),
    );
    const passed = createAgentLoopBundle.mock.calls[0]![0] as any;
    expect(passed.systemPrompt).toContain("cwd: /my/cwd");
    expect(passed.systemPrompt).toContain("coding assistant");
  });

  it("forwards a custom system prompt unchanged", async () => {
    await drain(
      query({
        prompt: promptOf(userMsg("x")),
        options: baseOptions({ systemPrompt: "custom!" }),
      }),
    );
    const passed = createAgentLoopBundle.mock.calls[0]![0] as any;
    expect(passed.systemPrompt).toBe("custom!");
  });
});
