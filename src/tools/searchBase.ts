import type { SearchConfig } from '../config/config.js';
import { resolveSearchEndpoint } from '../config/config.js';

/**
 * 从 provider base_url 推导出适合拼接阶跃搜索端点的基础 URL。
 * 兼容裸域名、/v1 后缀、/step_plan/v1 后缀等常见配置，避免重复拼接路径导致 404。
 */
export function resolveSearchBaseUrl(baseUrl?: string): string {
  const fallback = 'https://api.stepfun.com';
  if (!baseUrl) return fallback;
  try {
    const url = new URL(baseUrl);
    let pathname = url.pathname.replace(/\/+$/, '');
    if (pathname.endsWith('/step_plan/v1')) {
      pathname = pathname.slice(0, -'/step_plan/v1'.length);
    } else if (pathname.endsWith('/v1')) {
      pathname = pathname.slice(0, -'/v1'.length);
    }
    url.pathname = pathname;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return baseUrl.replace(/\/+$/, '');
  }
}

/** 搜索 endpoint 的最终解析结果。 */
export interface ResolvedSearchEndpoint {
  /** 完整请求 URL（已拼好 /search 或 /search-image）。 */
  url: string;
  /** 鉴权 key；undefined 表示无可用 key，工具应报「未配置」错误。 */
  key: string | undefined;
}

/**
 * 解析某个搜索工具的生效 endpoint。
 * 优先级：专用段（[search.web]/[search.image]）→ 通用段（[search]）→ 主会话渠道（apiKey/baseUrl）。
 *
 * 独立配置（[search] 任一层）的 url 视为用户的精确意图，只在末尾拼路径，不做裁剪；
 * 主会话渠道兜底时沿用 resolveSearchBaseUrl 的归一化（兼容裸域名与 /v1、/step_plan/v1 后缀）。
 *
 * @param searchCfg 已解析的 [search] 配置（可能为 undefined）。
 * @param kind 'web' 内容搜索 / 'image' 文搜图。
 * @param session 主会话渠道的 apiKey/baseUrl（兜底）。
 * @param path 工具对应的端点路径（'/search' 或 '/search-image'）。
 */
export function resolveSearchToolEndpoint(
  searchCfg: SearchConfig | undefined,
  kind: 'web' | 'image',
  session: { apiKey?: string; baseUrl?: string },
  path: '/search' | '/search-image',
): ResolvedSearchEndpoint {
  const endpoint = resolveSearchEndpoint(searchCfg, kind);
  // 独立配置命中（至少给了 url）：按精确意图拼接，不再裁剪
  if (endpoint.url !== undefined && endpoint.url !== '') {
    const base = endpoint.url.replace(/\/+$/, '');
    return { url: `${base}${path}`, key: endpoint.key ?? session.apiKey };
  }
  // 缺省回退主会话渠道（零配置默认策略）：走归一化后再拼 step_plan 路径
  const base = resolveSearchBaseUrl(session.baseUrl);
  const planPath = path === '/search-image' ? '/step_plan/v1/search-image' : '/step_plan/v1/search';
  return { url: `${base}${planPath}`, key: session.apiKey };
}
