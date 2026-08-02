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
    const cache = new WebResultCache(3);
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
    const cache = new WebResultCache(2);
    cache.set({ url: 'a', content: 'A', kind: 'fetch', ttlMs: 60_000 });
    cache.set({ url: 'b', content: 'B', kind: 'fetch', ttlMs: 60_000 });
    cache.set({ url: 'a', content: 'A2', kind: 'fetch', ttlMs: 60_000 });
    expect(cache.size).toBe(2);
    expect(cache.get('a')!.content).toBe('A2');
    expect(cache.get('b')).toBeDefined();
  });
});
