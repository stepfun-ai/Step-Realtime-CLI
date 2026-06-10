import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// 1. outbound-queue.ts
// ---------------------------------------------------------------------------
import { OutboundQueue } from "../outbound-queue.js";
import type { SDKMessage } from "../types.js";

describe("OutboundQueue", () => {
  it("push then iterator().next() resolves with pushed message", async () => {
    const q = new OutboundQueue();
    const msg: SDKMessage = {
      type: "assistant",
      session_id: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    };
    q.push(msg);
    const iter = q.iterator();
    const result = await iter.next();
    expect(result.done).toBe(false);
    expect(result.value).toBe(msg);
  });

  it("multiple pushes return in FIFO order via sequential next() calls", async () => {
    const q = new OutboundQueue();
    const msgs: SDKMessage[] = [
      {
        type: "assistant",
        session_id: "s1",
        message: { role: "assistant", content: [{ type: "text", text: "a" }] },
      },
      {
        type: "assistant",
        session_id: "s1",
        message: { role: "assistant", content: [{ type: "text", text: "b" }] },
      },
      {
        type: "assistant",
        session_id: "s1",
        message: { role: "assistant", content: [{ type: "text", text: "c" }] },
      },
    ];
    for (const m of msgs) q.push(m);
    const iter = q.iterator();
    expect((await iter.next()).value).toBe(msgs[0]);
    expect((await iter.next()).value).toBe(msgs[1]);
    expect((await iter.next()).value).toBe(msgs[2]);
  });

  it("evicts oldest stream_event when buffer fills to maxBuffered", async () => {
    const q = new OutboundQueue(3);
    const streamMsg: SDKMessage = {
      type: "stream_event",
      session_id: "s1",
      event: { type: "text_delta", text: "delta" },
    };
    const msgA: SDKMessage = {
      type: "assistant",
      session_id: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "a" }] },
    };
    const msgB: SDKMessage = {
      type: "assistant",
      session_id: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "b" }] },
    };
    q.push(streamMsg);
    q.push(msgA);
    q.push(msgB);

    // Buffer is full (3). Push another message to trigger eviction of the oldest stream_event.
    const msgC: SDKMessage = {
      type: "assistant",
      session_id: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "c" }] },
    };
    q.push(msgC);

    const iter = q.iterator();
    // streamMsg should have been evicted, so we get msgA, msgB, msgC
    expect((await iter.next()).value).toBe(msgA);
    expect((await iter.next()).value).toBe(msgB);
    expect((await iter.next()).value).toBe(msgC);
  });

  it("close() causes pending next() to resolve with done: true", async () => {
    const q = new OutboundQueue();
    const iter = q.iterator();
    const pending = iter.next();
    q.close();
    const result = await pending;
    expect(result.done).toBe(true);
  });

  it("close() causes future next() calls to resolve with done: true", async () => {
    const q = new OutboundQueue();
    q.close();
    const iter = q.iterator();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  it("fail(error) causes pending next() to reject with the error", async () => {
    const q = new OutboundQueue();
    const iter = q.iterator();
    const pending = iter.next();
    const err = new Error("boom");
    q.fail(err);
    await expect(pending).rejects.toBe(err);
  });

  it("push after close() is a no-op", async () => {
    const q = new OutboundQueue();
    q.close();
    q.push({
      type: "assistant",
      session_id: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
    });
    const iter = q.iterator();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  it("iterator().return() calls close() internally", async () => {
    const q = new OutboundQueue();
    const iter = q.iterator();
    await iter.return!();
    // After return, the queue should be closed
    const iter2 = q.iterator();
    const result = await iter2.next();
    expect(result.done).toBe(true);
  });

  it("next() called before push returns Promise that resolves once pushed (backpressure)", async () => {
    const q = new OutboundQueue();
    const iter = q.iterator();
    const pending = iter.next();
    // Not resolved yet — checking via microtask timing
    let resolved = false;
    pending.then(() => {
      resolved = true;
    });
    // Allow microtasks to flush
    await Promise.resolve();
    expect(resolved).toBe(false);

    const msg: SDKMessage = {
      type: "assistant",
      session_id: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "late" }] },
    };
    q.push(msg);
    const result = await pending;
    expect(resolved).toBe(true);
    expect(result.done).toBe(false);
    expect(result.value).toBe(msg);
  });

  it("respects custom maxBuffered constructor argument", async () => {
    const q = new OutboundQueue(2);
    // Fill with non-stream_event messages
    q.push({
      type: "assistant",
      session_id: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "a" }] },
    });
    q.push({
      type: "assistant",
      session_id: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "b" }] },
    });
    // Buffer full; push triggers eviction of oldest (non-stream, so .shift())
    q.push({
      type: "assistant",
      session_id: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "c" }] },
    });
    const iter = q.iterator();
    expect((await iter.next()).value).toMatchObject({
      message: { content: [{ text: "b" }] },
    });
    expect((await iter.next()).value).toMatchObject({
      message: { content: [{ text: "c" }] },
    });
  });
});

