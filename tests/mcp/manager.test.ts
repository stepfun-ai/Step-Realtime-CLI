import { describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  DEFAULT_STARTUP_TIMEOUT_MS,
  fnv1aHex,
  MAX_TOOL_NAME_LEN,
  McpManager,
  qualifyMcpToolName,
  type McpServerConfig,
} from '../../src/mcp/manager.js';

describe('qualifyMcpToolName', () => {
  it('生成 mcp__server__tool 命名', () => {
    expect(qualifyMcpToolName('github', 'create_issue')).toBe('mcp__github__create_issue');
  });

  it('非法字符 sanitize', () => {
    expect(qualifyMcpToolName('my-server', 'do.thing')).toBe('mcp__my-server__do_thing');
  });

  it('64 字符内不截断', () => {
    const name = qualifyMcpToolName('a'.repeat(20), 'b'.repeat(30));
    expect(name).toBe(`mcp__${'a'.repeat(20)}__${'b'.repeat(30)}`);
    expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LEN);
  });

  it('超 64 字符截断：总长恰为 64，尾部为 _ + 8 字符哈希', () => {
    const name = qualifyMcpToolName('s'.repeat(40), 't'.repeat(40));
    expect(name.length).toBe(MAX_TOOL_NAME_LEN);
    expect(name).toMatch(/^mcp__s+.*_[0-9a-f]{8}$/);
    // 前缀保留截断前完整名的前 55 字符
    const full = `mcp__${'s'.repeat(40)}__${'t'.repeat(40)}`;
    expect(name.startsWith(full.slice(0, MAX_TOOL_NAME_LEN - 9))).toBe(true);
  });

  it('哈希后缀稳定：同名多次生成结果一致', () => {
    const a = qualifyMcpToolName('x'.repeat(40), 'y'.repeat(40));
    const b = qualifyMcpToolName('x'.repeat(40), 'y'.repeat(40));
    expect(a).toBe(b);
  });

  it('不同长名不撞：截断前缀相同时哈希后缀区分', () => {
    // 两个 tool 名前 55 字符相同、之后不同 → 截断后靠前缀无法区分，靠哈希后缀区分
    const a = qualifyMcpToolName('s'.repeat(30), `${'t'.repeat(30)}_aaa`);
    const b = qualifyMcpToolName('s'.repeat(30), `${'t'.repeat(30)}_bbb`);
    expect(a.length).toBe(MAX_TOOL_NAME_LEN);
    expect(b.length).toBe(MAX_TOOL_NAME_LEN);
    expect(a).not.toBe(b);
    // 哈希后缀确实来自截断前的完整名（FNV-1a）
    expect(a.endsWith(`_${fnv1aHex(`mcp__${'s'.repeat(30)}__${'t'.repeat(30)}_aaa`)}`)).toBe(true);
  });
});

/** 假 MCP manager：覆盖底层握手，不真起子进程。behavior 以 config.command 为 key。 */
class FakeManager extends McpManager {
  behavior: Record<string, 'ok' | 'fail' | 'hang'> = {};
  calls: string[] = [];

  protected override async connectAndListTools(
    _client: Client,
    config: McpServerConfig,
  ): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    this.calls.push(config.command);
    const b = this.behavior[config.command] ?? 'ok';
    if (b === 'fail') throw new Error('spawn failed\nsecond line');
    if (b === 'hang') await new Promise((r) => setTimeout(r, 200));
    return [
      { name: 'echo', description: 'echo tool', inputSchema: { type: 'object' } },
      { name: 'ping' },
    ];
  }
}

const cfg = (command: string, extra?: Partial<McpServerConfig>): McpServerConfig => ({ command, ...extra });

