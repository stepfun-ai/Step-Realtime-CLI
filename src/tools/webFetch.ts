import { z } from 'zod';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { Agent, fetch as undiciFetch, interceptors } from 'undici';
import { fail, ok, type ToolDef } from './types.js';
import { webResultCache } from './webCache.js';

/**
 * `Document` 占位类型：Readability 的构造签名要求 lib.dom 的 `Document`，而本项目
 * tsconfig 的 `lib` 只有 ES2022（服务端进程，没有浏览器全局）。linkedom 产出的
 * document 与它结构不同，调用点本来就走 `as unknown as Document` 断言穿透。
 *
 * 这个占位此前由 `@types/react/global.d.ts` 顺带提供（它为无 DOM 环境声明了一批空
 * interface）。M5 删掉 Ink 与 react 依赖后那份声明随之消失，故在此显式补上——
 * 它只用于让断言有个具名目标，不承载任何结构约束，不要往里加成员。
 */
interface Document {
  readonly __domDocumentPlaceholder?: never;
}

const schema = z.object({
  url: z.string().url().describe('要抓取的网页 URL。'),
});

const MAX_BYTES = 10 * 1024 * 1024; // 10MB：响应体上限（不等于提取后正文上限，见 MAX_INLINE_CHARS）
const MAX_REDIRECT_HOPS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * 提取后正文的返回上限（字符数）。
 *
 * MAX_BYTES 只拦响应体，提取出的正文此前原样返回且原样入缓存，两处都不设限——
 * 这是长会话 OOM 的主要来源之一（详见 webCache.ts 顶部说明）。200k 字符 ≈ 400KB
 * （UTF-16），比原先的 10MB 收紧 25 倍，同时能完整装下绝大多数技术文档页。
 *
 * 超限时截断并追加恢复提示，且**截断结果不写入缓存**：缓存里放半截正文，下次命中会
 * 让调用方以为拿到了完整内容，比不缓存更糟。
 */
const MAX_INLINE_CHARS = 200_000;

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── SSRF 防护：私有地址阻断表 ──────────────────────────────────────────

const PRIVATE_ADDRESS_BLOCKLIST = (() => {
  const list = new BlockList();
  list.addSubnet('0.0.0.0', 8, 'ipv4');
  list.addSubnet('10.0.0.0', 8, 'ipv4');
  list.addSubnet('100.64.0.0', 10, 'ipv4');
  list.addSubnet('127.0.0.0', 8, 'ipv4');
  list.addSubnet('169.254.0.0', 16, 'ipv4');
  list.addSubnet('172.16.0.0', 12, 'ipv4');
  list.addSubnet('192.168.0.0', 16, 'ipv4');
  list.addSubnet('::', 128, 'ipv6');
  list.addSubnet('::1', 128, 'ipv6');
  list.addSubnet('fc00::', 7, 'ipv6');
  list.addSubnet('fe80::', 10, 'ipv6');
  return list;
})();

function isBlockedAddress(address: string): boolean {
  const normalized = address.split('%', 1)[0] ?? address;
  if (isIP(normalized) === 4) return PRIVATE_ADDRESS_BLOCKLIST.check(normalized, 'ipv4');
  return isIP(normalized) === 6 && PRIVATE_ADDRESS_BLOCKLIST.check(normalized, 'ipv6');
}

interface SafeFetchTarget {
  host: string;
  port: string;
  addresses?: LookupAddress[];
}

