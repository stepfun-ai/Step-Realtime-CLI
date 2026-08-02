import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { AgentGroup, formatAgentGroupSummary } from '../../src/tui/AgentGroup.js';

describe('AgentGroup 面板', () => {
  it('多个并行子 agent 显示并行计数与各状态', () => {
    const { lastFrame } = render(
      React.createElement(AgentGroup, {
        agents: [
          { id: '1', type: 'explore', description: '统计 a.txt', status: 'done', toolCount: 3, startedAt: 0, endedAt: 3000 },
          { id: '2', type: 'explore', description: '统计 b.txt', status: 'running', toolCount: 1, activity: 'grep', startedAt: Date.now() },
          { id: '3', type: 'explore', description: '统计 c.txt', status: 'queued', toolCount: 0, startedAt: Date.now() },
        ],
      }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('并行子 agent');
    expect(out).toContain('3 个');
    expect(out).toContain('统计 b.txt');
    expect(out).toContain('grep');
  });

  it('多个并行子 agent 全部完成显示汇总', () => {
    const { lastFrame } = render(
      React.createElement(AgentGroup, {
        agents: [
          { id: '1', type: 'explore', description: 'a', status: 'done', toolCount: 2, startedAt: 0, endedAt: 1000 },
          { id: '2', type: 'explore', description: 'b', status: 'done', toolCount: 1, startedAt: 0, endedAt: 1000 },
        ],
      }),
    );
    expect(lastFrame() ?? '').toContain('并行子 agent 完成');
  });

  it('单个子 agent 显示「子 agent 运行中」（不含并行/蜂群措辞）', () => {
    const { lastFrame } = render(
      React.createElement(AgentGroup, {
        agents: [{ id: '1', type: 'explore', description: '搜索', status: 'running', toolCount: 1, activity: 'grep', startedAt: Date.now() }],
      }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('子 agent 运行中');
    expect(out).not.toContain('蜂群');
    expect(out).not.toContain('并行');
  });

  it('空列表不渲染', () => {
    const { lastFrame } = render(React.createElement(AgentGroup, { agents: [] }));
    expect(lastFrame() ?? '').toBe('');
  });

  it('行格式：tools · 时长 · tok 三段（分钟级带秒、千进制 tok）', () => {
    // startedAt 留 800ms 余量：满负载并跑时渲染延迟不跨秒界（500ms 曾在全量运行下抖动）
    const { lastFrame } = render(
      React.createElement(AgentGroup, {
        agents: [
          { id: '1', type: 'explore', description: '统计代码结构', status: 'running', toolCount: 14, startedAt: Date.now() - 148_200, tokens: 107_000 },
        ],
      }),
    );
    expect(lastFrame() ?? '').toContain('14 tools · 2m 28s · 107k tok');
  });

  it('tokens 为 0 / 缺省不显示 tok 段', () => {
    const { lastFrame } = render(
      React.createElement(AgentGroup, {
        agents: [
          { id: '1', type: 'explore', description: 'a', status: 'running', toolCount: 3, startedAt: Date.now() - 5_200, tokens: 0 },
          { id: '2', type: 'explore', description: 'b', status: 'running', toolCount: 1, startedAt: Date.now() - 5_200 },
        ],
      }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('3 tools · 5s ·');
    expect(out).toContain('1 tools · 5s ·');
    expect(out).not.toContain('tok ·');
  });

  it('终态行显示定格时长（endedAt − startedAt），不随渲染时刻跳动', () => {
    const { lastFrame } = render(
      React.createElement(AgentGroup, {
        agents: [
          { id: '1', type: 'explore', description: 'a', status: 'done', toolCount: 2, startedAt: 1_000, endedAt: 46_000, tokens: 2500 },
        ],
      }),
    );
    expect(lastFrame() ?? '').toContain('2 tools · 45s · 2.5k tok · ✓');
  });
});

describe('formatAgentGroupSummary（全终态冻结进历史的摘要）', () => {
  it('多个子 agent：头部计数 + 逐条树形行', () => {
    const text = formatAgentGroupSummary([
      { id: '1', type: 'explore', description: '统计 a.txt', status: 'done', toolCount: 3, startedAt: 0, endedAt: 3000 },
      { id: '2', type: 'coder', description: '改 b.ts', status: 'done', toolCount: 5, startedAt: 0, endedAt: 3000 },
    ]);
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('并行子 agent 完成：2 个');
    expect(lines[1]).toContain('├─ explore · 统计 a.txt · 3 tools · 3s · ✓ 完成');
    expect(lines[2]).toContain('└─ coder · 改 b.ts · 5 tools · 3s · ✓ 完成');
  });

  it('含失败：头部带失败计数，失败行用 ✗', () => {
    const text = formatAgentGroupSummary([
      { id: '1', type: 'explore', description: 'a', status: 'done', toolCount: 1, startedAt: 0, endedAt: 1000 },
      { id: '2', type: 'explore', description: 'b', status: 'error', toolCount: 2, startedAt: 0, endedAt: 1000 },
    ]);
    expect(text).toContain('并行子 agent 完成：2 个（1 失败）');
    expect(text).toContain('✗ 失败');
  });

  it('单个子 agent：用单数头部，无并行措辞', () => {
    const text = formatAgentGroupSummary([
      { id: '1', type: 'explore', description: '搜索', status: 'done', toolCount: 4, startedAt: 0, endedAt: 3000 },
    ]);
    expect(text).toContain('✓ 子 agent 已完成');
    expect(text).not.toContain('并行');
    expect(text).toContain('└─ explore · 搜索 · 4 tools · 3s · ✓ 完成');
  });

  it('摘要带定格时长与最终 tokens（可回看的定稿记录）', () => {
    const text = formatAgentGroupSummary([
      { id: '1', type: 'explore', description: '统计 a.txt', status: 'done', toolCount: 14, startedAt: 0, endedAt: 148_000, tokens: 107_000 },
    ]);
    expect(text).toContain('14 tools · 2m 28s · 107k tok · ✓ 完成');
  });
});
