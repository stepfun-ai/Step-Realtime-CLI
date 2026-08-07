import { describe, expect, it } from 'vitest';
import { resolveWebCacheConfig } from '../src/config/config.js';

describe('resolveWebCacheConfig（[tools.web] 段解析）', () => {
  it('缺省 → undefined（键不进结果对象）', () => {
    expect(resolveWebCacheConfig(undefined)).toBeUndefined();
    expect(resolveWebCacheConfig('not-object')).toBeUndefined();
    expect(resolveWebCacheConfig({})).toBeUndefined();
    expect(resolveWebCacheConfig([])).toBeUndefined();
  });

  it('三个字段全部未配置 → undefined', () => {
    expect(resolveWebCacheConfig({ other: 1 })).toBeUndefined();
  });

  it('仅配 max_size', () => {
    expect(resolveWebCacheConfig({ max_size: 200 })).toEqual({ maxSize: 200, maxBytes: 0, maxEntryBytes: 0 });
  });

  it('仅配 max_bytes', () => {
    expect(resolveWebCacheConfig({ max_bytes: 50_000_000 })).toEqual({
      maxSize: 0,
      maxBytes: 50_000_000,
      maxEntryBytes: 0,
    });
  });

  it('三字段全配', () => {
    expect(resolveWebCacheConfig({ max_size: 100, max_bytes: 32_000_000, max_entry_bytes: 2_000_000 })).toEqual({
      maxSize: 100,
      maxBytes: 32_000_000,
      maxEntryBytes: 2_000_000,
    });
  });

  it('非法类型（字符串/布尔/null）→ 视为未配置，落到 0 → undefined', () => {
    // 非法类型经 clampInt 落到 0，三字段全 0 → 返回 undefined（键不进结果对象）
    expect(resolveWebCacheConfig({ max_size: 'x', max_bytes: null, max_entry_bytes: true })).toBeUndefined();
  });

  it('负数 → clamp 到 0 → undefined（三字段全 0 等效于不配置）', () => {
    expect(resolveWebCacheConfig({ max_size: -10, max_bytes: -1, max_entry_bytes: -100 })).toBeUndefined();
  });

  it('浮点数 → 取整', () => {
    expect(resolveWebCacheConfig({ max_size: 100.7, max_bytes: 32_000_000.3 })).toEqual({
      maxSize: 101,
      maxBytes: 32_000_000,
      maxEntryBytes: 0,
    });
  });

  it('超上限 clamp：max_size 上限 1_000_000，max_bytes 上限 1GB，max_entry_bytes 上限 100MB', () => {
    expect(resolveWebCacheConfig({ max_size: 9_999_999, max_bytes: 9_999_999_999, max_entry_bytes: 999_999_999 })).toEqual({
      maxSize: 1_000_000,
      maxBytes: 1_073_741_824,
      maxEntryBytes: 104_857_600,
    });
  });

  it('全部为 0 → undefined（三字段 0 和不配置等效，键不进结果对象）', () => {
    expect(resolveWebCacheConfig({ max_size: 0, max_bytes: 0, max_entry_bytes: 0 })).toBeUndefined();
  });
});
