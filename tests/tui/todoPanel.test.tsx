import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TodoPanel, allTodosDone } from '../../src/tui/TodoPanel.js';
import type { TodoItem } from '../../src/tools/types.js';

const td = (title: string, status: TodoItem['status']): TodoItem => ({ title, status });

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

  it('超过 5 条显示 +N more', () => {
    const todos = Array.from({ length: 7 }, (_, i) => td(`任务${i}`, 'pending'));
    const { lastFrame } = render(React.createElement(TodoPanel, { todos }));
    expect(lastFrame() ?? '').toContain('2');
  });
});
