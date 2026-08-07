/**
 * 网页结果缓存（WebResultCache）。
 *
 * 缓存两层来源：
 *  - `search`：web_search 搜索结果 API 返回的 content 字段（摘要增强版）
 *  - `fetch`：web_fetch 本地提取的完整正文（更完整）
 *
 * web_fetch 优先读缓存，命中且未过期则直接返回；未命中或过期才走网络。
 * web_search 每次执行后把结果写入缓存，供后续 web_fetch 复用。
 *
 * ## 为什么按字节记账，不只按条目数
 *
 * 早先只有 `maxSize = 100`（条目数）一道上限，而单篇正文的唯一约束是 web_fetch 的
 * `MAX_BYTES = 10MB`（且只拦响应体、不拦提取后正文），淘汰逻辑对 1KB 与 10MB 的条目
 * 一视同仁。理论上限 100 × 10MB × UTF-16 双字节 ≈ 2GB，实测灌 150 条 × 2MB 中文正文
 * 后堆驻留 799.4MB（同样输入、仅把缓存清空则为 14.4MB，差 100 倍）。这是长会话 OOM
 * 的主因——尤其多个子 agent 并行抓网页时，它们共享这一个进程级单例，100 条额度被
 * 数倍速填满。
 *
 * 因此改为「字节 + 条目数」双上限，两者任一超限即淘汰。字节按 `str.length * 2` 估算
 * （V8 对含非 Latin1 字符的字符串用 SeqTwoByteString，每字符 2 字节）；不用
 * `Buffer.byteLength(s,'utf8')`，因为它对纯 ASCII 正文会低估一半。
 *
 * ## 为什么 TTL 要主动顺扫
 *
 * TTL 原先只在 `get()` 里惰性检查：没人再读的条目永不过期。子 agent 抓完即走，
 * 那些正文没有第二次 `get`，于是驻留到被条目数挤出为止——4.8 小时的会话理论上该过期
 * 9 轮，实际一条未清。改为 `set()` 时顺扫（n ≤ maxSize，成本可忽略）。
 *
 * ## 为什么不直接用 lru-cache
 *
 * 它的 `maxSize` + `sizeCalculation` 确实是现成方案，但本缓存只有 get/set/clear 三个操作，
 * 引入一个依赖换几十行代码不划算；且自己记账能与实测口径（`length * 2`）保持一致。
 */

/** 字符串的堆字节估算：V8 对含非 Latin1 字符的串用 2 字节/字符，取上界。 */
const estimateBytes = (s: string): number => s.length * 2;

export interface CacheEntry {
  url: string;
  content: string;
  title?: string;
  kind: 'search' | 'fetch';
  cachedAt: number;
  ttlMs: number;
}

/** 缓存容量配置。任一项传 `0` 表示该维度不限制。 */
export interface WebResultCacheLimits {
  /** 条目数上限。默认 100。 */
  maxSize?: number;
  /** 缓存总字节上限（估算值）。默认 32MB。 */
  maxBytes?: number;
  /** 单条字节上限（估算值）；超过则整条不入缓存。默认 2MB。 */
  maxEntryBytes?: number;
}

export const DEFAULT_MAX_SIZE = 100;
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_ENTRY_BYTES = 2 * 1024 * 1024;

export class WebResultCache {
  private cache = new Map<string, CacheEntry>();
  private maxSize: number;
  private maxBytes: number;
  private maxEntryBytes: number;
  /** 当前总字节数（估算）。与 cache 同步维护，避免每次淘汰都重算全表。 */
  private totalBytes = 0;

  constructor(limits: WebResultCacheLimits = {}) {
    this.maxSize = limits.maxSize ?? DEFAULT_MAX_SIZE;
    this.maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxEntryBytes = limits.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  }

