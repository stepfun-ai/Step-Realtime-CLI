import { describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpManager, type McpServerConfig } from '../../src/mcp/manager.js';
import { formatMcpStatus } from '../../src/mcp/status.js';
import { setLocale, t } from '../../src/i18n.js';

/** 假 MCP manager：覆盖底层握手，不真起子进程。 */
class FakeManager extends McpManager {
  behavior: Record<string, 'ok' | 'fail' | 'hang'> = {};

  protected override async connectAndListTools(
    _client: Client,
    config: McpServerConfig,
  ): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    const b = this.behavior[config.command] ?? 'ok';
    if (b === 'fail') throw new Error('boom');
    if (b === 'hang') await new Promise((r) => setTimeout(r, 200));
    return [{ name: 'echo', description: 'echo tool' }];
  }
}

describe('formatMcpStatus', () => {
  it('无配置时给出配置指引（指向 ~/.step-code/mcp.json）', () => {
    const text = formatMcpStatus(new FakeManager());
    expect(text).toContain('未配置 MCP server');
    expect(text).toContain('mcp.json');
  });

  it('已连接：名称 + 状态 + 工具数', async () => {
    const m = new FakeManager();
    await m.connect('github', { command: 'github' });
    const text = formatMcpStatus(m);
    expect(text).toContain('MCP server 状态');
    expect(text).toContain('- github：已连接，1 个工具');
  });

  it('失败：名称 + 单行错误摘要', async () => {
    const m = new FakeManager();
    m.behavior = { bad: 'fail' };
    await m.connect('bad', { command: 'bad' });
    expect(formatMcpStatus(m)).toContain('- bad：连接失败：boom');
  });

  it('连接中：pending 状态行', async () => {
    const m = new FakeManager();
    m.behavior = { slow: 'hang' };
    const done = m.connect('slow', { command: 'slow' });
    expect(formatMcpStatus(m)).toContain('- slow：连接中');
    await done;
  });

  it('已禁用：disabled 状态行', async () => {
    const m = new FakeManager();
    await m.connect('off', { command: 'off', enabled: false });
    expect(formatMcpStatus(m)).toContain('- off：已禁用');
  });

  it('多 server 各占一行', async () => {
    const m = new FakeManager();
    m.behavior = { bad: 'fail' };
    await m.connectAll({ good: { command: 'good' }, bad: { command: 'bad' } });
    const lines = formatMcpStatus(m).split('\n');
    expect(lines).toHaveLength(3); // 标题 + 两行
    expect(lines[1]).toContain('good');
    expect(lines[2]).toContain('bad');
  });

  it('en locale 输出英文状态行', async () => {
    const m = new FakeManager();
    await m.connect('github', { command: 'github' });
    setLocale('en');
    try {
      expect(formatMcpStatus(m)).toContain('- github: connected, 1 tools');
      expect(t('cmd.mcp').length).toBeGreaterThan(0);
    } finally {
      setLocale('zh');
    }
  });
});
