import { afterEach, describe, expect, it, vi } from 'vitest';
import * as undici from 'undici';
import { webFetchTool } from '../../src/tools/webFetch.js';
import { webResultCache } from '../../src/tools/webCache.js';
import type { ToolContext } from '../../src/tools/types.js';

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof undici>('undici');
  return {
    ...actual,
    fetch: vi.fn(),
  };
});

const mockedFetch = vi.mocked(undici.fetch);

const ctx: ToolContext = { cwd: process.cwd() };

afterEach(() => {
  vi.clearAllMocks();
});

function makeResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}): Response {
  const { status = 200, headers = {}, body = '' } = opts;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    text: async () => body,
    body: null,
  } as unknown as Response;
}

describe('web_fetch 工具', () => {
  it('text/plain 原样透传', async () => {
    mockedFetch.mockResolvedValueOnce(
      makeResponse({
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'plain text content',
      }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
    );
    const r = await webFetchTool.execute({ url: 'https://example.com/a.txt' }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('plain text content');
    expect(r.content).toContain('full response body');
  });

  it('application/x-sh 作为文本透传，不走 HTML 提取', async () => {
    const script = '#!/bin/sh\necho hello';
    mockedFetch.mockResolvedValueOnce(
      makeResponse({
        headers: { 'content-type': 'application/x-sh' },
        body: script,
      }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
    );
    const r = await webFetchTool.execute({ url: 'https://cdn.kimi.com/webbridge/install.sh' }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('#!/bin/sh');
    expect(r.content).toContain('echo hello');
  });

  it('application/json 作为文本透传', async () => {
    mockedFetch.mockResolvedValueOnce(
      makeResponse({
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
      }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
    );
    const r = await webFetchTool.execute({ url: 'https://example.com/api' }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('{"ok":true}');
  });

  it('text/html 走 Readability 提取', async () => {
    mockedFetch.mockResolvedValueOnce(
      makeResponse({
        headers: { 'content-type': 'text/html' },
        body: '<html><head><title>T</title></head><body><article><p>paragraph</p></article></body></html>',
      }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
    );
    const r = await webFetchTool.execute({ url: 'https://example.com/article' }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('paragraph');
  });

  it('HTTP 错误返回错误结果', async () => {
    mockedFetch.mockResolvedValueOnce(
      makeResponse({ status: 404, body: 'not found' }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
    );
    const r = await webFetchTool.execute({ url: 'https://example.com/missing' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('404');
  });

  // --- 提取后正文的返回上限（OOM 修复：MAX_BYTES 只拦响应体，不拦提取后正文）---

  it('正文超过 inline 上限时截断并附恢复提示，且不写入缓存', async () => {
    webResultCache.clear();
    const url = 'https://example.com/huge.txt';
    const body = 'H'.repeat(250_000); // > MAX_INLINE_CHARS (200k)
    mockedFetch.mockResolvedValueOnce(
      makeResponse({
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body,
      }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
    );
    const r = await webFetchTool.execute({ url }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('[content truncated: showing first 200000 of 250000 characters');
    // 返回体不含全文（截断后长度远小于原文 + 提示）
    expect(r.content.length).toBeLessThan(body.length);
    // 关键：截断内容不入缓存——半截正文一旦命中会被当成完整结果
    expect(webResultCache.get(url)).toBeUndefined();
    expect(webResultCache.size).toBe(0);
  });

  it('正文未超上限时正常写入缓存', async () => {
    webResultCache.clear();
    const url = 'https://example.com/small.txt';
    mockedFetch.mockResolvedValueOnce(
      makeResponse({
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'small body',
      }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
    );
    await webFetchTool.execute({ url }, ctx);
    expect(webResultCache.get(url)?.content).toBe('small body');
    webResultCache.clear();
  });
});
