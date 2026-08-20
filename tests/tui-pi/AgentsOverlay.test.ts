/**
 * ④ AgentGroup 分组面板测试。
 *
 * 测三块：sortAgents 排序语义、agentRow 单行截断、AgentsOverlay.render/handleInput。
 * 数据用内联 SessionMeta（SubagentStore 不参与），纯组件行为测试。
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentsOverlay, sortAgents, agentRow } from '../../src/tui-pi/AgentsOverlay.js';
import type { SessionMeta } from '../../src/session/store.js';

function meta(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    id: 'sub-001',
    cwd: '/work',
    model: 'test',
    createdAt: '2026-08-19T00:00:00Z',
    updatedAt: '2026-08-19T00:01:00Z',
    messageCount: 5,
    ...overrides,
  };
}

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('④ AgentsOverlay 排序', () => {
  it('running 在前，其余按 updatedAt 倒序', () => {
    const agents = [
      meta({ id: 'a', status: 'done', updatedAt: '2026-08-19T00:05:00Z' }),
      meta({ id: 'b', status: 'running', updatedAt: '2026-08-19T00:01:00Z' }),
      meta({ id: 'c', status: 'done', updatedAt: '2026-08-19T00:03:00Z' }),
      meta({ id: 'd', status: 'error', updatedAt: '2026-08-19T00:04:00Z' }),
    ];
    const sorted = sortAgents(agents);
    expect(sorted[0]!.id).toBe('b'); // running 最先
    expect(sorted[1]!.id).toBe('a'); // done + 较新
    expect(sorted[2]!.id).toBe('c'); // done + 较旧
    expect(sorted[3]!.id).toBe('d'); // error 末位
  });

  it('空列表不崩', () => {
    expect(sortAgents([])).toEqual([]);
  });
});

describe('④ agentRow 单行', () => {
  it('截断到 width，不超宽', () => {
    const a = meta({ id: 'x', name: '很长的任务名称'.repeat(10), agentType: 'explore' });
    const row = strip(agentRow(a, false, 40));
    expect(row.length).toBeLessThanOrEqual(40);
  });

  it('选中时前缀 ›', () => {
    const row = strip(agentRow(meta({}), true, 80));
    expect(row.startsWith('›')).toBe(true);
  });
});

describe('④ AgentsOverlay render + handleInput', () => {
  const agents = [
    meta({ id: 'r1', status: 'running', agentType: 'explore', name: '搜文件', messageCount: 12 }),
    meta({ id: 'd1', status: 'done', agentType: 'general', name: '改代码', messageCount: 8 }),
  ];

  it('render 产出标题 + 列表 + 详情 + footer', () => {
    const overlay = new AgentsOverlay({
      getAgents: () => agents,
      onBrowse: () => {},
      requestRender: () => {},
      onClose: () => {},
    });
    const lines = overlay.render(80).map(strip);
    expect(lines[0]).toContain('子 agent 总览');
    expect(lines.join('\n')).toContain('搜文件');
    expect(lines.join('\n')).toContain('改代码');
    expect(lines[lines.length - 1]).toContain('Esc 关闭');
  });

  it('空列表给提示', () => {
    const overlay = new AgentsOverlay({
      getAgents: () => [],
      onBrowse: () => {},
      requestRender: () => {},
      onClose: () => {},
    });
    const lines = overlay.render(80).map(strip);
    expect(lines.join('\n')).toContain('没有派生过');
  });

  it('Enter 调 onBrowse 并传 id', () => {
    const onBrowse = vi.fn();
    const overlay = new AgentsOverlay({
      getAgents: () => agents,
      onBrowse,
      requestRender: () => {},
      onClose: () => {},
    });
    overlay.handleInput('\r');
    expect(onBrowse).toHaveBeenCalledWith('r1'); // 第一条 = running
  });

  it('Esc 调 onClose', () => {
    const onClose = vi.fn();
    const overlay = new AgentsOverlay({
      getAgents: () => agents,
      onBrowse: () => {},
      requestRender: () => {},
      onClose,
    });
    overlay.handleInput('\x1b');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('↓ 切换选中后 Enter 取第二条', () => {
    const onBrowse = vi.fn();
    const overlay = new AgentsOverlay({
      getAgents: () => agents,
      onBrowse,
      requestRender: () => {},
      onClose: () => {},
    });
    overlay.handleInput('\x1b[B'); // down
    overlay.handleInput('\r');
    expect(onBrowse).toHaveBeenCalledWith('d1');
  });
});
