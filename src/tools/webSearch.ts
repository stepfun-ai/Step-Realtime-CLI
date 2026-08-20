import { z } from 'zod';
import { searchHttpError } from './searchError.js';
import { resolveSearchToolEndpoint } from './searchBase.js';
import { fail, ok, type ToolDef } from './types.js';
import { webResultCache } from './webCache.js';

const schema = z.object({
  query: z.string().describe('检索关键词。'),
  n: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('返回结果条数，默认 10，范围 1-20。'),
  category: z
    .enum(['programming', 'research', 'gov', 'business'])
    .optional()
    .describe('检索场景：programming 代码编程 / research 学术研究 / gov 政务 / business 商业财经；省略则全网。'),
});

interface SearchResult {
  url: string;
  position: number;
  title: string;
  time?: string;
  snippet?: string;
  content?: string;
}

const MAX_SNIPPET = 500;

/**
 * 联网搜索工具，接阶跃星辰官方网页搜索接口。
 * endpoint 按「[search.web] → [search] → 主会话渠道」解析；独立配置视为精确意图，
 * 兜底沿用主会话渠道归一化后拼 step_plan 路径（零配置默认策略：缺省回退主会话渠道）。api 与 plan 双通道均可用。
 * 计费：按阶跃平台网络搜索计价（api 通道按量 / plan 通道消耗 Credit）。
 */
export const webSearchTool: ToolDef<z.infer<typeof schema>> = {
  name: 'web_search',
  description:
    '联网搜索互联网公开信息（阶跃官方网页搜索）。用于获取最新的 API 文档、库版本、CVE、实时资讯等模型训练后才有的信息。返回标题、链接与摘要。' +
    '搜索结果会自动写入本地内存缓存（TTL 30 分钟），后续 web_fetch 可直接读取缓存中的正文内容，无需重复网络请求。',
  schema,
  access: () => ({ kind: 'none' }), // 纯网络调用，无本地副作用
  async execute(input, ctx) {
    const endpoint = resolveSearchToolEndpoint(
      ctx.searchConfig,
      'web',
      { apiKey: ctx.apiKey, baseUrl: ctx.baseUrl },
      '/search',
    );
    if (endpoint.key === undefined || endpoint.key === '') {
      return fail('未配置 StepFun API key，无法联网搜索。可在 config.toml 的 [search] 段配置独立的搜索 url 与 key。');
    }
    const url = endpoint.url;
    const body: Record<string, unknown> = { query: input.query, n: input.n ?? 10 };
    if (input.category !== undefined) body['category'] = input.category;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${endpoint.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
    } catch (e) {
      if (ctx.signal?.aborted) return fail('用户中断，搜索已取消。');
      return fail(`搜索请求失败：${(e as Error).message}`);
    }
    if (!res.ok) {
      // 读响应体提取服务端真实错误（如 451 内容审核），避免一句「检查 key 与额度」误导所有非 2xx
      let text = '';
      try {
        text = await res.text();
      } catch {
        // 响应体读取失败不影响错误上报
      }
      return fail(searchHttpError('搜索', res.status, text));
    }

    let data: { results?: SearchResult[] };
    try {
      data = (await res.json()) as { results?: SearchResult[] };
    } catch {
      return fail('搜索返回无法解析。');
    }
    const results = data.results ?? [];
    if (results.length === 0) {
      return ok('[无搜索结果，可调整关键词后重试]');
    }

    // 将搜索结果写入缓存（仅 content 字段），供后续 web_fetch 复用
    for (const r of results) {
      const content = (r.content ?? '').trim();
      if (content.length > 0) {
        webResultCache.set({
          url: r.url,
          content,
          title: r.title,
          kind: 'search',
          ttlMs: 30 * 60 * 1000,
        });
      }
    }

    const formatted = results
      .map((r) => {
        const snippet = (r.snippet ?? '').slice(0, MAX_SNIPPET);
        return `[${r.position}] ${r.title}\n    ${r.url}\n    ${snippet}`;
      })
      .join('\n\n');

    const cachedCount = results.filter((r) => (r.content ?? '').trim().length > 0).length;
    if (cachedCount > 0) {
      return ok(
        formatted +
          `\n\n---\n[Cached ${cachedCount} URLs with full content for web_fetch (memory cache, TTL 30 min)]`,
      );
    }
    return ok(formatted);
  },
};
