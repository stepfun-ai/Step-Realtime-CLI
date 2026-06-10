import type { ConversationMemoryState } from "@step-cli/core/agent/conversation-memory.js";

/**
 * In-process LRU keyed by sessionId. Holds ConversationMemoryState snapshots
 * so a follow-up `query({ resume })` can rehydrate the previous turn's
 * memory. Disk persistence can replace the backing store later without
 * changing the contract.
 *
 * The LRU bound prevents unbounded growth in long-lived hosts (e.g. voice
 * mode) that mint many short sessions; least-recently-used entries are
 * evicted when the cap is reached. The `busy` set tracks which sessionIds
 * have an active query() to detect concurrent resume attempts.
 */

const DEFAULT_MAX_SESSIONS = 128;
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h

interface SessionEntry {
  state: ConversationMemoryState;
  lastAccess: number;
}

class SessionStore {
  private readonly snapshots = new Map<string, SessionEntry>();
  private readonly busy = new Set<string>();
  private readonly maxSessions: number;
  private readonly ttlMs: number;

  constructor(maxSessions = DEFAULT_MAX_SESSIONS, ttlMs = DEFAULT_TTL_MS) {
    this.maxSessions = maxSessions;
    this.ttlMs = ttlMs;
  }

  has(sessionId: string): boolean {
    return this.snapshots.has(sessionId) && !this.isExpired(sessionId);
  }

  get(sessionId: string): ConversationMemoryState | undefined {
    this.evictExpired();
    const entry = this.snapshots.get(sessionId);
    if (!entry) return undefined;
    entry.lastAccess = Date.now();
    // Map preserves insertion order: re-insert to mark as most-recently-used.
    this.snapshots.delete(sessionId);
    this.snapshots.set(sessionId, entry);
    return entry.state;
  }

  set(sessionId: string, state: ConversationMemoryState): void {
    this.evictExpired();
    if (this.snapshots.has(sessionId)) this.snapshots.delete(sessionId);
    this.snapshots.set(sessionId, { state, lastAccess: Date.now() });
    while (this.snapshots.size > this.maxSessions) {
      const oldest = this.snapshots.keys().next().value;
      if (!oldest) break;
      this.snapshots.delete(oldest);
    }
  }

  delete(sessionId: string): void {
    this.snapshots.delete(sessionId);
    this.busy.delete(sessionId);
  }

  markBusy(sessionId: string): boolean {
    if (this.busy.has(sessionId)) return false;
    this.busy.add(sessionId);
    return true;
  }

  releaseBusy(sessionId: string): void {
    this.busy.delete(sessionId);
  }

  isBusy(sessionId: string): boolean {
    return this.busy.has(sessionId);
  }

  clear(): void {
    this.snapshots.clear();
    this.busy.clear();
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, entry] of this.snapshots) {
      if (entry.lastAccess < cutoff) this.snapshots.delete(id);
    }
  }

  private isExpired(sessionId: string): boolean {
    const entry = this.snapshots.get(sessionId);
    if (!entry) return true;
    return entry.lastAccess < Date.now() - this.ttlMs;
  }
}

const globalStore = new SessionStore();

export function getSessionStore(): SessionStore {
  return globalStore;
}

export type { SessionStore };
