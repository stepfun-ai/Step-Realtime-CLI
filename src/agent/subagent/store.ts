import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type StoredMessage } from '../message.js';
import { deriveTitle, type SessionData, type SessionMeta, type SessionStore } from '../../session/store.js';

/**
 * 活跃锁内容（格式冻结）：pid + 启动时间戳。
 * 清理与 resume 路径据此判断子会话是否正在运行，必须跳过持锁会话。
 *
 * 向后兼容语义：旧锁文件若缺少 pid 字段或 JSON 解析失败，视为 stale（残留锁），
 * acquireLock / delete 会直接回收后继续操作。自本版本起写入的锁均含 pid。
 */
export interface SubagentLock {
  pid: number;
  startedAt: string;
}

/** delete 的结果：deleted = 已删；locked = 持有活跃锁拒删；missing = 不存在。 */
export type SubagentDeleteResult = 'deleted' | 'locked' | 'missing';

/** 子会话列表索引结构（与主 SessionStore 的 SessionIndex 同构，独立命名空间）。 */
interface SubagentIndex {
  version: typeof SUBAGENT_INDEX_VERSION;
  rebuiltAt: string;
  sessions: SessionMeta[];
}

/** 子会话目录下索引文件固定名。 */
const SUBAGENT_INDEX_FILE = '_index.json';
/** 子会话索引格式版本。 */
const SUBAGENT_INDEX_VERSION = 1;

/**
 * 子 agent 会话持久层：与主会话同一套「快照 + 全量日志双写」语义，落在独立命名空间。
 * 布局：<baseDir>/<workdirKey>/subagents/<subId>.json（快照）+ <subId>.full.jsonl（全量日志）+ <subId>.lock（活跃锁）。
 * 独立子目录是为了不污染主会话桶（SessionStore.list 只扫桶根，/resume 与 --continue 看不到子会话）。
 * 注入现有 SessionStore：复用 baseDir 分桶、attachments offload 与 deriveTitle，不另起第二套存储语义。
 *
 * 边界确认：/reflect 按主会话 id 经 SessionStore.loadFull 直读 `<workdirKey>/<mainId>.wire.jsonl`（无目录扫描），
 * 本目录下的子会话日志天然不在其遍历范围内——子 agent 历史面向事后追查，不进方法论回顾。
 *
 * id 用 randomUUID：秒级时间戳 + 短随机的 randomId 在同秒并发派生时有碰撞风险，
 * 碰撞后果是两个无关任务的历史写入同一文件，UUID 直接消除。
 */
export class SubagentStore {
  constructor(private readonly sessions: SessionStore) {}

  /** 引用式附件存储（与主会话共享）：resume 回灌历史后由 toWire 把 stepref 图片还原成 base64。 */
  get attachments(): SessionStore['attachments'] {
    return this.sessions.attachments;
  }

  /** appendMessages 的 seen-id 缓存（key = workdirKey/cwd + 子会话 id），语义同 SessionStore.fullSeen。 */
  private readonly fullSeen = new Map<string, Set<string>>();

  private dir(cwd: string): string {
    return this.sessions.subagentDirFor(cwd);
  }

  private indexPathFor(cwd: string): string {
    return join(this.dir(cwd), SUBAGENT_INDEX_FILE);
  }