describe('McpManager 并行连接', () => {
  it('connectAll 并行发起：全部 server 先进入 pending', async () => {
    const m = new FakeManager();
    m.behavior = { a: 'hang', b: 'hang' };
    const done = m.connectAll({ a: cfg('a'), b: cfg('b') });
    // connectAll 同步执行到首个 await 之前，两个 server 都已标记 pending
    expect(m.statuses().map((s) => s.status)).toEqual(['pending', 'pending']);
    await done;
    expect(m.statuses().map((s) => s.status)).toEqual(['connected', 'connected']);
  });

  it('单点失败隔离：失败 server 记 failed，其余照常 connected', async () => {
    const m = new FakeManager();
    m.behavior = { bad: 'fail' };
    await m.connectAll({ good1: cfg('good1'), bad: cfg('bad'), good2: cfg('good2') });
    const byName = new Map(m.statuses().map((s) => [s.name, s]));
    expect(byName.get('good1')?.status).toBe('connected');
    expect(byName.get('good2')?.status).toBe('connected');
    expect(byName.get('bad')?.status).toBe('failed');
    // 错误摘要压成单行
    expect(byName.get('bad')?.error).toBe('spawn failed second line');
    // 成功 server 的工具可用，失败 server 无工具
    expect(m.toolsOf('good1').map((x) => x.qualifiedName)).toEqual(['mcp__good1__echo', 'mcp__good1__ping']);
    expect(m.toolsOf('bad')).toEqual([]);
    expect(m.allTools()).toHaveLength(4);
  });

  it('connect 失败不抛出，返回 false', async () => {
    const m = new FakeManager();
    m.behavior = { bad: 'fail' };
    expect(await m.connect('bad', cfg('bad'))).toBe(false);
    expect(await m.connect('ok', cfg('ok'))).toBe(true);
  });

  it('onConnected 增量回调：只对连接成功的 server 触发', async () => {
    const m = new FakeManager();
    m.behavior = { bad: 'fail' };
    const connected: string[] = [];
    await m.connectAll({ a: cfg('a'), bad: cfg('bad'), b: cfg('b') }, (name) => connected.push(name));
    expect([...connected].sort()).toEqual(['a', 'b']);
  });

  it('startupTimeoutMs 覆盖默认超时：慢 server 超时记 failed', async () => {
    const m = new FakeManager();
    m.behavior = { slow: 'hang' }; // 假 server 握手 200ms
    const ok = await m.connect('slow', cfg('slow', { startupTimeoutMs: 20 }));
    expect(ok).toBe(false);
    const s = m.statuses()[0]!;
    expect(s.status).toBe('failed');
    expect(s.error).toContain('超时');
    // 慢 server 的迟到 resolve 不会改写 failed 状态，也不会补登工具
    await new Promise((r) => setTimeout(r, 250));
    expect(m.statuses()[0]!.status).toBe('failed');
    expect(m.toolsOf('slow')).toEqual([]);
  });

  it('默认启动超时为 30 秒', () => {
    expect(DEFAULT_STARTUP_TIMEOUT_MS).toBe(30_000);
  });

  it('enabled:false 记 disabled，不发起连接', async () => {
    const m = new FakeManager();
    const ok = await m.connect('off', cfg('off', { enabled: false }));
    expect(ok).toBe(false);
    expect(m.statuses()[0]).toEqual({ name: 'off', status: 'disabled', toolCount: 0 });
    expect(m.calls).toEqual([]);
  });

  it('statuses 暴露 connected 工具数', async () => {
    const m = new FakeManager();
    await m.connect('a', cfg('a'));
    expect(m.statuses()[0]).toEqual({ name: 'a', status: 'connected', toolCount: 2 });
  });

  it('closeAll 清空已连接 server：工具登记随连接一起移除', async () => {
    const m = new FakeManager();
    await m.connectAll({ a: cfg('a'), b: cfg('b') });
    expect(m.allTools()).toHaveLength(4);
    await m.closeAll();
    expect(m.allTools()).toEqual([]);
    expect(m.toolsOf('a')).toEqual([]);
    // 幂等：重复关闭不抛错
    await m.closeAll();
  });
});
