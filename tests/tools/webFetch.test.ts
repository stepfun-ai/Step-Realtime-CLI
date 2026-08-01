import { afterEach, describe, expect, it, vi } from 'vitest';
import * as undici from 'undici';
import { webFetchTool } from '../../src/tools/webFetch.js';
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
});
