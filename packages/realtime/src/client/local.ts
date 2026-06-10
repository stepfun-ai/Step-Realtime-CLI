import {
  readFile,
  writeFile,
  appendFile,
  mkdir,
  rename,
  unlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../util/logger.js";
import type { Message } from "../types/events.js";
import type { Client, MemoryItem, SessionMeta, SessionLoad } from "./types.js";

const log = logger.child({ component: "client.local" });

export interface LocalClientOpts {
  /** Path to the memory JSONL file. */
  memoryPath: string;
  /** Directory holding per-session JSONL files + index.jsonl. */
  sessionsDir: string;
  /** Directory holding per-coding-task JSONL files. Defaults to
   *  `<sessionsDir>/../coding`. P4. */
  codingDir?: string;
  /** Path to preferences.json (single-file kv). Defaults to
   *  `<sessionsDir>/../preferences.json`. P5.1. */
  preferencesPath?: string;
}

/**
 * Local JSONL-backed Client.
 *
 * Memory:
 *   <memoryPath>          single file, "load all → upsert → atomic rewrite"
 *
 * Sessions:
 *   <sessionsDir>/index.jsonl   accumulation log of SessionMeta; latest-by-id wins
 *   <sessionsDir>/{id}.jsonl    append-only per-session message log
 *
 * Concurrency: assumes a single harness process. Multi-process safety is P5.
 */
export class LocalClient implements Client {
  private memoryLoadCache?: MemoryItem[];

  constructor(private readonly opts: LocalClientOpts) {}

  // ────────────────── memory ─────────────────────────────────────

  async memory_write(key: string, value: string): Promise<void> {
    const items = await this.loadMemoryAll();
    const now = Date.now();
    const i = items.findIndex((x) => x.key === key);
    if (i >= 0) {
      items[i].value = value;
      items[i].updatedAt = now;
    } else {
      items.push({ key, value, createdAt: now, updatedAt: now });
    }
    await this.saveMemoryAll(items);
  }

  async memory_read(key: string): Promise<string | undefined> {
    const items = await this.loadMemoryAll();
    return items.find((x) => x.key === key)?.value;
  }

  async memory_recall(query: string, limit = 10): Promise<MemoryItem[]> {
    const items = await this.loadMemoryAll();
    const byRecent = (xs: MemoryItem[]) =>
      [...xs].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
    if (!query.trim()) return byRecent(items);

    // Tokenize the query so the model's semantic / Chinese / multi-keyword
    // searches don't miss exact-substring matches. Each token can be:
    //   - a whitespace-separated word
    //   - a dot-separated key path segment ("preferences.voice" -> "preferences","voice")
    //   - an individual CJK character
    // We treat ANY token hitting either side as a match.
    const tokens = tokenize(query);
    const ranked = items
      .map((x) => ({ item: x, score: scoreItem(x, tokens) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt)
      .slice(0, limit)
      .map((r) => r.item);
    if (ranked.length > 0) return ranked;

    // No keyword overlap. The model's query likely used a semantic synonym
    // (e.g. asked "口味" when the stored key is "favorite_tea"). Fall back
    // to the most-recent items so the model can scan and pick instead of
    // saying "no memory found" when memory actually does have the info.
    return byRecent(items);
  }

  private async loadMemoryAll(): Promise<MemoryItem[]> {
    if (this.memoryLoadCache) return this.memoryLoadCache;
    if (!existsSync(this.opts.memoryPath)) {
      this.memoryLoadCache = [];
      return this.memoryLoadCache;
    }
    const raw = await readFile(this.opts.memoryPath, "utf-8");
    const out: MemoryItem[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        log.warn({ line: line.slice(0, 80) }, "skipping corrupt memory line");
      }
    }
    this.memoryLoadCache = out;
    return out;
  }

  private async saveMemoryAll(items: MemoryItem[]): Promise<void> {
    await ensureDir(dirname(this.opts.memoryPath));
    const tmp = this.opts.memoryPath + ".tmp";
    const lines = items.map((x) => JSON.stringify(x)).join("\n") + "\n";
    await writeFile(tmp, lines, "utf-8");
    await rename(tmp, this.opts.memoryPath);
    this.memoryLoadCache = items;
  }

  // ────────────────── session ────────────────────────────────────

  async session_create(opts?: {
    id?: string;
    title?: string;
    backend?: string;
  }): Promise<SessionMeta> {
    const id = opts?.id ?? randomUUID();
    const now = Date.now();
    const meta: SessionMeta = {
      id,
      title: opts?.title ?? "新会话",
      createdAt: now,
      lastActivityAt: now,
      messageCount: 0,
      backend: opts?.backend ?? "unknown",
    };
    await this.appendIndex(meta);
    log.info({ id, title: meta.title }, "session created");
    return meta;
  }

  async session_list(): Promise<SessionMeta[]> {
    const indexPath = this.indexPath();
    if (!existsSync(indexPath)) return [];
    const raw = await readFile(indexPath, "utf-8");
    const latest = new Map<string, SessionMeta>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line) as SessionMeta;
        latest.set(m.id, m);
      } catch {
        log.warn({ line: line.slice(0, 80) }, "skipping corrupt index line");
      }
    }
    return [...latest.values()].sort(
      (a, b) => b.lastActivityAt - a.lastActivityAt,
    );
  }

  async session_load(id: string): Promise<SessionLoad | null> {
    const list = await this.session_list();
    const meta = list.find((m) => m.id === id);
    if (!meta) return null;
    const file = this.sessionFile(id);
    const messages: Message[] = [];
    if (existsSync(file)) {
      const raw = await readFile(file, "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          messages.push(JSON.parse(line));
        } catch {
          log.warn(
            { line: line.slice(0, 80) },
            "skipping corrupt message line",
          );
        }
      }
    }
    return { meta, messages };
  }

  async session_append(id: string, message: Message): Promise<void> {
    await ensureDir(this.opts.sessionsDir);
    await appendFile(this.sessionFile(id), JSON.stringify(message) + "\n");
  }

  async session_replace(id: string, messages: Message[]): Promise<void> {
    await ensureDir(this.opts.sessionsDir);
    const path = this.sessionFile(id);
    const tmp = path + ".tmp";
    const body =
      messages.map((m) => JSON.stringify(m)).join("\n") +
      (messages.length ? "\n" : "");
    await writeFile(tmp, body);
    await rename(tmp, path);
  }

  async session_meta_set(
    id: string,
    patch: Partial<Omit<SessionMeta, "id" | "createdAt">>,
  ): Promise<void> {
    const list = await this.session_list();
    const cur = list.find((m) => m.id === id);
    if (!cur) throw new Error(`session not found: ${id}`);
    const merged: SessionMeta = {
      ...cur,
      ...patch,
      lastActivityAt: patch.lastActivityAt ?? Date.now(),
    };
    await this.appendIndex(merged);
  }

  // ────────────────── helpers ────────────────────────────────────

  private indexPath(): string {
    return join(this.opts.sessionsDir, "index.jsonl");
  }

  private sessionFile(id: string): string {
    return join(this.opts.sessionsDir, `${id}.jsonl`);
  }

  private codingDir(): string {
    return this.opts.codingDir ?? join(this.opts.sessionsDir, "..", "coding");
  }

  coding_log_path(taskId: string): string {
    return join(this.codingDir(), `${taskId}.jsonl`);
  }

  async coding_log_append(taskId: string, envelope: unknown): Promise<void> {
    await ensureDir(this.codingDir());
    await appendFile(
      this.coding_log_path(taskId),
      JSON.stringify(envelope) + "\n",
    );
  }

  async coding_delete(taskId: string): Promise<void> {
    try {
      await unlink(this.coding_log_path(taskId));
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        log.warn({ err, taskId }, "coding_delete unlink failed");
      }
    }
  }

  // ────────────────── preferences (P5.1) ────────────────────────

  private preferencesCache?: Record<string, string>;

  private preferencesPath(): string {
    return (
      this.opts.preferencesPath ??
      join(this.opts.sessionsDir, "..", "preferences.json")
    );
  }

  private async loadPreferences(): Promise<Record<string, string>> {
    if (this.preferencesCache) return this.preferencesCache;
    const path = this.preferencesPath();
    if (!existsSync(path)) {
      this.preferencesCache = {};
      return this.preferencesCache;
    }
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string") obj[k] = v;
        }
        this.preferencesCache = obj;
        return obj;
      }
    } catch (err) {
      log.warn({ err, path }, "preferences.json corrupt; treating as empty");
    }
    this.preferencesCache = {};
    return this.preferencesCache;
  }

  async preferences_get(key: string): Promise<string | undefined> {
    const all = await this.loadPreferences();
    return all[key];
  }

  async preferences_set(key: string, value: string): Promise<void> {
    const all = await this.loadPreferences();
    all[key] = value;
    const path = this.preferencesPath();
    await ensureDir(dirname(path));
    const tmp = path + ".tmp";
    await writeFile(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, path);
    this.preferencesCache = all;
  }

  private async appendIndex(meta: SessionMeta): Promise<void> {
    await ensureDir(this.opts.sessionsDir);
    await appendFile(this.indexPath(), JSON.stringify(meta) + "\n");
  }
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** Break a search query into tokens: whitespace words, dot-path segments,
 *  and individual CJK characters. Each token is lowercased for matching. */
function tokenize(query: string): string[] {
  const out = new Set<string>();
  for (const word of query.toLowerCase().split(/[\s.,;:!?，。、；：！？]+/)) {
    if (!word) continue;
    out.add(word);
    for (const seg of word.split(".")) if (seg) out.add(seg);
    // also each CJK character as its own token (so "口味" -> ["口", "味"])
    for (const ch of word) if (/\p{Script=Han}/u.test(ch)) out.add(ch);
  }
  return [...out];
}

/** Count how many tokens of the query hit (substring) the key or value. */
function scoreItem(item: MemoryItem, tokens: string[]): number {
  const haystack = (item.key + " " + item.value).toLowerCase();
  let score = 0;
  for (const t of tokens) if (haystack.includes(t)) score++;
  return score;
}
