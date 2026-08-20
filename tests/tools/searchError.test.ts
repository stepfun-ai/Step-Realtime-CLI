import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchHttpError } from '../../src/tools/searchError.js';
import { webSearchTool } from '../../src/tools/webSearch.js';
import { imageSearchTool } from '../../src/tools/imageSearch.js';
import type { ToolContext } from '../../src/tools/types.js';

const ctx: ToolContext = { cwd: process.cwd(), apiKey: 'k-test', baseUrl: 'https://api.stepfun.com' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchHttpError 状态码分流', () => {
  it('451 → 内容审核文案，明确与 key/额度无关，且透传服务端 message', () => {
    const msg = searchHttpError('搜索', 451, '{"error":{"message":"content blocked by review","type":"content_filter"}}');
    expect(msg).toContain('451');
    expect(msg).toContain('内容安全审核');
    expect(msg).toContain('与 API key、额度无关');
    expect(msg).toContain('content blocked by review');
    expect(msg).not.toContain('请检查 API key');
  });

  it('401/403 → key 配置；429 → 限流/额度；5xx → 服务端异常', () => {
    expect(searchHttpError('搜索', 401, '')).toContain('key');
    expect(searchHttpError('搜索', 403, '')).toContain('key');
    expect(searchHttpError('搜索', 429, '')).toContain('额度');
    expect(searchHttpError('搜索', 500, '')).toContain('服务端');
    expect(searchHttpError('搜索', 503, '')).toContain('稍后重试');
  });

  it('其他状态码透传服务端 message；非 JSON body 截断兜底；空体无后缀', () => {
    expect(searchHttpError('搜索', 400, '{"error":{"message":"query is required"}}')).toContain(
      'query is required',
    );
    expect(searchHttpError('搜索', 418, '<html>teapot</html>')).toContain('teapot');
    expect(searchHttpError('搜索', 418, '')).not.toContain('服务端信息');
  });
});

describe('搜索工具的 451 现场（web_search / web_image_search）', () => {
  it('web_search：HTTP 451 带服务端错误体 → 审核文案 + 服务端 message，不提 key/额度检查', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 451,
      text: async () => '{"error":{"message":"query rejected by safety review","type":"content_filter"}}',
    }) as unknown as Response);
    const r = await webSearchTool.execute({ query: '敏感词' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('内容安全审核');
    expect(r.content).toContain('query rejected by safety review');
    expect(r.content).not.toContain('请检查 API key 与额度');
  });

  it('web_image_search：HTTP 451 → 同样的审核分流', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 451,
      text: async () => '{"error":{"message":"blocked","type":"content_filter"}}',
    }) as unknown as Response);
    const r = await imageSearchTool.execute({ query: '敏感词' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('内容安全审核');
    expect(r.content).toContain('与 API key、额度无关');
  });

  it('web_search：mock 无 text() 的旧形状也不崩（兜底为空体）', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401 }) as unknown as Response);
    const r = await webSearchTool.execute({ query: 'x' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('401');
  });
});
