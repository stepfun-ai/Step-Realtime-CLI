import { describe, expect, it } from 'vitest';
import { WebResultCache } from '../../src/tools/webCache.js';

describe('WebResultCache', () => {
  it('写入后能通过 URL 读回', () => {
    const cache = new WebResultCache();
    cache.set({ url: 'https://example.com', content: 'hello', kind: 'fetch', ttlMs: 60_000 });
    const entry = cache.get('https://example.com');
    expect(entry).toBeDefined();
    expect(entry!.content).toBe('hello');
  });

  it('过期条目返回 undefined 并删除', () => {
    const cache = new WebResultCache();
    cache.set({ url: 'https://example.com', content: 'hello', kind: 'fetch', ttlMs: 1 });
    expect(cache.get('https://example.com')).toBeDefined();
    // 等待过期
    const start = Date.now();
    while (Date.now() - start < 10) {
      // busy-wait 一小段时间，保证 ttl 过期
    }
    expect(cache.get('https://example.com')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('容量恰好为 maxSize：可稳定保存 maxSize 个不同 URL', () => {
    const cache = new WebResultCache({ maxSize: 3 });
    cache.set({ url: 'a', content: 'A', kind: 'fetch', ttlMs: 60_000 });
    cache.set({ url: 'b', content: 'B', kind: 'fetch', ttlMs: 60_000 });
    cache.set({ url: 'c', content: 'C', kind: 'fetch', ttlMs: 60_000 });
    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();

    // 写入第四条时淘汰最旧的 a
    cache.set({ url: 'd', content: 'D', kind: 'fetch', ttlMs: 60_000 });
    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.get('d')).toBeDefined();
  });

  it('覆盖同 URL 不触发额外淘汰', () => {
    const cache = new WebResultCache({ maxSize: 2 });
    cache.set({ url: 'a', content: 'A', kind: 'fetch', ttlMs: 60_000 });
    cache.set({ url: 'b', content: 'B', kind: 'fetch', ttlMs: 60_000 });
    cache.set({ url: 'a', content: 'A2', kind: 'fetch', ttlMs: 60_000 });
    expect(cache.size).toBe(2);
    expect(cache.get('a')!.content).toBe('A2');
    expect(cache.get('b')).toBeDefined();
  });

  // --- 字节预算（OOM 主因修复：条目数口径拦不住 1KB 与 10MB 的差别）---

  it('单条超过 maxEntryBytes：整条不入缓存，size 不增', () => {
    const cache = new WebResultCache({ maxEntryBytes: 100 });
    // estimateBytes = length * 2，故 51 字符 = 102 字节 > 100
    const ok = cache.set({ url: 'big', content: 'x'.repeat(51), kind: 'fetch', ttlMs: 60_000 });
    expect(ok).toBe(false);
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
    expect(cache.get('big')).toBeUndefined();
  });

  it('单条超限时，同 URL 的旧条目一并清除（不留过时内容冒充最新）', () => {
    const cache = new WebResultCache({ maxEntryBytes: 100 });
    expect(cache.set({ url: 'u', content: 'small', kind: 'fetch', ttlMs: 60_000 })).toBe(true);
    expect(cache.set({ url: 'u', content: 'y'.repeat(51), kind: 'fetch', ttlMs: 60_000 })).toBe(false);
    expect(cache.get('u')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('总字节超过 maxBytes：淘汰最旧条目直到回到预算内', () => {
    // 每条 10 字符 = 20 字节；预算 50 字节 → 最多驻留 2 条
    const cache = new WebResultCache({ maxBytes: 50, maxSize: 0 });
    cache.set({ url: 'a', content: 'a'.repeat(10), kind: 'fetch', ttlMs: 60_000 });
    cache.set({ url: 'b', content: 'b'.repeat(10), kind: 'fetch', ttlMs: 60_000 });
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(40);
    cache.set({ url: 'c', content: 'c'.repeat(10), kind: 'fetch', ttlMs: 60_000 });
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(40);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('字节计数随删除与覆盖同步扣减', () => {
    const cache = new WebResultCache();
    cache.set({ url: 'a', content: 'a'.repeat(10), kind: 'fetch', ttlMs: 60_000 });
    expect(cache.bytes).toBe(20);
    cache.set({ url: 'a', content: 'a'.repeat(3), kind: 'fetch', ttlMs: 60_000 });
    expect(cache.bytes).toBe(6);
    cache.delete('a');
    expect(cache.bytes).toBe(0);
    cache.set({ url: 'b', content: 'bb', kind: 'fetch', ttlMs: 60_000 });
    cache.clear();
    expect(cache.bytes).toBe(0);
    expect(cache.size).toBe(0);
  });

  it('maxBytes/maxEntryBytes 传 0 表示该维度不限制', () => {
    const cache = new WebResultCache({ maxBytes: 0, maxEntryBytes: 0, maxSize: 0 });
    for (let i = 0; i < 20; i++) {
      expect(cache.set({ url: `u${String(i)}`, content: 'z'.repeat(1000), kind: 'fetch', ttlMs: 60_000 })).toBe(true);
    }
    expect(cache.size).toBe(20);
  });

  // --- 主动 TTL（子 agent 抓完即走的正文在惰性策略下永不过期）---

  it('写入新条目时主动清除已过期条目（无需 get 触发）', () => {
    const cache = new WebResultCache();
    cache.set({ url: 'stale', content: 'old', kind: 'fetch', ttlMs: 1 });
    expect(cache.size).toBe(1);
    const start = Date.now();
    while (Date.now() - start < 10) {
      // busy-wait 越过 ttl
    }
    // 关键：全程不对 'stale' 调 get()，仅靠 set() 的顺扫清除
    cache.set({ url: 'fresh', content: 'new', kind: 'fetch', ttlMs: 60_000 });
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(6); // 只剩 'new' = 3 字符 × 2
  });
});
