import { describe, expect, it } from 'vitest';
import { todoListTool } from '../../src/tools/todoList.js';
import type { TodoStore } from '../../src/tools/types.js';

function ctxWith(store: TodoStore) {
  return { cwd: process.cwd(), todos: store };
}

describe('todo_list 工具', () => {
  it('不传 todos → 读取当前清单', async () => {
    const store: TodoStore = { items: [{ title: 'A', status: 'in_progress' }] };
    const r = await todoListTool.execute({}, ctxWith(store));
    expect(r.isError).toBe(false);
    expect(r.content).toContain('A');
    expect(r.content).toContain('in_progress');
  });

  it('传 todos → 整体替换', async () => {
    const store: TodoStore = { items: [{ title: '旧', status: 'done' }] };
    const r = await todoListTool.execute(
      { todos: [{ title: '新1', status: 'pending' }, { title: '新2', status: 'in_progress' }] },
      ctxWith(store),
    );
    expect(r.isError).toBe(false);
    expect(store.items).toEqual([
      { title: '新1', status: 'pending' },
      { title: '新2', status: 'in_progress' },
    ]);
    expect(r.content).toContain('新2');
    expect(r.content).toContain('一个 in_progress'); // 软约束提醒
  });

  it('传空数组 → 清空', async () => {
    const store: TodoStore = { items: [{ title: 'X', status: 'done' }] };
    const r = await todoListTool.execute({ todos: [] }, ctxWith(store));
    expect(r.isError).toBe(false);
    expect(store.items).toEqual([]);
    expect(r.content).toContain('清空');
  });

  it('ctx 无 todos → 提示不支持', async () => {
    const r = await todoListTool.execute({}, { cwd: process.cwd() });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('不支持');
  });
});