// ---------------------------------------------------------------------------
// 2. session-store.ts
// ---------------------------------------------------------------------------
import { getSessionStore } from "../session-store.js";
import type { SessionStore } from "../session-store.js";
import type { ConversationMemoryState } from "@step-cli/core/agent/conversation-memory.js";

function makeState(suffix: string): ConversationMemoryState {
  return {
    messages: [],
    summary: `state-${suffix}`,
    summarizedUntil: 0,
    decisionChain: [],
    lastContextUsage: {
      promptTokens: 0,
      contextMessages: 0,
      maxTokens: 0,
    } as any,
    compactedToolMessages: 0,
  };
}

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = getSessionStore();
    store.clear();
  });

  it("set then has returns true; get returns stored state", () => {
    const state = makeState("a");
    store.set("s1", state);
    expect(store.has("s1")).toBe(true);
    expect(store.get("s1")).toBe(state);
  });

  it("has returns false for unknown session ids", () => {
    expect(store.has("nonexistent")).toBe(false);
  });

  it("delete removes from snapshots and busy set", () => {
    store.set("s1", makeState("1"));
    store.markBusy("s1");
    expect(store.has("s1")).toBe(true);
    expect(store.isBusy("s1")).toBe(true);
    store.delete("s1");
    expect(store.has("s1")).toBe(false);
    expect(store.isBusy("s1")).toBe(false);
  });

  it("markBusy / isBusy / releaseBusy lifecycle", () => {
    expect(store.isBusy("s1")).toBe(false);
    expect(store.markBusy("s1")).toBe(true);
    expect(store.isBusy("s1")).toBe(true);
    store.releaseBusy("s1");
    expect(store.isBusy("s1")).toBe(false);
  });

  it("markBusy returns false if already busy, true otherwise", () => {
    expect(store.markBusy("s1")).toBe(true);
    expect(store.markBusy("s1")).toBe(false);
  });

  it("clear empties everything", () => {
    store.set("s1", makeState("1"));
    store.set("s2", makeState("2"));
    store.markBusy("s1");
    store.clear();
    expect(store.has("s1")).toBe(false);
    expect(store.has("s2")).toBe(false);
    expect(store.isBusy("s1")).toBe(false);
  });

  it("getSessionStore() returns same instance (singleton)", () => {
    const a = getSessionStore();
    const b = getSessionStore();
    expect(a).toBe(b);
  });

  it("LRU eviction: filling beyond maxSessions evicts least-recently-accessed", () => {
    // The global store has maxSessions=128 and TTL=1h. We test LRU by
    // inserting more than 128 entries and verifying eviction order.
    for (let i = 0; i < 130; i++) {
      store.set(`key-${i}`, makeState(String(i)));
    }
    // The first 2 entries (key-0, key-1) should have been evicted
    expect(store.has("key-0")).toBe(false);
    expect(store.has("key-1")).toBe(false);
    expect(store.has("key-2")).toBe(true);
    expect(store.has("key-129")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. event-translator.ts
// ---------------------------------------------------------------------------
import { createEventTranslatorHooks } from "../event-translator.js";

describe("createEventTranslatorHooks", () => {
  let emitted: SDKMessage[];
  let hooks: ReturnType<typeof createEventTranslatorHooks>;

  beforeEach(() => {
    emitted = [];
    hooks = createEventTranslatorHooks({
      sessionId: "test-session",
      emit: (msg) => emitted.push(msg),
      includePartialMessages: true,
    });
  });

  describe("onStateChange", () => {
    it("emits status 'requesting' for model_request state", () => {
      hooks.onStateChange?.({
        state: "model_request",
        step: 1,
        toolCalls: 0,
        at: "",
      });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        type: "system",
        subtype: "status",
        status: "requesting",
        session_id: "test-session",
      });
    });

    it("emits status 'compacting' for context_compaction state", () => {
      hooks.onStateChange?.({
        state: "context_compaction",
        step: 1,
        toolCalls: 0,
        at: "",
      });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        type: "system",
        subtype: "status",
        status: "compacting",
      });
    });

    it("does not emit for other states", () => {
      const otherStates = [
        "goal_start",
        "prepare_context",
        "before_model_request_hooks",
        "tool_execution",
        "apply_tool_results",
        "final_response",
        "failed",
      ] as const;
      for (const state of otherStates) {
        hooks.onStateChange?.({ state, step: 1, toolCalls: 0, at: "" });
      }
      expect(emitted).toHaveLength(0);
    });

    it("does not emit duplicate consecutive statuses", () => {
      hooks.onStateChange?.({
        state: "model_request",
        step: 1,
        toolCalls: 0,
        at: "",
      });
      hooks.onStateChange?.({
        state: "model_request",
        step: 2,
        toolCalls: 0,
        at: "",
      });
      expect(emitted).toHaveLength(1);
    });
  });

  describe("onAssistantMessage", () => {
    it("text content produces a text block", () => {
      hooks.onAssistantMessage?.({
        step: 1,
        message: { role: "assistant", content: "hello world" },
      });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        type: "assistant",
        session_id: "test-session",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello world" }],
        },
      });
    });

    it("tool_calls produce tool_use blocks", () => {
      hooks.onAssistantMessage?.({
        step: 1,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Bash", arguments: '{"command":"ls"}' },
            },
          ],
        },
      });
      // includePartialMessages=true means we also get stream_event + assistant message
      const assistantMsg = emitted.find((m) => m.type === "assistant");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg).toMatchObject({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      });
    });
  });

  describe("onToolResult", () => {
    it("success produces user message with is_error: false", () => {
      hooks.onToolResult?.({
        toolName: "Bash",
        toolCallId: "call_1",
        result: { ok: true, summary: "file1.txt\nfile2.txt" },
      });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        type: "user",
        session_id: "test-session",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              is_error: false,
              content: "file1.txt\nfile2.txt",
            },
          ],
        },
      });
    });

    it("failure produces user message with is_error: true", () => {
      hooks.onToolResult?.({
        toolName: "Bash",
        toolCallId: "call_2",
        result: {
          ok: false,
          summary: "command failed",
          error: { code: "EXIT_1", message: "command failed" },
        },
      });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_2",
              is_error: true,
              content: "command failed",
            },
          ],
        },
      });
    });

    it("throws if toolCallId is missing", () => {
      expect(() =>
        hooks.onToolResult?.({
          toolName: "Bash",
          toolCallId: "" as string,
          result: { ok: true, summary: "" },
        }),
      ).toThrow("toolCallId");
    });
  });

  describe("onModelTextDelta", () => {
    it("emits text_delta when includePartialMessages is true", () => {
      hooks.onModelTextDelta?.({ step: 1, text: "hello" });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        type: "stream_event",
        session_id: "test-session",
        event: { type: "text_delta", text: "hello" },
      });
    });

    it("does nothing when includePartialMessages is false", () => {
      const hooksNoPartial = createEventTranslatorHooks({
        sessionId: "test-session",
        emit: (msg) => emitted.push(msg),
        includePartialMessages: false,
      });
      hooksNoPartial.onModelTextDelta?.({ step: 1, text: "hello" });
      expect(emitted).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. mcp-inproc.ts
// ---------------------------------------------------------------------------
import {
  tool,
  toolSpecsFromMcpServer,
  createSdkMcpServer,
} from "../mcp-inproc.js";

describe("mcp-inproc", () => {
  describe("tool()", () => {
    it("returns object with name, description, inputSchema, handler, optional security", () => {
      const handler = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }));
      const schema = {
        type: "object" as const,
        properties: { x: { type: "string" } },
      };
      const security = { risk: "read" as const, defaultMode: "allow" as const };
      const t = tool("myTool", "desc", schema, handler, security);
      expect(t.name).toBe("myTool");
      expect(t.description).toBe("desc");
      expect(t.inputSchema).toBe(schema);
      expect(t.handler).toBe(handler);
      expect(t.security).toEqual(security);
    });

    it("security is undefined when not provided", () => {
      const t = tool("t", "d", {}, async () => ({
        content: [{ type: "text" as const, text: "" }],
      }));
      expect(t.security).toBeUndefined();
    });
  });

  describe("toolSpecsFromMcpServer()", () => {
    it("produces one ToolSpec per tool with names prefixed as mcp__<server>__<tool>", () => {
      const server = createSdkMcpServer({
        name: "myserver",
        tools: [
          tool("read", "read stuff", { type: "object" }, async () => ({
            content: [{ type: "text" as const, text: "r" }],
          })),
          tool("write", "write stuff", { type: "object" }, async () => ({
            content: [{ type: "text" as const, text: "w" }],
          })),
        ],
      });
      const specs = toolSpecsFromMcpServer("myserver", server);
      expect(specs).toHaveLength(2);
      expect(specs[0].definition.function.name).toBe("mcp__myserver__read");
      expect(specs[1].definition.function.name).toBe("mcp__myserver__write");
    });

    it("security defaults to { risk: 'write', defaultMode: 'confirm' } when undefined", () => {
      const server = createSdkMcpServer({
        name: "srv",
        tools: [
          tool("t", "d", { type: "object" }, async () => ({
            content: [{ type: "text" as const, text: "x" }],
          })),
        ],
      });
      const specs = toolSpecsFromMcpServer("srv", server);
      expect(specs[0].security).toEqual({
        risk: "write",
        defaultMode: "confirm",
      });
    });

    it("handler returning text content produces ok: true result", async () => {
      const server = createSdkMcpServer({
        name: "srv",
        tools: [
          tool("echo", "echoes", { type: "object" }, async () => ({
            content: [{ type: "text" as const, text: "hello" }],
          })),
        ],
      });
      const specs = toolSpecsFromMcpServer("srv", server);
      const result = await specs[0].execute({}, {} as never, {} as never);
      expect(result.ok).toBe(true);
      expect(result.summary).toBe("hello");
    });

    it("handler throwing produces ok: false with MCP_TOOL_FAILED code", async () => {
      const server = createSdkMcpServer({
        name: "srv",
        tools: [
          tool("boom", "explodes", { type: "object" }, async () => {
            throw new Error("kaboom");
          }),
        ],
      });
      const specs = toolSpecsFromMcpServer("srv", server);
      const result = await specs[0].execute({}, {} as never, {} as never);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("MCP_TOOL_FAILED");
      expect(result.error?.message).toBe("kaboom");
    });

    it("parseArgs with valid JSON returns parsed object, invalid returns {}", () => {
      const server = createSdkMcpServer({
        name: "srv",
        tools: [
          tool("t", "d", { type: "object" }, async () => ({
            content: [{ type: "text" as const, text: "" }],
          })),
        ],
      });
      const specs = toolSpecsFromMcpServer("srv", server);
      const parsed = specs[0].parseArgs('{"key":"val"}');
      expect(parsed).toEqual({ key: "val" });
      const fallback = specs[0].parseArgs("not-json");
      expect(fallback).toEqual({});
    });
  });
});

