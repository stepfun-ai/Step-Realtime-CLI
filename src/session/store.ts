import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mapBlocksDeep, type AnyContentBlock, type StoredMessage } from '../agent/message.js';
import type { GoalState } from '../agent/goal/mode.js';
import type { PermissionMode } from '../agent/permission/mode.js';
import {
  applyWireEvent,
  closeDanglingToolUse,
  emptyWireReplayState,
  notifyDedupKeyFromOrigin,
  parseWireLine,
  WIRE_FORMAT_VERSION,
  type WireEvent,
} from '../agent/wirelog.js';
import { AttachmentStore, isStepref } from './attachments.js';

export interface SessionMeta {
  id: string;
  cwd: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  /** 消息条数，便于列表展示。 */
  messageCount: number;
  /** 会话标题（从首条 user 消息派生），供选择器/列表辨认，旧快照可能缺失。 */
  title?: string;
  /** 用户自定义会话名（rename 设置；空名/纯空白即清除）。展示口径为 name ?? title。 */
  name?: string;
  /** 首条 user 消息预览（截 200 字符），供选择器搜索匹配，旧快照可能缺失。 */
  preview?: string;
  /** 谱系：本会话由哪个会话 fork 而来（单层 parent）。 */
  forkedFrom?: string;
  /** 父会话 id（仅子 agent 会话填写；与 forkedFrom 语义正交：fork 是同级分叉，parentId 是派生）。 */
  parentId?: string;
  /** 派生深度（仅子 agent 会话填写，主会话 = 0 不填）。 */
  depth?: number;
  /** 子 agent 角色（如 explore / general / 自定义；仅子 agent 会话填写）。 */
  agentType?: string;
  /** 子会话终态（仅子 agent 会话填写：父进程仍活着时子会话可能已终态；主会话不填）。 */
  status?: 'running' | 'done' | 'error' | 'aborted';
}

export interface SessionData extends SessionMeta {
  messages: StoredMessage[];
  /** TODO 任务清单（独立存储，不占对话历史）。 */
  todos?: { title: string; status: 'pending' | 'in_progress' | 'done' }[];
  /** goal 状态快照（随会话持久化；恢复时 active 降级 paused，fork 不继承）。 */
  goal?: GoalState;
  /** team 团队模式快照（档案目录与基准仓；恢复时档案目录被删则静默降级未激活）。 */
  team?: import('../agent/team/mode.js').TeamSnapshot;
  /** 权限模式快照（会话级，随会话持久化；恢复时读回，旧快照缺失回退启动默认）。 */
  mode?: PermissionMode;
  /** 会话级思考深度覆盖（'off' / 档位名，如 'low' / 'medium' / 'high'），undefined = 回退 config 默认。 */
  thinkOverride?: string;
  /** 会话级 Plan 模式。 */
  planMode?: boolean;
  /**
   * 待发队列：busy 期间排队、尚未发送的消息（含排队的斜杠命令）。
   *
   * 随会话持久化的理由是它是「用户已经输入但还没被处理」的内容——丢了就得重新想一遍
   * 刚才要说什么。恢复时原样接回队列，回合结束后照常自动发送。
   */
  queue?: string[];
  /**
   * 检查点游标：本快照覆盖到事件日志（wire.jsonl）的第几条事件。
   * 快照自本版本起降级为「检查点 + 派生缓存」，事件日志才是事实源；resume 时从本游标
   * 之后的尾段事件开始重放。本字段缺失时快照不可作检查点：resume 忽略其 messages，
   * 从空基底全量重放事件（破坏性语义，不保留旧快照消息）。
   */
  wireSeq?: number;
}

/** resume 产物：检查点 + 尾段重放后的完整会话态，外加通知幂等集合（供后台任务对账用）。 */
export interface ResumeResult {
  /** 重建后的会话（messages/非消息状态已含尾段事件效果；悬空 tool_use 已闭合）。 */
  session: SessionData;
  /** 已送达通知的幂等键集合（delivered 事件 + background_task 消息回填），供 reconcile 补投判定。 */
  deliveredNotifications: Set<string>;
  /** 是否在恢复时合成了悬空 tool_use 的错误 tool_result。 */
  closedDanglingToolUse: boolean;
  /** 被闭合的 tool_use id 列表（审计用）。 */
  closedToolUseIds: string[];
  /** 本次重放的尾段事件条数。 */
  replayedEvents: number;
}