  /** 运行时重配缓存容量（loadConfig 之后调用，让 [tools.web] 段生效）。清空已有缓存。 */
  configure(limits: WebResultCacheLimits): void {
    this.maxSize = limits.maxSize ?? DEFAULT_MAX_SIZE;
    this.maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxEntryBytes = limits.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
    this.clear();
  }

  /**
   * 写入缓存。同 URL 已存在时覆盖（新 content 替代旧 content）。
   *
   * 单条超过 `maxEntryBytes` 时**整条不入缓存**并返回 false：这类内容进来就会立刻挤掉
   * 大量小条目，且它本身通常是一次性的大页面，缓存收益低、内存代价高。调用方仍然拿到
   * 完整返回值，只是下次同 URL 需要重新抓取。
   */
  set(entry: Omit<CacheEntry, 'cachedAt'>): boolean {
    const bytes = estimateBytes(entry.content);
    if (this.maxEntryBytes > 0 && bytes > this.maxEntryBytes) {
      // 同 URL 的旧条目要一并清掉，否则会留下一份过时且更小的内容冒充最新结果
      this.delete(entry.url);
      return false;
    }
    const now = Date.now();
    this.delete(entry.url); // 先扣旧条目的字节，再计入新的
    this.cache.set(entry.url, { ...entry, cachedAt: now });
    this.totalBytes += bytes;
    this.pruneExpired(now);
    this.evictIfNeeded();
    return true;
  }

  /** 读取缓存。命中且未过期返回 entry，否则返回 undefined。 */
  get(url: string): CacheEntry | undefined {
    const entry = this.cache.get(url);
    if (entry === undefined) return undefined;
    if (Date.now() - entry.cachedAt > entry.ttlMs) {
      this.delete(url);
      return undefined;
    }
    return entry;
  }

  /** 删除单条并同步扣减字节计数。 */
  delete(url: string): boolean {
    const entry = this.cache.get(url);
    if (entry === undefined) return false;
    this.totalBytes -= estimateBytes(entry.content);
    if (this.totalBytes < 0) this.totalBytes = 0;
    return this.cache.delete(url);
  }

  /** 清空缓存（会话切换 / 用户手动触发时调用）。 */
  clear(): void {
    this.cache.clear();
    this.totalBytes = 0;
  }

  /** 当前缓存条目数。 */
  get size(): number {
    return this.cache.size;
  }

  /** 当前缓存总字节数（估算）。供测试与诊断使用。 */
  get bytes(): number {
    return this.totalBytes;
  }

  /**
   * 主动清除已过期条目。不依赖 get() 触发——只写不读的条目（子 agent 抓完即走的正文）
   * 在惰性策略下永不过期。
   */
  private pruneExpired(now: number): void {
    for (const [url, entry] of this.cache) {
      if (now - entry.cachedAt > entry.ttlMs) this.delete(url);
    }
  }

  /** 淘汰最旧条目，直到条目数与总字节都不超上限（`0` 表示该维度不限）。 */
  private evictIfNeeded(): void {
    const overSize = (): boolean => this.maxSize > 0 && this.cache.size > this.maxSize;
    const overBytes = (): boolean => this.maxBytes > 0 && this.totalBytes > this.maxBytes;
    while (overSize() || overBytes()) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break; // 空表兜底：避免上限配成 0 以下时死循环
      this.delete(oldest.value);
    }
  }
}

/** 全局单例（进程级）。会话切换时调用 clear() 清空。 */
export const webResultCache = new WebResultCache();

/**
 * 用 StepCodeConfig 的 [tools.web] 段重配全局 webResultCache。
 * 未配置 web 段时保持内置默认值（等价于空对象传入 configure）。
 * 每次 loadConfig / reloadConfig 后调用一次即可。
 */
export function configureWebResultCache(config: { web?: { maxSize?: number; maxBytes?: number; maxEntryBytes?: number } }): void {
  webResultCache.configure({
    maxSize: config.web?.maxSize,
    maxBytes: config.web?.maxBytes,
    maxEntryBytes: config.web?.maxEntryBytes,
  });
}
