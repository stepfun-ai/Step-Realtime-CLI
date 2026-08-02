import { describe, expect, it } from 'vitest';
import { searchTools, type DeferredTool } from '../../src/agent/toolSearch.js';
import { toolSearchTool } from '../../src/tools/toolSearch.js';

const DEFERRED: DeferredTool[] = [
  { name: 'github_create_issue', description: '在 GitHub 创建 issue', inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'issue 标题' } } } },
  { name: 'github_search_repos', description: '搜索 GitHub 仓库', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'web_fetch', description: '抓取网页正文', inputSchema: { type: 'object' } },
];

describe('searchTools', () => {
  it('按关键词命中相关工具', () => {
    const hits = searchTools(DEFERRED, 'github issue');
    expect(hits.map((h) => h.name)).toContain('github_create_issue');
  });

  it('schema 属性名参与检索', () => {
    const hits = searchTools(DEFERRED, '标题');
    expect(hits.map((h) => h.name)).toContain('github_create_issue');
  });

  it('空 query 返回空', () => {
    expect(searchTools(DEFERRED, '')).toEqual([]);
  });

  it('无匹配返回空', () => {
    expect(searchTools(DEFERRED, 'zzzzzz')).toEqual([]);
  });
});

describe('tool_search 工具', () => {
  it('命中后调用 load 并返回工具名', async () => {
    const loaded: string[] = [];
    const ctx = {
      cwd: process.cwd(),
      toolSearch: { deferred: DEFERRED, load: (names: string[]) => loaded.push(...names) },
    };
    const r = await toolSearchTool.execute({ query: 'github' }, ctx);
    expect(r.isError).toBe(false);
    expect(loaded.length).toBeGreaterThan(0);
    expect(r.content).toContain('已加载');
  });

  it('无 deferred 时提示无外部工具', async () => {
    const r = await toolSearchTool.execute({ query: 'x' }, { cwd: process.cwd() });
    expect(r.content).toContain('没有可搜索的外部工具');
  });

  it('无匹配时不调用 load', async () => {
    const loaded: string[] = [];
    const ctx = {
      cwd: process.cwd(),
      toolSearch: { deferred: DEFERRED, load: (n: string[]) => loaded.push(...n) },
    };
    const r = await toolSearchTool.execute({ query: 'zzzzzz' }, ctx);
    expect(loaded).toEqual([]);
    expect(r.content).toContain('没有找到');
  });
});