/** 把工作目录映射为稳定、文件系统安全的短键（避免超长路径与非法字符）。 */
export function workdirKey(cwd: string): string {
  const norm = cwd.replace(/\\/g, '/').toLowerCase();
  return createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

/** 标题最大字符数，超出截断加省略号。 */
const TITLE_MAX = 50;
/** 预览最大字符数（供搜索匹配，比标题长以覆盖首条消息更多内容）。 */
const PREVIEW_MAX = 200;
/** 索引文件固定名。 */
const INDEX_FILE = '_index.json';
/** 索引格式版本。 */
const INDEX_VERSION = 1;

/** 会话列表索引结构。 */
interface SessionIndex {
  version: typeof INDEX_VERSION;
  rebuiltAt: string;
  sessions: SessionMeta[];
}

/**
 * 抽取首条 user 消息的纯文本（string 直接用；数组拼接所有 text 块），折叠空白/换行为单空格并 trim。
 * 无 user 消息或纯空返回 undefined。deriveTitle / derivePreview 共用。
 *
 * 也接受 `user_verbatim`（压缩保真下来的用户原话）：长会话被压缩后，最早的真人输入已不在
 * 历史里，此时保真下来的第一条恰好就是它——正是最好的标题来源。若只认 `user`，
 * 压缩过的会话标题会退化成 undefined 或取到很晚的一条消息。
 */
function firstUserText(messages: StoredMessage[]): string | undefined {
  const first = messages.find((m) => m.origin.kind === 'user' || m.origin.kind === 'user_verbatim');
  if (first === undefined) return undefined;
  const content = first.message.content;
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else {
    const parts: string[] = [];
    for (const block of content) {
      if (block.type === 'text') parts.push(block.text);
    }
    text = parts.join(' ');
  }
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? undefined : collapsed;
}

/** 从首条 user 消息派生会话标题，截断到 TITLE_MAX。无内容返回 undefined。 */
export function deriveTitle(messages: StoredMessage[]): string | undefined {
  const t = firstUserText(messages);
  if (t === undefined) return undefined;
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX)}…` : t;
}

/** 从首条 user 消息派生搜索预览，截断到 PREVIEW_MAX。无内容返回 undefined。 */
export function derivePreview(messages: StoredMessage[]): string | undefined {
  const t = firstUserText(messages);
  if (t === undefined) return undefined;
  return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX)}…` : t;
}

/**
 * 会话持久化：每个会话一份 JSON 快照，按工作目录分桶存放。
 * 布局：<baseDir>/<workdirKey>/<sessionId>.json
 * 每回合结束后 save 一次；--continue 载入该工作目录下最新会话。
 */
