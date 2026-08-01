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
