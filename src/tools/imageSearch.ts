import { z } from 'zod';
import { searchHttpError } from './searchError.js';
import { resolveSearchToolEndpoint } from './searchBase.js';
import { fail, ok, type ToolDef } from './types.js';

const schema = z.object({
  query: z.string().describe('图片搜索词，建议中文，也支持英文。'),
  topk: z.number().int().min(1).max(20).optional().describe('返回图片张数上限，默认 5。'),
});

interface ImageResult {
  contentUrl: string;
  snippet?: string;
  width?: number;
  height?: number;
  hostPageUrl?: string;
  hostname?: string;
}

interface ImageSearchResponse {
  code?: number;
  msg?: string;
  data?: { result?: { block?: boolean; search_results?: ImageResult[] } };
}

/**
 * 文搜图工具，接阶跃星辰官方文搜图接口（仅 Step Plan 通道提供）。
 * endpoint 按「[search.image] → [search] → 主会话渠道」解析；独立配置视为精确意图，
 * 兜底沿用主会话渠道归一化后拼 step_plan 路径（零配置默认策略：缺省回退主会话渠道）。图片数据来自百度搜图。
 * 适合为文档 / 文章 / 演示稿检索配图素材。
 */
export const imageSearchTool: ToolDef<z.infer<typeof schema>> = {
  name: 'web_image_search',
  description:
    '按文字描述联网搜索图片（阶跃官方文搜图，走 Step Plan 通道）。用于为文档/文章/演示稿找配图。返回原图地址、描述（可作 alt）、尺寸与来源网页。',
  schema,
  access: () => ({ kind: 'none' }), // 纯网络调用，无本地副作用
  async execute(input, ctx) {
    const endpoint = resolveSearchToolEndpoint(
      ctx.searchConfig,
      'image',
      { apiKey: ctx.apiKey, baseUrl: ctx.baseUrl },
      '/search-image',
    );
    if (endpoint.key === undefined || endpoint.key === '') {
      return fail('未配置 StepFun API key，无法搜索图片。可在 config.toml 的 [search] 段配置独立的搜索 url 与 key。');
    }
    const url = endpoint.url;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${endpoint.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: input.query, topk: input.topk ?? 5 }),
        signal: ctx.signal,
      });
    } catch (e) {
      if (ctx.signal?.aborted) return fail('用户中断，图片搜索已取消。');
      return fail(`图片搜索请求失败：${(e as Error).message}`);
    }
    if (!res.ok) {
      let text = '';
      try {
        text = await res.text();
      } catch {
        // 响应体读取失败不影响错误上报
      }
      return fail(searchHttpError('图片搜索', res.status, text));
    }

    let data: ImageSearchResponse;
    try {
      data = (await res.json()) as ImageSearchResponse;
    } catch {
      return fail('图片搜索返回无法解析。');
    }
    if (data.code !== 0) {
      return fail(`图片搜索出错：${data.msg ?? `code ${data.code}`}`);
    }
    const result = data.data?.result;
    if (result?.block === true) {
      return fail('搜索词命中内容审核拦截，未返回图片。请调整描述。');
    }
    const images = result?.search_results ?? [];
    if (images.length === 0) {
      return ok('[无图片结果，可调整描述后重试]');
    }
    const formatted = images
      .map((img, i) => {
        const size = img.width && img.height ? `  (${img.width}x${img.height})` : '';
        const desc = img.snippet ?? '';
        const from = img.hostPageUrl ? `\n    来源: ${img.hostPageUrl}` : '';
        return `[${i + 1}] ${desc}\n    ${img.contentUrl}${size}${from}`;
      })
      .join('\n\n');
    return ok(formatted);
  },
};
