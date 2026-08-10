import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TodoPanel, allTodosDone, selectVisibleTodos } from '../../src/tui/TodoPanel.js';
import type { TodoItem } from '../../src/tools/types.js';

const td = (title: string, status: TodoItem['status']): TodoItem => ({ title, status });
const titles = (list: readonly TodoItem[]): string[] => list.map((x) => x.title);

describe('allTodosDone（回合收尾清空判定）', () => {
  it('空清单不清空（返回 false，避免无意义重置）', () => {
    expect(allTodosDone([])).toBe(false);
  });

  it('全部 done → true', () => {
    expect(allTodosDone([td('a', 'done'), td('b', 'done')])).toBe(true);
  });

  it('有 pending / in_progress → false（跨回合保留）', () => {
    expect(allTodosDone([td('a', 'done'), td('b', 'pending')])).toBe(false);
    expect(allTodosDone([td('a', 'done'), td('b', 'in_progress')])).toBe(false);
  });
});

describe('selectVisibleTodos（状态优先级裁剪）', () => {
  it('≤5 条全部保留，原顺序不变', () => {
    const todos = [td('a', 'done'), td('b', 'in_progress'), td('c', 'pending')];
    expect(titles(selectVisibleTodos(todos))).toEqual(['a', 'b', 'c']);
  });

  it('进行中的条目不被前面堆积的已完成挤掉', () => {
    // 硬切尾部时前 4 条 done 占满名额，in_progress 与 pending 全被藏掉
    const todos = [
      td('d1', 'done'), td('d2', 'done'), td('d3', 'done'), td('d4', 'done'),
      td('cur', 'in_progress'),
      td('p1', 'pending'), td('p2', 'pending'), td('p3', 'pending'),
    ];
    expect(titles(selectVisibleTodos(todos))).toEqual(['d4', 'cur', 'p1', 'p2', 'p3']);
  });

  it('已完成只留最新一条做进度上下文，更早的先被挤掉', () => {
    const todos = [
      td('d1', 'done'), td('d2', 'done'), td('d3', 'done'),
      td('cur', 'in_progress'),
      td('p1', 'pending'), td('p2', 'pending'), td('p3', 'pending'), td('p4', 'pending'),
    ];
    const vis = titles(selectVisibleTodos(todos));
    expect(vis).toEqual(['d3', 'cur', 'p1', 'p2', 'p3']);
    expect(vis).not.toContain('d1');
    expect(vis).not.toContain('d2');
  });

  it('多个进行中全部保留，剩余名额按原顺序填待办', () => {
    const todos = [
      td('ip1', 'in_progress'), td('ip2', 'in_progress'), td('ip3', 'in_progress'),
      td('p1', 'pending'), td('p2', 'pending'), td('p3', 'pending'), td('p4', 'pending'),
    ];
    expect(titles(selectVisibleTodos(todos))).toEqual(['ip1', 'ip2', 'ip3', 'p1', 'p2']);
  });

  it('待办不足时从最近往回补已完成填满名额', () => {
    const todos = [
      td('d1', 'done'), td('d2', 'done'), td('d3', 'done'), td('d4', 'done'),
      td('d5', 'done'), td('d6', 'done'), td('d7', 'done'),
      td('cur', 'in_progress'),
    ];
    expect(titles(selectVisibleTodos(todos))).toEqual(['d4', 'd5', 'd6', 'd7', 'cur']);
  });

  it('全 pending 超限时按原顺序取前 5 条', () => {
    const todos = Array.from({ length: 8 }, (_, i) => td(`p${i}`, 'pending'));
    expect(titles(selectVisibleTodos(todos))).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
  });
});

describe('TodoPanel 面板', () => {
  it('空列表不渲染', () => {
    const { lastFrame } = render(React.createElement(TodoPanel, { todos: [] }));
    expect(lastFrame() ?? '').toBe('');
  });

  it('全完成时仍渲染（清空由回合收尾负责，不是渲染层）', () => {
    const { lastFrame } = render(
      React.createElement(TodoPanel, { todos: [td('做完了', 'done'), td('也完成了', 'done')] }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('做完了');
    expect(out).toContain('✓');
  });

  it('超过 5 条显示折叠行，带隐藏条目的状态分布', () => {
    const todos = [
      td('d1', 'done'), td('d2', 'done'),
      td('cur', 'in_progress'),
      td('p1', 'pending'), td('p2', 'pending'), td('p3', 'pending'),
      td('p4', 'pending'), td('p5', 'pending'),
    ];
    // 可见：d2 + cur + p1~p3（5 条）；隐藏：d1 + p4 + p5（1 已完成 + 2 待办）
    const { lastFrame } = render(React.createElement(TodoPanel, { todos }));
    const out = lastFrame() ?? '';
    expect(out).toContain('+3');
    expect(out).toContain('2 待办');
    expect(out).toContain('1 已完成');
  });

  it('进行中的任务在已完成堆积时仍可见', () => {
    const todos = [
      td('旧1', 'done'), td('旧2', 'done'), td('旧3', 'done'), td('旧4', 'done'),
      td('正在做', 'in_progress'),
      td('接下来', 'pending'),
    ];
    const { lastFrame } = render(React.createElement(TodoPanel, { todos }));
    const out = lastFrame() ?? '';
    expect(out).toContain('正在做');
    expect(out).toContain('接下来');
  });
});