  /** 读取索引；不存在或解析失败返回 null。 */
  private readIndex(cwd: string): SubagentIndex | null {
    const file = this.indexPathFor(cwd);
    if (!existsSync(file)) return null;
    try {
      const raw = readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as SubagentIndex;
      if (parsed.version !== SUBAGENT_INDEX_VERSION) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** 写入索引（原子写：tmp + rename）。 */
  private writeIndex(cwd: string, index: SubagentIndex): void {
    mkdirSync(this.dir(cwd), { recursive: true });
    const file = this.indexPathFor(cwd);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(index), 'utf8');
    renameSync(tmp, file);
  }

  /**
   * 索引是否过期：true = 需要重建。
   *
   * 口径与主 SessionStore 一致：扫描子会话目录下所有文件（快照 .json、日志 .jsonl、锁 .lock），
   * 跳过索引文件本身；若有任何文件的 mtime 晚于索引 rebuiltAt，则视为过期。
   * 锁文件变动（acquire/release 写/删 .lock）会更新目录 mtime，持锁/释锁也会触发索引刷新。
   */
  private isIndexStale(cwd: string, index: SubagentIndex): boolean {
    const dir = this.dir(cwd);
    if (!existsSync(dir)) return false;
    try {
      const rebuiltAt = new Date(index.rebuiltAt).getTime();
      if (Number.isNaN(rebuiltAt)) return true;
      let latestMtime = 0;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (entry.name === SUBAGENT_INDEX_FILE) continue;
        const full = join(dir, entry.name);
        try {
          const mtime = statSync(full).mtimeMs;
          if (mtime > latestMtime) latestMtime = mtime;
        } catch {
          // 忽略读取失败的文件
        }
      }
      // >= 而非 >：rebuiltAt 是毫秒精度墙钟，与「写索引后同毫秒内直改快照」的
      // mtime 相等时，> 会把这次直改漏掉（索引误新鲜，cleanup/列表读到旧数据——
      // 实测 Windows CI 上 cleanup ttl_days 用例因此随机失败）。等值按过期处理，
      // 代价仅是偶发一次多余重建。
      return latestMtime >= rebuiltAt;
    } catch {
      return true;
    }
  }