export class SessionStore {
  private readonly baseDir: string;
  /** 引用式附件存储（与本 store 共享 baseDir）：落盘前把图片 base64 卸载成内容寻址文件。 */
  readonly attachments: AttachmentStore;
  /**
   * appendFull 的 seen-id 缓存（key = workdirKey/cwd + 会话 id）：首次写某个会话的全量日志时
   * loadFull 一次建立去重集合，之后每次 append 直接用内存集合，不再全文重读重解析。
   * 一致性前提：全量日志只由本进程追加（单写者）；外部删文件后本进程内的缓存会过期，属可接受边界。
   */
  private readonly fullSeen = new Map<string, Set<string>>();
  /** 事件日志条数缓存（key 同 fullSeen）：appendWire/loadWire 维护，save 写检查点游标时取用。 */
  private readonly wireCounts = new Map<string, number>();

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), '.step-code', 'sessions');
    this.attachments = new AttachmentStore(this.baseDir);
  }

  private dirFor(cwd: string): string {
    return join(this.baseDir, workdirKey(cwd));
  }

  /** cron 任务持久化目录：<baseDir>/cron/<workdirKey>（按 cwd 分桶，不属于任何单个会话）。 */
  cronDirFor(cwd: string): string {
    return join(this.baseDir, 'cron', workdirKey(cwd));
  }

  /** 子 agent 会话持久化目录：<baseDir>/<workdirKey>/subagents（独立命名空间，不进主会话桶）。 */
  subagentDirFor(cwd: string): string {
    return join(this.dirFor(cwd), 'subagents');
  }

  private fileFor(cwd: string, id: string): string {
    return join(this.dirFor(cwd), `${id}.json`);
  }

  /** 事件日志（append-only JSONL）路径：会话状态机的事实源。 */
  private wireFileFor(cwd: string, id: string): string {
    return join(this.dirFor(cwd), `${id}.wire.jsonl`);
  }

  /** 后台任务持久化目录：<桶目录>/<sessionId>.tasks/<taskId>/（meta.json + output.log）。 */
  tasksDirFor(cwd: string, id: string): string {
    return join(this.dirFor(cwd), `${id}.tasks`);
  }

  /** 索引文件路径：<桶目录>/_index.json。 */
  private indexPathFor(cwd: string): string {
    return join(this.dirFor(cwd), INDEX_FILE);
  }

  /**
   * 调试导出用：返回某会话的落盘文件路径（会话桶目录 + JSON 快照 + 事件日志 JSONL）。
   * 复用内部路径规则，供 debugBundle 收集，避免在外部重算 workdirKey。
   */
  sessionPaths(cwd: string, id: string): { dir: string; json: string; wire: string } {
    return {
      dir: this.dirFor(cwd),
      json: this.fileFor(cwd, id),
      wire: this.wireFileFor(cwd, id),
    };
  }

  /** 从 SessionData 投影出索引可存储的元信息。 */
  private toIndexEntry(data: SessionData): SessionMeta {
    return {
      id: data.id,
      cwd: data.cwd,
      model: data.model,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      messageCount: data.messageCount ?? 0,
      name: data.name,
      title: data.title,
      preview: data.preview,
    };
  }

  /** 读取索引；不存在或解析失败返回 null。 */
  private readIndex(cwd: string): SessionIndex | null {
    const file = this.indexPathFor(cwd);
    if (!existsSync(file)) return null;
    try {
      const raw = readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as SessionIndex;
      if (parsed.version !== INDEX_VERSION) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** 写入索引（原子写）。 */
  private writeIndex(cwd: string, index: SessionIndex): void {
    const dir = this.dirFor(cwd);
    mkdirSync(dir, { recursive: true });
    const file = this.indexPathFor(cwd);
    writeAtomic(file, JSON.stringify(index));
  }

  /** 索引是否过期：true = 需要重建。 */
  private isIndexStale(cwd: string, index: SessionIndex): boolean {
    const dir = this.dirFor(cwd);
    if (!existsSync(dir)) return false;
    try {
      const rebuiltAt = new Date(index.rebuiltAt).getTime();
      if (Number.isNaN(rebuiltAt)) return true;
      let latestMtime = 0;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (entry.name === INDEX_FILE) continue;
        const full = join(dir, entry.name);
        try {
          const mtime = statSync(full).mtimeMs;
          if (mtime > latestMtime) latestMtime = mtime;
        } catch {
          // 忽略读取失败
        }
      }
      // >= 而非 >：与 SubagentStore 同源的毫秒精度竞态——同毫秒内的直改
      // mtime 等于 rebuiltAt 时 > 会漏判索引过期，等值按过期处理（详见
      // subagent/store.ts 同款注释）。
      return latestMtime >= rebuiltAt;
    } catch {
      return true;
    }
  }

  /** 全量重建索引并写入磁盘。 */
  private rebuildIndex(cwd: string): SessionMeta[] {
    const dir = this.dirFor(cwd);
    const sessions: SessionMeta[] = [];
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        if (entry.name === INDEX_FILE) continue;
        const name = entry.name;
        try {
          const data = JSON.parse(readFileSync(join(dir, name), 'utf8')) as SessionData;
          sessions.push(this.toIndexEntry(data));
        } catch {
          // 跳过损坏文件
        }
      }
    }
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const index: SessionIndex = {
      version: INDEX_VERSION,
      rebuiltAt: new Date().toISOString(),
      sessions,
    };
    this.writeIndex(cwd, index);
    return sessions;
  }

  /** 增量更新索引中的单个会话（upsert）。 */
  private updateIndexEntry(cwd: string, entry: SessionMeta): void {
    const index = this.readIndex(cwd) ?? { version: INDEX_VERSION, rebuiltAt: new Date().toISOString(), sessions: [] };
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

  /** 新建一个空会话（尚未落盘）。 */
  create(cwd: string, model: string, mode?: PermissionMode): SessionData {
    const now = new Date().toISOString();
    return {
      id: randomId(),
      cwd,
      model,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      messages: [],
      mode,
    };
  }

  /**
   * 落盘前投影：返回一条 StoredMessage 的浅拷贝，其中每个 base64 图片块的 `source.data`
   * 换成 `stepref:<sha256>`（同步把字节 offload 到 attachments/）。小图（<阈值）与已是 stepref 的原样保留。
   * 下钻 tool_result 的数组 content：read_media 回传的内嵌图片同样 offload。
   * 只作用于写盘副本，绝不改动入参——内存里的 history.current 保持原始 base64。无图消息原样返回同引用。
   * public：子 agent 会话存储（subagent/store.ts）复用同一套落盘投影。
   */
  offloadForStorage(cwd: string, m: StoredMessage): StoredMessage {
    const mapped = mapBlocksDeep(m.message.content, (block) => {
      // 图片与视频块同一卸载通道：视频字节更大（可达几十 MB），不走 stepref 会把会话文件撑爆
      if ((block.type !== 'image' && block.type !== 'video') || block.source.type !== 'base64') return block;
      const data = block.source.data;
      if (isStepref(data)) return block;
      const ref = this.attachments.offload(cwd, data, block.source.media_type);
      if (ref === data) return block;
      return { ...block, source: { ...block.source, data: ref } } as AnyContentBlock;
    });
    if (!mapped.changed) return m;
    return { ...m, message: { ...m.message, content: mapped.content } };
  }

  /** 保存会话快照（覆盖写）。会更新 updatedAt 与 messageCount，并在缺 title 时派生。 */
  save(session: SessionData): void {
    const dir = this.dirFor(session.cwd);
    mkdirSync(dir, { recursive: true });
    session.updatedAt = new Date().toISOString();
    session.messageCount = session.messages.length;
    if (session.title === undefined || session.title === '') {
      const derived = deriveTitle(session.messages);
      if (derived !== undefined) session.title = derived;
    }
    if (session.preview === undefined || session.preview === '') {
      const preview = derivePreview(session.messages);
      if (preview !== undefined) session.preview = preview;
    }
    const wireCount = this.wireEventCount(session.cwd, session.id);
    if (wireCount !== undefined) session.wireSeq = wireCount;
    const toWrite: SessionData = {
      ...session,
      messages: session.messages.map((m) => this.offloadForStorage(session.cwd, m)),
    };
    writeAtomic(this.fileFor(session.cwd, session.id), JSON.stringify(toWrite, null, 2));
    this.updateIndexEntry(session.cwd, this.toIndexEntry(toWrite));
  }

  /** 按 id 载入。找不到返回 null。 */
  load(cwd: string, id: string): SessionData | null {
    const file = this.fileFor(cwd, id);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as SessionData;
    } catch {
      return null;
    }
  }

  /**
   * 向事件日志（wire.jsonl，append-only）追加事件。只追加、永不重写。
   * - 文件不存在时先补一行 metadata 事件（标识格式版本），再追加本次事件；
   * - context.append_message 事件按消息 id 去重（seen-id 集合按会话缓存，语义同旧 appendFull）；
   * - 其余事件类型不去重，按序追加；
   * - append_message / apply_compaction 的消息载荷落盘前做图片 stepref 卸载（作用于副本，不污染入参）。
   * 返回本次实际追加的事件条数。
   */
  appendWire(cwd: string, id: string, events: readonly WireEvent[]): number {
    if (events.length === 0) return 0;
    const cacheKey = `${workdirKey(cwd)}${id}`;
    let priorCount = this.wireCounts.get(cacheKey);
    let seen = this.fullSeen.get(cacheKey);
    if (seen === undefined) {
      // 首次写该会话的事件日志：建立去重集合
      const loaded = this.loadWire(cwd, id);
      priorCount = loaded.length;
      seen = new Set(
        loaded
          .filter((e) => e.type === 'context.append_message')
          .map((e) => e.message.id),
      );
      this.fullSeen.set(cacheKey, seen);
    }
    const fresh: WireEvent[] = [];
    for (const e of events) {
      if (e.type === 'context.append_message') {
        if (seen.has(e.message.id)) continue;
        seen.add(e.message.id); // 同批次内也去重
      }
      fresh.push(e);
    }
    if (fresh.length === 0) return 0;
    const dir = this.dirFor(cwd);
    mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    const file = this.wireFileFor(cwd, id);
    if (!existsSync(file)) {
      lines.push(
        JSON.stringify({
          type: 'metadata',
          version: WIRE_FORMAT_VERSION,
          sessionId: id,
          createdAt: new Date().toISOString(),
        } satisfies WireEvent),
      );
    }
    for (const e of fresh) {
      if (e.type === 'context.append_message') {
        lines.push(JSON.stringify({ ...e, message: this.offloadForStorage(cwd, e.message) }));
      } else if (e.type === 'context.apply_compaction') {
        lines.push(
          JSON.stringify({ ...e, messages: e.messages.map((m) => this.offloadForStorage(cwd, m)) }),
        );
      } else {
        lines.push(JSON.stringify(e));
      }
    }
    appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    // 条数缓存含可能刚写入的 metadata 行（priorCount 在 seen 缓存命中时必然也已缓存）
    this.wireCounts.set(cacheKey, (priorCount ?? 0) + lines.length);
    return fresh.length;
  }

  /**
   * 读回事件日志的全部事件（按写入顺序）。
   * 损坏行与崩溃截断的尾行跳过。
   * 副作用：刷新该会话的条数缓存（供 save 写检查点游标）。
   */
  loadWire(cwd: string, id: string): WireEvent[] {
    const events: WireEvent[] = [];
    const wireFile = this.wireFileFor(cwd, id);
    if (existsSync(wireFile)) {
      for (const line of this.readLines(wireFile)) {
        const event = parseWireLine(line);
        if (event !== null) events.push(event);
      }
    }
    this.wireCounts.set(`${workdirKey(cwd)}${id}`, events.length);
    return events;
  }

  /** 事件日志当前条数：优先缓存；无缓存且日志文件存在时现场统计；无日志返回 undefined。 */
  private wireEventCount(cwd: string, id: string): number | undefined {
    const cacheKey = `${workdirKey(cwd)}${id}`;
    const cached = this.wireCounts.get(cacheKey);
    if (cached !== undefined) return cached;
    if (!existsSync(this.wireFileFor(cwd, id))) {
      return undefined;
    }
    return this.loadWire(cwd, id).length;
  }

  /** 读文件并按行返回（空行剔除）。文件读失败返回空数组。 */
  private readLines(file: string): string[] {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    return raw.split('\n').filter((l) => l.trim() !== '');
  }

  /**
   * 向全量历史日志追加消息：语义不变（按 id 去重、只追加），
   * 底层写为 context.append_message 事件进 wire.jsonl。
   * 压缩链路（loop.replaceMessages / /compact）只动 history.current 与 JSON 快照，
   * 绝不触碰事件日志——它是 /reflect 能遍历完整历史的唯一保证。
   */
  appendFull(cwd: string, id: string, messages: readonly StoredMessage[]): number {
    const events: WireEvent[] = messages.map((m) => ({
      type: 'context.append_message',
      ts: m.ts,
      message: m,
    }));
    return this.appendWire(cwd, id, events);
  }

  /** 读回全量历史日志的所有消息（按写入顺序，取自 wire.jsonl 的 append_message 事件）。 */
  loadFull(cwd: string, id: string): StoredMessage[] {
    return this.loadWire(cwd, id)
      .filter((e) => e.type === 'context.append_message')
      .map((e) => e.message);
  }

  /**
   * resume 恢复入口：检查点（.json 快照）+ 事件日志尾段重放。
   *
   * 步骤（对齐设计「resume 流程」的前三步；第 4 步后台任务对账由调用方拿到
   * deliveredNotifications 后自行触发，不在本方法内）：
   * 1. 读快照检查点作为恢复基底（无快照但有事件日志时从空基底全量重放）；
   * 2. 重放游标（wireSeq）之后的尾段事件，重建内存态。游标缺失（无快照或旧快照）
   *    时快照不可作检查点：忽略其 messages，从空基底全量重放事件——事件才是事实源。
   *    这是破坏性语义：旧快照的 messages 不再保留；
   * 3. 闭合末尾悬空 tool_use（合成 is_error 的 tool_result，不假装成功、不改写日志）。
   *
   * restore 无副作用契约：本方法是纯读取——不写盘、不追加事件、不投递通知、
   * 不调度任务（内存缓存刷新除外）。重复调用结果一致。
   */
  resume(cwd: string, id: string): ResumeResult | null {
    const snapshot = this.load(cwd, id);
    const events = this.loadWire(cwd, id);
    if (snapshot === null && events.length === 0) return null;

    // 1. 基底 + 2. 尾段切片：有游标时快照作检查点、只重放游标后尾段；
    // 无游标（无快照或旧快照）时忽略快照 messages，从空基底全量重放。
    const state = emptyWireReplayState();
    let tail: WireEvent[];
    if (snapshot?.wireSeq !== undefined) {
      state.messages = [...snapshot.messages];
      state.mode = snapshot.mode;
      state.planMode = snapshot.planMode;
      state.thinkOverride = snapshot.thinkOverride;
      state.goal = snapshot.goal;
      // 不变量：persist 先写事件后存快照，游标只会落后（崩溃窗口）永不超前于快照
      // 内容，尾段事件必然是快照之外的新消息。超前 = 历史已被旧版本污染，不兜底。
      tail = events.slice(snapshot.wireSeq);
    } else {
      tail = events;
    }
    for (const event of tail) applyWireEvent(state, event);

    const session: SessionData = snapshot ?? { ...this.create(cwd, ''), id };
    session.messages = state.messages;
    session.mode = state.mode;
    session.planMode = state.planMode;
    // 「清除类」事件与「从未设置」的区分：尾段出现该事件才采信重放值（可为 undefined = 清除），
    // 否则保留快照原值
    if (tail.some((e) => e.type === 'think.set')) session.thinkOverride = state.thinkOverride;
    if (tail.some((e) => e.type === 'goal.update')) session.goal = state.goal;
    if (tail.some((e) => e.type === 'queue.update')) session.queue = state.queue;
    session.wireSeq = events.length;

    // 已送达集合：delivered 事件 add-only，全流回放幂等；另从最终消息历史回填
    // （通知消息进了历史即视为送达，覆盖「delivered 事件丢失但消息已落盘」的崩溃窗口）
    for (const event of events) {
      if (event.type === 'background.notify_delivered') applyWireEvent(state, event);
    }
    for (const m of state.messages) {
      const origin = m.origin;
      if (origin.kind === 'background_task' && origin.notificationId !== undefined) {
        state.deliveredNotifications.add(notifyDedupKeyFromOrigin(origin.taskId, origin.notificationId));
      }
    }

    // 3. 闭合末尾悬空 tool_use
    const closure = closeDanglingToolUse(session.messages);
    session.messages = closure.messages;

    return {
      session,
      deliveredNotifications: state.deliveredNotifications,
      closedDanglingToolUse: closure.closed,
      closedToolUseIds: closure.closedToolUseIds,
      replayedEvents: tail.length,
    };
  }

  /**
   * 列出该工作目录下所有**有事件日志**的会话 id（升序）。
   *
   * 与 {@link list} 的区别是事实源不同：`list` 按 `<id>.json` 快照列举，
   * 而本方法按 `<id>.wire.jsonl` 列举。两者会不一致——会话在写完事件日志后
   * 若未走到 save（崩溃、强杀），就只有事件日志没有快照。实测某工作目录下
   * 79 个事件日志里有 7 个没有对应快照。
   *
   * 因此凡以事件日志为数据源的统计（如 `/usage`）必须用本方法列举，
   * 用 `list` 会静默漏掉这些会话；反之需要标题、模型、更新时间等元信息时用 `list`。
   */
  listWireSessionIds(cwd: string): string[] {
    const dir = this.dirFor(cwd);
    if (!existsSync(dir)) return [];
    const suffix = '.wire.jsonl';
    const ids: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(suffix)) continue;
      ids.push(entry.name.slice(0, -suffix.length));
    }
    return ids.sort();
  }

  /** 列出该工作目录下的会话元信息，按 updatedAt 倒序。只扫桶根文件：subagents/ 等子目录不属于主会话列表。 */
  list(cwd: string): SessionMeta[] {
    const dir = this.dirFor(cwd);
    if (!existsSync(dir)) return [];
    // 优先读索引
    const index = this.readIndex(cwd);
    if (index !== null && !this.isIndexStale(cwd, index)) {
      return index.sessions;
    }
    // 索引不存在或过期：全量重建
    return this.rebuildIndex(cwd);
  }

  /** 该工作目录下最近更新的会话，供 --continue 使用。 */
  latest(cwd: string): SessionData | null {
    const metas = this.list(cwd);
    const newest = metas[0];
    return newest === undefined ? null : this.load(cwd, newest.id);
  }

  /** 删除指定会话的快照文件。存在并删成功返回 true，否则 false。 */
  delete(cwd: string, id: string): boolean {
    const file = this.fileFor(cwd, id);
    try {
      if (!existsSync(file)) return false;
      unlinkSync(file);
      // 事件日志与后台任务持久化目录一并删除：快照没了之后这些文件不再有入口
      // （/resume、/reflect 都按快照定位），留下只会随会话越删越多形成孤儿文件。
      // seen-id 与条数缓存同步失效，避免同名 id 复用时跳过写入。
      rmSync(this.wireFileFor(cwd, id), { force: true });
      rmSync(this.tasksDirFor(cwd, id), { recursive: true, force: true });
      this.fullSeen.delete(`${workdirKey(cwd)}${id}`);
      this.wireCounts.delete(`${workdirKey(cwd)}${id}`);
      // 同步更新索引
      this.removeIndexEntry(cwd, id);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 重命名会话：读快照→改 name→写回。空名/纯空白 = 清除自定义名，展示回退 title。
   * 直接写文件、不经过 save()：rename 不刷新 updatedAt，避免改个名就把会话顶到列表最前。
   * 会话不存在返回 false。
   */
  rename(cwd: string, id: string, name: string): boolean {
    const data = this.load(cwd, id);
    if (data === null) return false;
    const trimmed = name.trim();
    if (trimmed === '') {
      delete data.name;
    } else {
      data.name = trimmed;
    }
    writeAtomic(this.fileFor(cwd, id), JSON.stringify(data, null, 2));
    // 同步更新索引（不改变 updatedAt，保持与文件一致）
    this.updateIndexEntry(cwd, this.toIndexEntry(data));
    return true;
  }

  /**
   * 写入 AI 生成的标题。与 rename 同一模式：直接写文件、不刷新 updatedAt，
   * 不把会话顶到 /resume 列表最前（标题只是元数据变化，不是会话活动）。
   */
  updateTitle(cwd: string, id: string, title: string): boolean {
    const data = this.load(cwd, id);
    if (data === null) return false;
    data.title = title;
    writeAtomic(this.fileFor(cwd, id), JSON.stringify(data, null, 2));
    this.updateIndexEntry(cwd, this.toIndexEntry(data));
    return true;
  }
}

/** tmp + rename 原子写：先写临时文件再替换目标，避免半写文件被当成完整快照。 */
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

function randomId(): string {
  // 时间前缀 + 随机，便于人读且不冲突
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 6);
  return `${ts}-${rand}`;
}
