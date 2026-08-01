import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageSearchTool } from '../../src/tools/imageSearch.js';
import type { ToolContext } from '../../src/tools/types.js';

const ctx: ToolContext = { cwd: process.cwd(), apiKey: 'k-test', baseUrl: 'https://api.stepfun.com' };

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubJson(payload: unknown, ok = true, status = 200): void {
  vi.stubGlobal(
    'fetch',
    async () => ({ ok, status, json: async () => payload }) as unknown as Response,
  );
}

describe('web_image_search 工具', () => {
  it('缺少 apiKey 时返回错误', async () => {
    const r = await imageSearchTool.execute({ query: 'x' }, { cwd: process.cwd() });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('API key');
  });

  it('正常返回时格式化图片（描述/原图/尺寸/来源），并打到 step_plan 端点', async () => {
    const captured: { url?: string; body?: any } = {};
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.body = JSON.parse(init.body as string);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          msg: '',
          data: {
            result: {
              block: false,
              search_results: [
                {
                  contentUrl: 'https://img.example/a.png',
                  snippet: '一只猫',
                  width: 800,
                  height: 600,
                  hostPageUrl: 'https://page.example/a',
                  hostname: 'example',
                },
              ],
            },
          },
        }),
      } as unknown as Response;
    });

    const r = await imageSearchTool.execute({ query: '猫', topk: 3 }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('一只猫');
    expect(r.content).toContain('https://img.example/a.png');
    expect(r.content).toContain('(800x600)');
    expect(r.content).toContain('来源: https://page.example/a');
    expect(captured.url).toBe('https://api.stepfun.com/step_plan/v1/search-image');
    expect(captured.body).toMatchObject({ query: '猫', topk: 3 });
  });

  it('baseUrl 带 /v1 或 /step_plan/v1 后缀时去重拼接，避免 404', async () => {
    const captured: { url?: string } = {};
    vi.stubGlobal('fetch', async (url: string) => {
      captured.url = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, msg: '', data: { result: { block: false, search_results: [] } } }),
      } as unknown as Response;
    });

    await imageSearchTool.execute({ query: 'x' }, { cwd: process.cwd(), apiKey: 'k', baseUrl: 'https://api.stepfun.com/v1' });
    expect(captured.url).toBe('https://api.stepfun.com/step_plan/v1/search-image');

    await imageSearchTool.execute({ query: 'x' }, { cwd: process.cwd(), apiKey: 'k', baseUrl: 'https://api.stepfun.com/step_plan/v1' });
    expect(captured.url).toBe('https://api.stepfun.com/step_plan/v1/search-image');
  });

  it('命中审核拦截 block=true 时返回错误提示', async () => {
    stubJson({ code: 0, msg: '', data: { result: { block: true, search_results: [] } } });
    const r = await imageSearchTool.execute({ query: 'x' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('审核拦截');
  });

  it('code 非 0 返回错误', async () => {
    stubJson({ code: 1, msg: '额度不足' });
    const r = await imageSearchTool.execute({ query: 'x' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('额度不足');
  });

  it('无结果时给出明确提示', async () => {
    stubJson({ code: 0, msg: '', data: { result: { block: false, search_results: [] } } });
    const r = await imageSearchTool.execute({ query: 'x' }, ctx);
    expect(r.content).toContain('无图片结果');
  });
});
