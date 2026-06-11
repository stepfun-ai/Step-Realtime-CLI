import { describe, it, expect, beforeEach } from "vitest";
import { getSessionStore } from "./session-store.js";
import type { SessionStore } from "./session-store.js";
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
