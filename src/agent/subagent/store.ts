import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type StoredMessage } from '../message.js';
import { deriveTitle, type SessionData, type SessionMeta, type SessionStore } from '../../session/store.js';

/**
 * 活跃锁内容（格式冻结）：pid + 启动时间戳。
 * 清理与 resume 路径据此判断子会话是否正在运行，必须跳过持锁会话。
 */
export interface SubagentLock {
  pid: number;
  startedAt: string;
}

/** delete 的结果：deleted = 已删；locked = 持有活跃锁拒删；missing = 不存在。 */
export type SubagentDeleteResult = 'deleted' | 'locked' | 'missing';

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

  /** 保存子会话快照（tmp + rename 原子覆写）。更新 updatedAt / messageCount，缺 title 时派生。 */
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

  /** 列出该工作目录下的子会话元信息，按 updatedAt 倒序。 */
  list(cwd: string): SessionMeta[] {
    const dir = this.dir(cwd);
    if (!existsSync(dir)) return [];
    const metas: SessionMeta[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const data = JSON.parse(readFileSync(join(dir, entry.name), 'utf8')) as SessionData;
        const messages = data.messages ?? [];
        metas.push({
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
        // 跳过损坏文件
      }
    }
    metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return metas;
  }

  /**
   * 删除子会话的全部落盘文件（快照 + 全量日志 + 锁）。
   * 持有活跃锁的子会话拒删：删除后运行中的 agent 会写入已删除的文件句柄，数据静默丢失。
   */
  delete(cwd: string, id: string): SubagentDeleteResult {
    if (existsSync(this.lockFileFor(cwd, id))) return 'locked';
    const file = this.fileFor(cwd, id);
    if (!existsSync(file)) return 'missing';
    try {
      rmSync(file, { force: true });
      rmSync(this.fullFileFor(cwd, id), { force: true });
      this.fullSeen.delete(`${cwd}${id}`);
      return 'deleted';
    } catch {
      return 'missing';
    }
  }

  /**
   * 建立活跃锁（独占创建，已存在则失败返回 false）。
   * 锁内容格式冻结：{ pid, startedAt }，供清理路径与后续 resume 判断"当前是否在跑"。
   */
  acquireLock(cwd: string, id: string): boolean {
    mkdirSync(this.dir(cwd), { recursive: true });
    const lock: SubagentLock = { pid: process.pid, startedAt: new Date().toISOString() };
    try {
      writeFileSync(this.lockFileFor(cwd, id), JSON.stringify(lock), { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch {
      return false;
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