  /** 全量重建索引并写入磁盘：只收录 <id>.json 快照，跳过 .lock / .jsonl。 */
  private rebuildIndex(cwd: string): SessionMeta[] {
    const dir = this.dir(cwd);
    const sessions: SessionMeta[] = [];
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        // 仅处理 .json 快照；.lock（锁文件）和 .jsonl（全量日志）不属于会话元信息
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        if (entry.name === SUBAGENT_INDEX_FILE) continue;
        try {
          const data = JSON.parse(readFileSync(join(dir, entry.name), 'utf8')) as SessionData;
          const messages = data.messages ?? [];
          sessions.push({
            id: data.id,
            cwd: data.cwd,
            model: data.model,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            messageCount: data.messageCount ?? messages.length,
            title: data.title ?? deriveTitle(messages),
            parentId: data.parentId,
            depth: data.depth,
            agentType: data.agentType,
            status: data.status,
          });
        } catch {
          // 跳过损坏的快照文件
        }
      }
    }
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const index: SubagentIndex = {
      version: SUBAGENT_INDEX_VERSION,
      rebuiltAt: new Date().toISOString(),
      sessions,
    };
    this.writeIndex(cwd, index);
    return sessions;
  }

  /** 增量更新索引中的单个会话（upsert）。 */
  private updateIndexEntry(cwd: string, entry: SessionMeta): void {
    const index = this.readIndex(cwd) ?? {
      version: SUBAGENT_INDEX_VERSION,
      rebuiltAt: new Date().toISOString(),
      sessions: [],
    };
    const idx = index.sessions.findIndex((s) => s.id === entry.id);
    if (idx >= 0) {
      index.sessions[idx] = entry;
    } else {
      index.sessions.push(entry);
    }
    // 保持倒序
    index.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    index.rebuiltAt = new Date().toISOString();
    this.writeIndex(cwd, index);
  }

  /** 从索引中移除单个会话。 */
  private removeIndexEntry(cwd: string, id: string): void {
    const index = this.readIndex(cwd);
    if (index === null) return;
    index.sessions = index.sessions.filter((s) => s.id !== id);
    index.rebuiltAt = new Date().toISOString();
    this.writeIndex(cwd, index);
  }

  private fileFor(cwd: string, id: string): string {
    return join(this.dir(cwd), `${id}.json`);
  }

  private fullFileFor(cwd: string, id: string): string {
    return join(this.dir(cwd), `${id}.full.jsonl`);
  }

  private lockFileFor(cwd: string, id: string): string {
    return join(this.dir(cwd), `${id}.lock`);
  }

  /** 新建一个子会话（尚未落盘）：id 为 UUID，状态 running。 */
  create(
    cwd: string,
    init: { model: string; agentType: string; depth: number; parentId?: string },
  ): SessionData {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      cwd,
      model: init.model,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      messages: [],
      parentId: init.parentId,
      depth: init.depth,
      agentType: init.agentType,
      status: 'running',
    };
  }

  /** 保存子会话快照（tmp + rename 原子覆写）。更新 updatedAt / messageCount，缺 title 时派生，同步更新索引。 */
  saveSnapshot(session: SessionData): void {
    const dir = this.dir(session.cwd);
    mkdirSync(dir, { recursive: true });
    session.updatedAt = new Date().toISOString();
    session.messageCount = session.messages.length;
    if (session.title === undefined || session.title === '') {
      const derived = deriveTitle(session.messages);
      if (derived !== undefined) session.title = derived;
    }
    const toWrite: SessionData = {
      ...session,
      messages: session.messages.map((m) => this.sessions.offloadForStorage(session.cwd, m)),
    };
    const file = this.fileFor(session.cwd, session.id);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(toWrite, null, 2), 'utf8');
    renameSync(tmp, file);
    // 同步更新索引
    this.updateIndexEntry(session.cwd, {
      id: toWrite.id,
      cwd: toWrite.cwd,
      model: toWrite.model,
      createdAt: toWrite.createdAt,
      updatedAt: toWrite.updatedAt,
      messageCount: toWrite.messageCount,
      title: toWrite.title,
      parentId: toWrite.parentId,
      depth: toWrite.depth,
      agentType: toWrite.agentType,
      status: toWrite.status,
    });
  }

  /**
   * 向子会话全量日志追加消息（按 id 去重、只追加）。语义同 SessionStore.appendFull：
   * 压缩只动快照不触碰 JSONL。seen-id 集合按会话缓存，首次 append 时 loadFull 一次。
   */
  appendMessages(cwd: string, id: string, messages: readonly StoredMessage[]): number {
    if (messages.length === 0) return 0;
    const cacheKey = `${cwd}${id}`;
    let seen = this.fullSeen.get(cacheKey);
    if (seen === undefined) {
      seen = new Set(this.loadFull(cwd, id).map((m) => m.id));
      this.fullSeen.set(cacheKey, seen);
    }
    const fresh: StoredMessage[] = [];
    for (const m of messages) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      fresh.push(m);
    }
    if (fresh.length === 0) return 0;
    mkdirSync(this.dir(cwd), { recursive: true });
    const payload = fresh.map((m) => JSON.stringify(this.sessions.offloadForStorage(cwd, m))).join('\n') + '\n';
    appendFileSync(this.fullFileFor(cwd, id), payload, 'utf8');
    return fresh.length;
  }

  /** 按 id 载入快照。找不到或损坏返回 null。 */
  loadSnapshot(cwd: string, id: string): SessionData | null {
    const file = this.fileFor(cwd, id);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as SessionData;
    } catch {
      return null;
    }
  }

  /** 读回子会话全量日志（按写入顺序）。文件不存在或损坏行跳过，返回已解析部分。 */
  loadFull(cwd: string, id: string): StoredMessage[] {
    const file = this.fullFileFor(cwd, id);
    if (!existsSync(file)) return [];
    const out: StoredMessage[] = [];
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return out;
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as StoredMessage);
      } catch {
        // 跳过损坏行，尽量返回可用部分
      }
    }
    return out;
  }

  /** 列出该工作目录下的子会话元信息，按 updatedAt 倒序。优先读索引缓存，缺失或过期时自动重建。 */
  list(cwd: string): SessionMeta[] {
    const dir = this.dir(cwd);
    if (!existsSync(dir)) return [];
    // 优先读索引
    const index = this.readIndex(cwd);
    if (index !== null && !this.isIndexStale(cwd, index)) {
      return index.sessions;
    }
    // 索引不存在或过期：全量重建
    return this.rebuildIndex(cwd);
  }

  /** 判定锁文件是否持有存活进程：解析 pid 后用 process.kill(pid, 0) 探测；解析失败/pid 已死均视为 stale。 */
  private isLockAlive(lockPath: string): boolean {
    try {
      const raw = readFileSync(lockPath, 'utf8');
      const lock = JSON.parse(raw) as SubagentLock;
      if (typeof lock.pid !== 'number') return false; // 旧锁无 pid，保守视为 stale
      // pid ≤ 0 是非法数据（POSIX 下 -1 是「发信号给全部进程」的特殊值，
      // kill(-1, 0) 会误判为存活），按 stale 处理
      if (lock.pid <= 0) return false;
      process.kill(lock.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 删除子会话的全部落盘文件（快照 + 全量日志 + 锁）。
   * 持有活跃锁的子会话拒删：删除后运行中的 agent 会写入已删除的文件句柄，数据静默丢失。
   * 锁存在但 pid 已死（stale）时视为无锁，允许删除。
   */
  delete(cwd: string, id: string): SubagentDeleteResult {
    const lockPath = this.lockFileFor(cwd, id);
    if (existsSync(lockPath)) {
      if (this.isLockAlive(lockPath)) return 'locked';
      try { rmSync(lockPath, { force: true }); } catch { /* 忽略 */ }
    }
    const file = this.fileFor(cwd, id);
    if (!existsSync(file)) return 'missing';
    try {
      rmSync(file, { force: true });
      rmSync(this.fullFileFor(cwd, id), { force: true });
      this.fullSeen.delete(`${cwd}${id}`);
      // 同步更新索引
      this.removeIndexEntry(cwd, id);
      return 'deleted';
    } catch {
      return 'missing';
    }
  }

  /**
   * 建立活跃锁（独占创建，已存在则失败返回 false）。
   * 锁内容格式冻结：{ pid, startedAt }，供清理路径与后续 resume 判断"当前是否在跑"。
   *
   * stale 检测：发现锁文件已存在时，读取 pid 并用 process.kill(pid, 0) 判活。
   * - 进程已死或旧锁无 pid → 视为 stale，回收锁文件后重试一次获取。
   * - 进程仍存活 → 照旧拒绝，返回 false。
   */
  acquireLock(cwd: string, id: string): boolean {
    mkdirSync(this.dir(cwd), { recursive: true });
    const lock: SubagentLock = { pid: process.pid, startedAt: new Date().toISOString() };
    const lockPath = this.lockFileFor(cwd, id);
    try {
      writeFileSync(lockPath, JSON.stringify(lock), { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch {
      // 锁已存在：读 pid 判活，stale 则回收后重试一次
      if (this.isLockAlive(lockPath)) return false;
      try { rmSync(lockPath, { force: true }); } catch { /* 忽略 */ }
      try {
        writeFileSync(lockPath, JSON.stringify(lock), { encoding: 'utf8', flag: 'wx' });
        return true;
      } catch {
        return false;
      }
    }
  }

  /** 释放活跃锁（不存在也算成功）。 */
  releaseLock(cwd: string, id: string): void {
    try {
      rmSync(this.lockFileFor(cwd, id), { force: true });
    } catch {
      // 锁释放失败不阻塞主流程；残留锁会让 delete 拒删，由用户显式处理
    }
  }

  /**
   * 级联删除：删主会话时连带删其全部子会话（parentId 匹配）。持活跃锁的子会话跳过。
   * 返回实际删除的子会话数。
   */
  deleteWithParent(cwd: string, parentId: string): number {
    let count = 0;
    for (const m of this.list(cwd)) {
      if (m.parentId !== parentId) continue;
      if (this.delete(cwd, m.id) === 'deleted') count++;
    }
    return count;
  }

  /**
   * 留存清理（[subagent.retention]）：maxSessions > 0 时按 updatedAt 删最旧、ttlDays > 0 时删过期。
   * 全部为 0 即默认形态，不动任何文件。持活跃锁的子会话一律跳过。返回实际删除数。
   */
  cleanup(cwd: string, opts: { maxSessions?: number; ttlDays?: number }): number {
    const maxSessions = opts.maxSessions ?? 0;
    const ttlDays = opts.ttlDays ?? 0;
    if (maxSessions <= 0 && ttlDays <= 0) return 0;
    const metas = this.list(cwd); // 已按 updatedAt 倒序
    const cutoff = ttlDays > 0 ? Date.now() - ttlDays * 24 * 60 * 60 * 1000 : 0;
    let count = 0;
    for (const [i, m] of metas.entries()) {
      const overMax = maxSessions > 0 && i >= maxSessions;
      const expired = cutoff > 0 && Date.parse(m.updatedAt) < cutoff;
      if (!overMax && !expired) continue;
      if (this.delete(cwd, m.id) === 'deleted') count++;
    }
    return count;
  }
}