// ---------------------------------------------------------------------------
// 5. tool-risk.ts
// ---------------------------------------------------------------------------
import { riskForToolName, isAcceptEditsTool, TOOL_RISK } from "../tool-risk.js";

describe("tool-risk", () => {
  describe("riskForToolName", () => {
    it("known tools return correct risk levels", () => {
      expect(riskForToolName("Read")).toBe("read");
      expect(riskForToolName("Glob")).toBe("read");
      expect(riskForToolName("Grep")).toBe("read");
      expect(riskForToolName("Edit")).toBe("write");
      expect(riskForToolName("Write")).toBe("write");
      expect(riskForToolName("MultiEdit")).toBe("write");
      expect(riskForToolName("Bash")).toBe("execute");
      expect(riskForToolName("BashOutput")).toBe("execute");
    });

    it("mcp__ prefix returns 'write'", () => {
      expect(riskForToolName("mcp__server__tool")).toBe("write");
      expect(riskForToolName("mcp__x__y__z")).toBe("write");
    });

    it("unknown tool returns 'read'", () => {
      expect(riskForToolName("TotallyUnknown")).toBe("read");
      expect(riskForToolName("")).toBe("read");
    });
  });

  describe("isAcceptEditsTool", () => {
    it("returns true for Edit, Write, MultiEdit, NotebookEdit", () => {
      expect(isAcceptEditsTool("Edit")).toBe(true);
      expect(isAcceptEditsTool("Write")).toBe(true);
      expect(isAcceptEditsTool("MultiEdit")).toBe(true);
      expect(isAcceptEditsTool("NotebookEdit")).toBe(true);
    });

    it("returns false for other tools", () => {
      expect(isAcceptEditsTool("Read")).toBe(false);
      expect(isAcceptEditsTool("Bash")).toBe(false);
      expect(isAcceptEditsTool("Grep")).toBe(false);
      expect(isAcceptEditsTool("Unknown")).toBe(false);
    });
  });

  it("TOOL_RISK maps are consistent with isAcceptEditsTool", () => {
    // All accept-edit tools should be in TOOL_RISK
    expect(TOOL_RISK["Edit"]).toBe("write");
    expect(TOOL_RISK["Write"]).toBe("write");
    expect(TOOL_RISK["MultiEdit"]).toBe("write");
    expect(TOOL_RISK["NotebookEdit"]).toBe("write");
  });
});

