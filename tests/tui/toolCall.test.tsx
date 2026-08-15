import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { ToolCall } from '../../src/tui/ToolCall.js';
import type { DisplayItem } from '../../src/chat/types.js';

function toolItem(over: Partial<Extract<DisplayItem, { kind: 'tool' }>>): Extract<
  DisplayItem,
  { kind: 'tool' }
> {
  return { kind: 'tool', id: 't1', name: 'list_dir', input: {}, status: 'ok', ...over };
}

const bigResult = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n');

describe('ToolCall 折叠/展开', () => {
  it('skill 工具标题带上技能名（否则多次激活的卡片长得一模一样）', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ToolCall, {
        item: toolItem({ name: 'skill', input: { skill: 'pkm-vault-ops' } }),
        expanded: false,
      }),
    );
    expect(lastFrame() ?? '').toContain('pkm-vault-ops');
    unmount();
  });

  it('常规工具仍按 path/command 取摘要', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ToolCall, {
        item: toolItem({ name: 'read', input: { path: 'src/tui/ToolCall.tsx' } }),
        expanded: false,
      }),
    );
    expect(lastFrame() ?? '').toContain('src/tui/ToolCall.tsx');
    unmount();
  });

  it('成功且有输出，折叠态只显示「N 行输出 · Ctrl+O 查看」提示，不显示正文', () => {
    const { lastFrame } = render(
      React.createElement(ToolCall, { item: toolItem({ result: bigResult }), expanded: false }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('12 行输出');
    expect(frame).toContain('Ctrl+O 查看');
    expect(frame).not.toContain('line7'); // 正文未展开
  });

  it('edit 真实输出形态（summary 行 + diff 头在第二行）：折叠态直接展示 diff 主体，不折叠成一行', () => {
    // 73cd43d 起 edit.ts 的实际结果就是「已编辑 …（替换 N 处）。\n+N -M path\n…diff 行…」，
    // 早前判定只测 lines[0]，diff 分支对真实 edit 结果从未生效（回归覆盖）
    const editResult = '已编辑 src/a.ts（替换 1 处）。\n+2 -1 src/a.ts\n   10  ctx\n   11 +added\n   12 -removed';
    const { lastFrame } = render(
      React.createElement(ToolCall, { item: toolItem({ name: 'edit_file', result: editResult }), expanded: false }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('已编辑 src/a.ts');
    expect(frame).toContain('+2 -1 src/a.ts');
    expect(frame).toContain('added');
    expect(frame).not.toContain('行输出');
  });

  it('普通输出前两行意外匹配 diff 头形态时才走 diff 分支（仅前两行参与判定）', () => {
    // 第三行才出现 +N 形态不算 diff，仍整段折叠
    const notDiff = 'line1\nline2\n+5 src/a.ts\nline4';
    const { lastFrame } = render(
      React.createElement(ToolCall, { item: toolItem({ result: notDiff }), expanded: false }),
    );
    expect(lastFrame() ?? '').toContain('4 行输出');
  });

  it('展开态显示完整正文', () => {
    const { lastFrame } = render(
      React.createElement(ToolCall, { item: toolItem({ result: bigResult }), expanded: true }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('line1');
    expect(frame).toContain('line12');
  });

  it('出错时折叠态显示前几行预览 + 剩余行提示', () => {
    const { lastFrame } = render(
      React.createElement(ToolCall, {
        item: toolItem({ status: 'error', result: bigResult }),
        expanded: false,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('line1');
    expect(frame).toContain('还有'); // 「… 还有 N 行 · Ctrl+O 查看」
    expect(frame).toContain('Ctrl+O 查看');
  });

  it('无输出的工具不显示结果体', () => {
    const { lastFrame } = render(
      React.createElement(ToolCall, { item: toolItem({ result: '' }), expanded: false }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('list_dir');
    expect(frame).not.toContain('行输出');
  });

  // --- 缺口 1：spawn_agent 卡片显示角色 + 描述 ---
  it('spawn_agent 显示角色名与描述（灰色方括号包裹）', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ToolCall, {
        item: toolItem({
          name: 'spawn_agent',
          subagentType: 'general-fast',
          description: '修复登录页样式',
        }),
        expanded: false,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('spawn_agent');
    expect(frame).toContain('general-fast');
    expect(frame).toContain('修复登录页样式');
    expect(frame).toContain('[');
    expect(frame).toContain(']');
    unmount();
  });

  it('spawn_agent 仅有角色名无描述时仍正确显示', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ToolCall, {
        item: toolItem({
          name: 'spawn_agent',
          subagentType: 'explore',
          description: undefined,
        }),
        expanded: false,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('explore');
    expect(frame).not.toContain('·'); // 单字段不出现分隔符
    unmount();
  });

  it('非 spawn_agent 工具不显示角色描述区', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ToolCall, {
        item: toolItem({ name: 'read_file', subagentType: 'x', description: 'y' }),
        expanded: false,
      }),
    );
    // subagentType/description 在非 spawn_agent 条目上不会出现（构造时不会写进去，这里只测兜底）
    const frame = lastFrame() ?? '';
    expect(frame).toContain('read_file');
    unmount();
  });

  it('错误输出按 errorPreviewLines 预览（默认 4）', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `err${i + 1}`).join('\n');
    const { lastFrame } = render(
      React.createElement(ToolCall, { item: toolItem({ status: 'error', result: lines }), expanded: false }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('err1');
    expect(frame).toContain('err4');
    expect(frame).not.toContain('err5');
    expect(frame).toContain('还有 6 行');
  });

  it('errorPreviewLines=2 时只预览前 2 行', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `err${i + 1}`).join('\n');
    const { lastFrame } = render(
      React.createElement(ToolCall, { item: toolItem({ status: 'error', result: lines }), expanded: false, errorPreviewLines: 2 }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('err1');
    expect(frame).toContain('err2');
    expect(frame).not.toContain('err3');
    expect(frame).toContain('还有 8 行');
  });

  // --- 缺口 2：spawn_agent 嵌套子工具调用渲染 ---
  const makeSpawnAgentItem = (over: Partial<Extract<DisplayItem, { kind: 'tool' }>> = {}) =>
    toolItem({
      name: 'spawn_agent',
      subagentType: 'explore',
      description: '调查竞品排版',
      ...over,
    });

  it('运行中超过 3 条子调用时只显示最近 3 条 + 计数行', () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      name: `tool_${i + 1}`,
      status: 'ok' as const,
    }));
    const { lastFrame } = render(
      React.createElement(ToolCall, {
        item: makeSpawnAgentItem({ status: 'running', subagentToolEvents: events }),
        expanded: false,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('tool_3');
    expect(frame).toContain('tool_4');
    expect(frame).toContain('tool_5');
    expect(frame).not.toContain('tool_1');
    expect(frame).not.toContain('tool_2');
    expect(frame).toContain('已完成 2 次工具调用');
  });

  it('成功时整组坍缩回一行统计', () => {
    const events = [
      { name: 'read_file', status: 'ok' as const },
      { name: 'grep', status: 'ok' as const },
      { name: 'bash', status: 'ok' as const },
    ];
    const { lastFrame, unmount } = render(
      React.createElement(ToolCall, {
        item: makeSpawnAgentItem({
          status: 'ok',
          startedAt: 1700000000000 - 47000,
          subagentToolEvents: events,
        }),
        expanded: false,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('spawn_agent');
    expect(frame).toContain('explore');
    expect(frame).toContain('调查竞品排版');
    expect(frame).toContain('3 次工具调用');
    expect(frame).not.toContain('↳');
    unmount();
  });

  it('失败时保留尾部子调用现场 + 错误输出预览', () => {
    const events = [
      { name: 'read_file', status: 'ok' as const },
      { name: 'grep', status: 'error' as const },
      { name: 'bash', status: 'error' as const },
    ];
    const { lastFrame, unmount } = render(
      React.createElement(ToolCall, {
        item: makeSpawnAgentItem({
          status: 'error',
          startedAt: 1700000000000 - 12000,
          result: 'Error: command failed\nexit code 1\nmore details here\nline4',
          subagentToolEvents: events,
        }),
        expanded: false,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('↳');
    expect(frame).toContain('grep');
    expect(frame).toContain('bash');
    expect(frame).toContain('✗');
    expect(frame).toContain('Error: command failed');
    expect(frame).toContain('exit code 1');
    unmount();
  });

  it('展开态显示完整子调用历史', () => {
    const events = [
      { name: 'read_file', status: 'ok' as const },
      { name: 'grep', status: 'error' as const },
    ];
    const { lastFrame } = render(
      React.createElement(ToolCall, {
        item: makeSpawnAgentItem({ status: 'error', subagentToolEvents: events }),
        expanded: true,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('read_file');
    expect(frame).toContain('grep');
    expect(frame).not.toContain('已完成');
  });
});
