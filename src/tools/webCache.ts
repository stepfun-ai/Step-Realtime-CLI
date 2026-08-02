/**
 * 网页结果缓存（WebResultCache）。
 *
 * 缓存两层来源：
 *  - `search`：web_search 搜索结果 API 返回的 content 字段（摘要增强版）
 *  - `fetch`：web_fetch 本地提取的完整正文（更完整）
 *
 * web_fetch 优先读缓存，命中且未过期则直接返回；未命中或过期才走网络。
 * web_search 每次执行后把结果写入缓存，供后续 web_fetch 复用。
 */

export interface CacheEntry {
  url: string;
  content: string;
  title?: string;
  kind: 'search' | 'fetch';
  cachedAt: number;
  ttlMs: number;
}

export class WebResultCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
  }

  /** 写入缓存。同 URL 已存在时覆盖（新 content 替代旧 content）。 */
  set(entry: Omit<CacheEntry, 'cachedAt'>): void {
    this.cache.set(entry.url, {
      ...entry,
      cachedAt: Date.now(),
    });
    this.evictIfNeeded();
  }

  /** 读取缓存。命中且未过期返回 entry，否则返回 undefined。 */
  get(url: string): CacheEntry | undefined {
    const entry = this.cache.get(url);
    if (entry === undefined) return undefined;
    if (Date.now() - entry.cachedAt > entry.ttlMs) {
      this.cache.delete(url);
      return undefined;
    }
    return entry;
  }

  /** 清空缓存（会话切换 / 用户手动触发时调用）。 */
  clear(): void {
    this.cache.clear();
  }

  /** 当前缓存条目数。 */
  get size(): number {
    return this.cache.size;
  }

  /** 淘汰最旧条目，直到容量不超过 maxSize。 */
  private evictIfNeeded(): void {
    while (this.cache.size > this.maxSize) {
      const oldest = this.cache.keys().next().value!;
      this.cache.delete(oldest);
    }
  }
}

/** 全局单例（进程级）。会话切换时调用 clear() 清空。 */
export const webResultCache = new WebResultCache();