async function resolveSafeFetchTarget(url: string, allowPrivate: boolean): Promise<SafeFetchTarget> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: "${url}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme "${parsed.protocol}" — only http(s) allowed.`);
  }
  const hostRaw = parsed.hostname.toLowerCase();
  const host = hostRaw.startsWith('[') && hostRaw.endsWith(']') ? hostRaw.slice(1, -1) : hostRaw;
  const port = parsed.port !== '' ? parsed.port : parsed.protocol === 'https:' ? '443' : '80';
  if (allowPrivate) return { host, port };
  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      throw new Error(`Refusing to fetch private address: "${host}"`);
    }
    return { host, port };
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error(`Refusing to fetch private host: "${host}"`);
  }
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(host, { all: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot resolve host "${host}" for the fetch safety check: ${detail}`, {
      cause: error,
    });
  }
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error(`Refusing to fetch host "${host}": resolves to private address "${address}".`);
    }
  }
  return { host, port, addresses };
}

// ── 正文提取 ──────────────────────────────────────────────────────────

/**
 * 判断响应内容类型是否为可直接透传的文本类资源。
 * 避免把 shell 脚本、JSON、CSS、JS 等非 HTML 文本强行交给 HTML 解析器导致内容丢失。
 */
function isTextLikeContentType(contentType: string): boolean {
  if (contentType.startsWith('text/') && !contentType.startsWith('text/html')) {
    return true;
  }
  const textLikeApplications = [
    'application/json',
    'application/javascript',
    'application/x-javascript',
    'application/ecmascript',
    'application/x-sh',
    'application/x-shellscript',
    'application/xml',
    'application/xhtml+xml',
    'application/rss+xml',
    'application/atom+xml',
    'application/svg+xml',
  ];
  return textLikeApplications.some((t) => contentType.startsWith(t));
}

interface FetchResult {
  content: string;
  kind: 'passthrough' | 'extracted';
}

interface PinnedFetchResult {
  response: Response;
  composedAgent: { close: () => Promise<void> };
}

async function fetchWithSafeRedirects(url: string): Promise<PinnedFetchResult> {
  let currentUrl = url;
  let redirects = 0;

  for (;;) {
    const target = await resolveSafeFetchTarget(currentUrl, false);
    const dnsInterceptor = interceptors.dns({
      lookup: (_origin, _options, callback) => {
        callback(
          null,
          target.addresses!.map((a) => ({
            address: a.address,
            ttl: 60,
            family: a.family as 4 | 6,
          })),
        );
      },
    });
    const agent = new Agent();
    const composedAgent = agent.compose(dnsInterceptor);

    const response = await undiciFetch(currentUrl, {
      method: 'GET',
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
      redirect: 'manual',
      dispatcher: composedAgent,
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, composedAgent };
    }

    const location = response.headers.get('location');
    if (location === null) {
      return { response, composedAgent };
    }
    await response.body?.cancel().catch(() => {});
    await composedAgent.close();

    if (redirects >= MAX_REDIRECT_HOPS) {
      throw new Error(
        `Too many redirects while fetching "${url}" (limit ${MAX_REDIRECT_HOPS}).`,
      );
    }
    redirects += 1;
    currentUrl = new URL(location, currentUrl).toString();
  }
}

async function fetchAndExtract(url: string): Promise<FetchResult> {
  const { response, composedAgent } = await fetchWithSafeRedirects(url);
  try {
    return await readResponse(response, url);
  } finally {
    await composedAgent.close();
  }
}

async function readResponse(response: Response, url: string): Promise<FetchResult> {
  if (response.status >= 400) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentLengthRaw = response.headers.get('content-length');
  if (contentLengthRaw !== null) {
    const cl = Number(contentLengthRaw);
    if (Number.isFinite(cl) && cl > MAX_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new Error(
        `Response body too large: ${String(cl)} bytes exceeds maxBytes (${String(MAX_BYTES)}).`,
      );
    }
  }

  const body = await response.text();
  const actualBytes = Buffer.byteLength(body, 'utf8');
  if (actualBytes > MAX_BYTES) {
    throw new Error(
      `Response body too large: ${String(actualBytes)} bytes exceeds maxBytes (${String(MAX_BYTES)}).`,
    );
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (isTextLikeContentType(contentType)) {
    return { content: body, kind: 'passthrough' };
  }

  return { content: extractMainContent(body, url), kind: 'extracted' };
}

/**
 * 站点适配：微信公众号（mp.weixin.qq.com）。
 *
 * 公众号文章的正文容器 `#js_content` 在首屏 HTML 里就带
 * `style="visibility: hidden; opacity: 0;"`（微信靠后续 JS 揭开），Readability
 * 据此判定该节点不可见、不纳入候选，最终只返回标题、作者和页头碎片（2026-08-04
 * 实测：Readability 272 字 vs 正文 6632 字）。而「非空即成功」的短路逻辑又让
 * 本可拿到正文的 fallback 永远走不到。
 *
 * 处理：仅对 mp.weixin.qq.com 主机、仅对 `#js_content` 一个节点删除 style
 * 属性，再交给 Readability 主路径。不做全局 hidden 剥离——那会把隐藏导航、
 * 弹层、广告文案一起提取出来。
 */
function isWeChatArticleUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === 'mp.weixin.qq.com';
  } catch {
    return false;
  }
}

