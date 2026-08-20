import type Anthropic from '@anthropic-ai/sdk';

/**
 * tool_search 检索器（懒加载，客户端自实现）：
 * 对 deferred（未直给模型的）外部工具做关键词检索，返回命中的工具 schema。
 * 命中工具的 schema 由调用方追加进下一轮请求的 tools 数组（客户端自行输出检索结果）。
 * 用简化的关键词打分（不引 bm25 依赖）：query 分词后在 名称/描述/schema 属性名 上匹配计分。
 */

export interface DeferredTool {
  name: string;
  description: string;
  inputSchema: Anthropic.Tool['input_schema'];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[_\-./]/g, ' ')
    .split(/[^a-z0-9一-龥]+/)
    .filter((t) => t.length > 0);
}

/** 递归收集 schema 属性名与描述文本。 */
function schemaText(schema: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const o = node as Record<string, unknown>;
    if (typeof o['description'] === 'string') parts.push(o['description']);
    const props = o['properties'];
    if (typeof props === 'object' && props !== null) {
      for (const [k, v] of Object.entries(props)) {
        parts.push(k);
        walk(v);
      }
    }
    for (const key of ['items', 'anyOf', 'oneOf', 'allOf']) {
      walk(o[key]);
    }
  };
  walk(schema);
  return parts.join(' ');
}

function score(tool: DeferredTool, queryTokens: string[]): number {
  const haystack = `${tool.name} ${tool.description} ${schemaText(tool.inputSchema)}`.toLowerCase();
  let s = 0;
  for (const t of queryTokens) {
    if (tool.name.toLowerCase().includes(t)) s += 3;
    else if (haystack.includes(t)) s += 1;
  }
  return s;
}

/** 检索 deferred 工具：返回按相关度排序的前 limit 个。 */
export function searchTools(deferred: DeferredTool[], query: string, limit = 8): DeferredTool[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  return deferred
    .map((t) => ({ t, s: score(t, qTokens) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.t);
}
