/**
 * 阶跃搜索接口（web_search / web_image_search）的 HTTP 错误文案：按状态码分流 + 透传服务端 message。
 * 关键分流：451 = 内容安全审核拦截（阶跃平台语义：请求或响应内容未过审），与 API key / 额度无关，
 * 文案必须避免误导用户去查 key 与额度。服务端错误体形如 {"error":{"message":"...","type":"..."}}。
 */

/** 从错误响应体提取服务端 message（error.message → 顶层 message；非 JSON 截断返回；空体返回 undefined）。 */
function serverMessage(body: string): string | undefined {
  const trimmed = body.trim();
  if (trimmed === '') return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: string }; message?: string };
    const msg = parsed.error?.message ?? parsed.message;
    return typeof msg === 'string' && msg !== '' ? msg : undefined;
  } catch {
    return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
  }
}

/**
 * 生成搜索工具的 HTTP 错误文案。label 为工具名前缀（「搜索」/「图片搜索」）。
 * 分流：451 内容审核；401/403 key；429 限流/额度；5xx 服务端；其余透传服务端 message。
 */
export function searchHttpError(label: string, status: number, body: string): string {
  const detail = serverMessage(body);
  const suffix = detail !== undefined ? ` 服务端信息：${detail}` : '';
  if (status === 451) {
    return `${label}被内容安全审核拦截（HTTP 451）：检索词或返回内容未通过平台审核，请调整检索词后重试。这与 API key、额度无关。${suffix}`;
  }
  if (status === 401 || status === 403) {
    return `${label}失败：HTTP ${status}，API key 无效或权限不足，请检查 key 配置。${suffix}`;
  }
  if (status === 429) {
    return `${label}失败：HTTP 429，限流或额度不足，请稍后重试或检查 Step Plan 额度。${suffix}`;
  }
  if (status >= 500) {
    return `${label}失败：HTTP ${status}，平台服务端异常，请稍后重试。${suffix}`;
  }
  return `${label}失败：HTTP ${status}。${suffix}`;
}