function extractMainContent(html: string, url?: string): string {
  const { document } = parseHTML(html);

  // 微信页预处理：删掉正文容器的隐藏 style，并在 Readability 改写 DOM 前留存正文文本
  let wechatRawText = '';
  if (url !== undefined && isWeChatArticleUrl(url)) {
    const contentNode = document.querySelector('#js_content');
    if (contentNode !== null) {
      contentNode.removeAttribute('style');
      wechatRawText = (contentNode.textContent ?? '').trim();
    }
  }

  // 优先用 Readability 提取
  try {
    const reader = new Readability(document as unknown as Document, {
      charThreshold: 0,
    });
    const article = reader.parse();
    if (article !== null) {
      const text = (article.textContent ?? '').trim();
      // 微信页：Readability 仍可能只抓到页头碎片（远短于正文容器），异常短时回退到
      // #js_content 直取，防微信改 DOM 形态后再次只返回标题作者
      const suspiciouslyShort =
        wechatRawText.length > 0 && text.length < wechatRawText.length / 3;
      if (text.length > 0 && !suspiciouslyShort) {
        const title = (article.title ?? '').trim();
        return title.length > 0 ? `# ${title}\n\n${text}` : text;
      }
    }
  } catch {
    // Readability 失败时走 fallback
  }

  // 微信页回退：Readability 失败或结果异常短，直接取 #js_content 文本
  if (wechatRawText.length > 0) {
    const titleText = (document.querySelector('title')?.textContent ?? '').trim();
    return titleText.length > 0 ? `# ${titleText}\n\n${wechatRawText}` : wechatRawText;
  }

  // Fallback：取 <article> / <main> / <body> 的文本
  const titleText = (document.querySelector('title')?.textContent ?? '').trim();
  const container =
    document.querySelector('article') ??
    document.querySelector('main') ??
    document.querySelector('body');
  const fallbackText = (container?.textContent ?? '').trim();

  if (fallbackText.length === 0) {
    throw new Error(
      'Failed to extract meaningful content from the page. The page may require JavaScript to render.',
    );
  }

  return titleText.length > 0 ? `# ${titleText}\n\n${fallbackText}` : fallbackText;
}

// ── Tool 定义 ─────────────────────────────────────────────────────────

export const webFetchTool: ToolDef<z.infer<typeof schema>> = {
  name: 'web_fetch',
  description:
    '抓取指定 URL 的网页正文内容。适用于用户直接给出的链接、代码中出现的文档页、搜索结果里想深入阅读的那条。' +
    '会优先读取 web_search 写入的本地内存缓存（命中则不发网络请求）；未命中时本地抓取并提取正文，抓取结果也会写回缓存。' +
    '返回的文本会标明内容来源（缓存 / 页面提取 / 原样透传）。',
  schema,
  access: () => ({ kind: 'none' }),
  async execute(input, _ctx) {
    const url = input.url.trim();
    // 优先读缓存（命中且未过期直接返回，省一次网络请求）
    const cached = webResultCache.get(url);
    if (cached) {
      const note =
        cached.kind === 'search'
          ? 'The returned content is from the web_search cache (search result content).\n\n'
          : 'The returned content is the main text extracted from the page.\n\n';
      const citeReminder = 'If you use it in your answer, cite this page as a markdown link, e.g. [title](url).';
      return ok(`${note}${citeReminder}\n\n${cached.content}`);
    }

    try {
      const result = await fetchAndExtract(url);
      if (!result.content) {
        return ok('The response body is empty.');
      }
      const note =
        result.kind === 'passthrough'
          ? 'The returned content is the full response body, returned verbatim.\n\n'
          : 'The returned content is the main text extracted from the page.\n\n';
      const citeReminder = 'If you use it in your answer, cite this page as a markdown link, e.g. [title](url).';
      const content = result.content;
      const truncated = content.length > MAX_INLINE_CHARS;
      // 截断内容不入缓存：半截正文一旦命中会被当成完整结果，比重新抓取更有害
      if (!truncated) {
        webResultCache.set({
          url,
          content,
          title: undefined,
          kind: 'fetch',
          ttlMs: 30 * 60 * 1000,
        });
      }
      if (!truncated) return ok(`${note}${citeReminder}\n\n${content}`);
      const shown = content.slice(0, MAX_INLINE_CHARS);
      const footer =
        `\n\n[content truncated: showing first ${String(MAX_INLINE_CHARS)} of ` +
        `${String(content.length)} characters. Fetch a more specific URL, or use web_search ` +
        `with narrower keywords, to get the part you need.]`;
      return ok(`${note}${citeReminder}\n\n${shown}${footer}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(`Failed to fetch URL: ${url}. ${msg}`);
    }
  },
};