// ---------------------------------------------------------------------------
// 6. error-codes.ts
// ---------------------------------------------------------------------------
import {
  SdkSessionError,
  ERR_SESSION_NOT_FOUND,
  ERR_TOOL_NOT_SUPPORTED,
} from "../error-codes.js";

describe("SdkSessionError", () => {
  it("sets name, code, message correctly", () => {
    const err = new SdkSessionError(
      ERR_SESSION_NOT_FOUND,
      "session xyz not found",
    );
    expect(err.name).toBe("SdkSessionError");
    expect(err.code).toBe("ERR_SESSION_NOT_FOUND");
    expect(err.message).toBe("session xyz not found");
  });

  it("is an instance of Error", () => {
    const err = new SdkSessionError(ERR_TOOL_NOT_SUPPORTED, "nope");
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// 7. preset.ts
// ---------------------------------------------------------------------------
import { resolvePresetToolSpecs } from "../preset.js";

describe("resolvePresetToolSpecs", () => {
  it('returns non-empty array for "stepfun_code"', () => {
    const specs = resolvePresetToolSpecs("stepfun_code");
    expect(specs.length).toBeGreaterThan(0);
  });

  it("returns empty array for unsupported preset", () => {
    const specs = resolvePresetToolSpecs("nonexistent" as never);
    expect(specs).toEqual([]);
  });

  it("each spec has valid name, security, parseArgs, execute", () => {
    const specs = resolvePresetToolSpecs("stepfun_code");
    for (const spec of specs) {
      expect(spec.definition.function.name).toBeTruthy();
      expect(spec.security).toBeDefined();
      expect(typeof spec.parseArgs).toBe("function");
      expect(typeof spec.execute).toBe("function");
    }
  });

  it("not-supported stubs execute returns { ok: false, error: { code: 'TOOL_NOT_SUPPORTED' } }", async () => {
    const specs = resolvePresetToolSpecs("stepfun_code");
    const taskSpec = specs.find((s) => s.definition.function.name === "Task");
    expect(taskSpec).toBeDefined();
    const result = await taskSpec!.execute({}, {} as never, {} as never);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TOOL_NOT_SUPPORTED");
  });
});

// ---------------------------------------------------------------------------
// 8. input-queue.ts
// ---------------------------------------------------------------------------
import { userTurnTextFromMessage } from "../input-queue.js";
import type { SDKUserMessage } from "../types.js";

describe("userTurnTextFromMessage", () => {
  it("string content returns that string", () => {
    const msg: SDKUserMessage = { role: "user", content: "hello" };
    expect(userTurnTextFromMessage(msg)).toBe("hello");
  });

  it("array of text blocks joined by newline", () => {
    const msg: SDKUserMessage = {
      role: "user",
      content: [
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
        { type: "text", text: "line3" },
      ],
    };
    expect(userTurnTextFromMessage(msg)).toBe("line1\nline2\nline3");
  });

  it("array with no text blocks returns empty string", () => {
    const msg: SDKUserMessage = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "id1", content: "result" }],
    };
    expect(userTurnTextFromMessage(msg)).toBe("");
  });

  it("empty string content returns empty string", () => {
    const msg: SDKUserMessage = { role: "user", content: "" };
    expect(userTurnTextFromMessage(msg)).toBe("");
  });

  it("mixed array with text and non-text blocks only returns text joined", () => {
    const msg: SDKUserMessage = {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "tool_result", tool_use_id: "id1", content: "data" },
        { type: "text", text: "world" },
      ],
    };
    expect(userTurnTextFromMessage(msg)).toBe("hello\nworld");
  });
});
