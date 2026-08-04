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

  // --- 站点适配：微信公众号 #js_content 隐藏容器 ---
  // 公众号正文容器首屏带 style="visibility:hidden;opacity:0"，Readability 判不可见
  // 只返回标题作者（2026-08-04 实测 272 字 vs 正文 6632 字）。适配仅对
  // mp.weixin.qq.com 主机、仅对 #js_content 生效，不得泄漏成全局行为。

  function makeWeChatHtml(paragraphs: string[]): string {
    const body = paragraphs.map((p) => `<p>${p}</p>`).join('');
    return (
      '<html><head><title>文章标题</title></head><body>' +
      '<div class="rich_media"><h1>文章标题</h1><div id="js_name">某公众号</div>' +
      `<div class="rich_media_content" id="js_content" style="visibility: hidden; opacity: 0;">${body}</div>` +
      '</div></body></html>'
    );
  }

  it('微信公众号：#js_content 隐藏 style 被剥离后返回正文而非只有标题作者', async () => {
    webResultCache.clear();
    const paragraphs = Array.from({ length: 30 }, (_, i) => `正文段落第 ${String(i)} 段，公众号正文内容。`);
    mockedFetch.mockResolvedValueOnce(
      makeResponse({
        headers: { 'content-type': 'text/html' },
        body: makeWeChatHtml(paragraphs),
      }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
    );
    const r = await webFetchTool.execute({ url: 'https://mp.weixin.qq.com/s/abc123' }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('正文段落第 29 段');
    expect(r.content.length).toBeGreaterThan(paragraphs.join('').length / 2);
    webResultCache.clear();
  });

  it('非微信 URL 不触发特判：隐藏容器仍按原逻辑处理', async () => {
    webResultCache.clear();
    // 同一 fixture 放在非微信域名下，隐藏内容不应被强行提取；
    // Readability/fallback 原逻辑返回什么就是什么，关键是返回值不含「正文字段」直取痕迹
    const paragraphs = Array.from({ length: 30 }, (_, i) => `正文字段第 ${String(i)} 段内容。`);
    mockedFetch.mockResolvedValueOnce(
      makeResponse({
        headers: { 'content-type': 'text/html' },
        body:
          '<html><head><title>T</title></head><body><article><p>可见正文</p></article>' +
          `<div id="js_content" style="visibility:hidden;opacity:0;">${paragraphs
            .map((p) => `<p>${p}</p>`)
            .join('')}</div></body></html>`,
      }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
    );
    const r = await webFetchTool.execute({ url: 'https://example.com/article' }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('可见正文');
    expect(r.content).not.toContain('正文字段第 29 段');
    webResultCache.clear();
  });

  it('微信页 Readability 结果异常短时回退到 #js_content 文本', async () => {
    webResultCache.clear();
    // 无 h1/标题线索、正文容器结构极扁平时，Readability 可能只返回页头碎片；
    // 只要结果远短于 #js_content 自身文本（阈值 1/3），必须回退直取
    const paragraphs = Array.from({ length: 40 }, (_, i) => `回退路径正文第 ${String(i)} 段，内容内容内容。`);
    mockedFetch.mockResolvedValueOnce(
      makeResponse({
        headers: { 'content-type': 'text/html' },
        body: makeWeChatHtml(paragraphs),
      }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
    );
    const r = await webFetchTool.execute({ url: 'https://mp.weixin.qq.com/s/def456' }, ctx);
    expect(r.isError).toBe(false);
    // 不管走的是 Readability 主路径还是 #js_content 回退，完整正文都必须在
    expect(r.content).toContain('回退路径正文第 0 段');
    expect(r.content).toContain('回退路径正文第 39 段');
    webResultCache.clear();
  });
});
