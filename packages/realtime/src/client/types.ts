/**
 * Client — user-data access layer.
 *
 * P3 scope: memory (key/value) + session (persistent conversation log).
 * P5+: extend with preferences, user profile, etc.
 *
 * Implementations:
 *   - LocalClient (P3): JSONL files under ~/.realtime-agent/
 *   - CloudClient (P5+): HTTP/RPC to a remote user-data service
 *
 * Business code (RealtimeSession, Capability) talks to this interface
 * only — implementation chooses local/cloud/hybrid.
 */

import type { Message } from "../types/events.js";

export interface MemoryItem {
  key: string;
  value: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  backend: string; // e.g. "stepfun_stateless"
}

export interface SessionLoad {
  meta: SessionMeta;
  messages: Message[];
}

export interface Client {
  // ─── Memory (kv with keyword recall) ───────────────────────────
  memory_write(key: string, value: string): Promise<void>;
  memory_read(key: string): Promise<string | undefined>;
  memory_recall(query: string, limit?: number): Promise<MemoryItem[]>;

  // ─── Session ──────────────────────────────────────────────────
  /** Create a new empty session with optional title/backend hint. */
  session_create(opts?: {
    id?: string;
    title?: string;
    backend?: string;
  }): Promise<SessionMeta>;
  /** List all session metas, newest-active first. */
  session_list(): Promise<SessionMeta[]>;
  /** Load a session's meta + replay its messages. Returns null if not found. */
  session_load(id: string): Promise<SessionLoad | null>;
  /** Append a single message to the session log. */
  session_append(id: string, message: Message): Promise<void>;
  /** Overwrite the session's message log with a new list. Used by history
   *  mutation paths (user rewind, auto compaction) that need to delete or
   *  replace existing messages — the JSONL append-only flow can't represent
   *  those. Atomic via write-then-rename. */
  session_replace(id: string, messages: Message[]): Promise<void>;
  /** Patch mutable meta fields (title / messageCount). */
  session_meta_set(
    id: string,
    patch: Partial<Omit<SessionMeta, "id" | "createdAt">>,
  ): Promise<void>;

  // ─── Coding agent (P4) ────────────────────────────────────────
  /** Append one envelope line to coding/{taskId}.jsonl. Best-effort; missing
   *  parent dir is created. Used by SM to persist the full SDK event stream
   *  per coding task. */
  coding_log_append(taskId: string, envelope: unknown): Promise<void>;
  /** Delete coding/{taskId}.jsonl. Missing file is not an error. Triggered
   *  when the user rewinds a coding turn from the UI. */
  coding_delete(taskId: string): Promise<void>;
  /** Absolute path resolver (mainly for tests / debugging). */
  coding_log_path(taskId: string): string;

  // ─── Preferences (P5.1) ───────────────────────────────────────
  /** Read a single string-valued preference. Returns undefined if unset. */
  preferences_get(key: string): Promise<string | undefined>;
  /** Set a single string-valued preference. */
  preferences_set(key: string, value: string): Promise<void>;
}
