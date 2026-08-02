import { describe, expect, it } from 'vitest';
import { resolveSearchConfig, resolveSearchEndpoint } from '../src/config/config.js';
import { resolveSearchToolEndpoint } from '../src/tools/searchBase.js';

describe('resolveSearchConfig', () => {
  it('缺省 / 非对象 → 空对象（键不进结果对象）', () => {
    expect(resolveSearchConfig(undefined)).toEqual({});
    expect(resolveSearchConfig('not-object')).toEqual({});
    expect(resolveSearchConfig(null)).toEqual({});
  });

  it('通用段 url/key 全配 → 进结果对象', () => {
    expect(resolveSearchConfig({ url: 'https://a.com/v1', key: 'K' })).toEqual({
      url: 'https://a.com/v1',
      key: 'K',
    });
  });

  it('只配部分字段 → 只有所配键进结果对象', () => {
    expect(resolveSearchConfig({ url: 'https://a.com' })).toEqual({ url: 'https://a.com' });
    expect('key' in resolveSearchConfig({ url: 'https://a.com' })).toBe(false);
  });

  it('子段 [search.web]/[search.image] 解析，空子段不进结果', () => {
    expect(
      resolveSearchConfig({
        web: { url: 'https://w.com/v1', key: 'WK' },
        image: { url: 'https://i.com/step_plan/v1', key: 'IK' },
      }),
    ).toEqual({
      web: { url: 'https://w.com/v1', key: 'WK' },
      image: { url: 'https://i.com/step_plan/v1', key: 'IK' },
    });
    // 子段全空 → 不进结果
    expect(resolveSearchConfig({ web: {} })).toEqual({});
  });

  it('非法类型字段被忽略', () => {
    expect(resolveSearchConfig({ url: 123, key: true, web: 'not-object' })).toEqual({});
  });
});

describe('resolveSearchEndpoint（专用段 → 通用段）', () => {
  it('专用段覆盖通用段', () => {
    const cfg = resolveSearchConfig({ url: 'https://g.com', key: 'G', web: { url: 'https://w.com', key: 'W' } });
    expect(resolveSearchEndpoint(cfg, 'web')).toEqual({ url: 'https://w.com', key: 'W' });
    expect(resolveSearchEndpoint(cfg, 'image')).toEqual({ url: 'https://g.com', key: 'G' });
  });

  it('无专用段时回落通用段', () => {
    const cfg = resolveSearchConfig({ url: 'https://g.com', key: 'G' });
    expect(resolveSearchEndpoint(cfg, 'web')).toEqual({ url: 'https://g.com', key: 'G' });
  });

  it('cfg 为 undefined → 全 undefined', () => {
    expect(resolveSearchEndpoint(undefined, 'web')).toEqual({ url: undefined, key: undefined });
  });
});

describe('resolveSearchToolEndpoint（工具级，含主会话兜底）', () => {
  const session = { apiKey: 'MAIN', baseUrl: 'https://api.stepfun.com' };

  it('无 search 配置 → 兜底主会话 plan 路径', () => {
    expect(resolveSearchToolEndpoint(undefined, 'web', session, '/search')).toEqual({
      url: 'https://api.stepfun.com/step_plan/v1/search',
      key: 'MAIN',
    });
    expect(resolveSearchToolEndpoint(undefined, 'image', session, '/search-image')).toEqual({
      url: 'https://api.stepfun.com/step_plan/v1/search-image',
      key: 'MAIN',
    });
  });

  it('独立配置 url 视为精确意图，不做 /v1 裁剪', () => {
    const cfg = resolveSearchConfig({ url: 'https://api.stepfun.com/v1', key: 'SK' });
    expect(resolveSearchToolEndpoint(cfg, 'web', session, '/search')).toEqual({
      url: 'https://api.stepfun.com/v1/search',
      key: 'SK',
    });
  });

  it('独立配置只给 url → key 回退主会话 apiKey', () => {
    const cfg = resolveSearchConfig({ url: 'https://api.stepfun.com/v1' });
    expect(resolveSearchToolEndpoint(cfg, 'web', session, '/search')).toEqual({
      url: 'https://api.stepfun.com/v1/search',
      key: 'MAIN',
    });
  });

  it('专用段覆盖通用段，文搜图 plan 通道', () => {
    const cfg = resolveSearchConfig({
      url: 'https://g.com/v1',
      image: { url: 'https://api.stepfun.com/step_plan/v1', key: 'SP' },
    });
    expect(resolveSearchToolEndpoint(cfg, 'image', session, '/search-image')).toEqual({
      url: 'https://api.stepfun.com/step_plan/v1/search-image',
      key: 'SP',
    });
    // web 无专用段 → 用通用段
    expect(resolveSearchToolEndpoint(cfg, 'web', session, '/search')).toEqual({
      url: 'https://g.com/v1/search',
      key: 'MAIN',
    });
  });

  it('独立配置 url 末尾带斜杠 → 拼接不双斜杠', () => {
    const cfg = resolveSearchConfig({ url: 'https://a.com/v1/', key: 'K' });
    expect(resolveSearchToolEndpoint(cfg, 'web', session, '/search').url).toBe('https://a.com/v1/search');
  });
});
