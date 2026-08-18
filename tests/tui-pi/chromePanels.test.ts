/**
 * 常驻 chrome 面板（待办 + 队列预览）：裁剪逻辑与渲染。
 */
import { describe, expect, it } from 'vitest';
import { allTodosDone, previewQueueEntry, selectVisibleTodos, hiddenTodoCounts } from '../../src/chat/chromePanels.js';
import { ChromePanels, renderQueue, renderTodos } from '../../src/tui-pi/ChromePanels.js';
import type { TodoItem } from '../../src/tools/types.js';

function plain(lines: readonly string[]): string[] {
  // eslint-disable-next-line no-control-regex
  return lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
}

const td = (title: string, status: TodoItem['status']): TodoItem => ({ title, status });

describe('selectVisibleTodos 按状态优先级裁剪', () => {
  it('不超上限时原样返回', () => {
    const list = [td('a', 'pending'), td('b', 'done')];
    expect(selectVisibleTodos(list, 5)).toEqual(list);
  });

  it('进行中全部保留，堆积的已完成先被挤掉', () => {
    const list = [
      td('done1', 'done'),
      td('done2', 'done'),
      td('done3', 'done'),
      td('doing', 'in_progress'),
      td('todo1', 'pending'),
      td('todo2', 'pending'),
    ];
    const visible = selectVisibleTodos(list, 3).map((t) => t.title);
    expect(visible).toContain('doing');
    expect(visible).toContain('todo1');
    // 只保留最新一条已完成（done3），更早的挤掉
    expect(visible).not.toContain('done1');
    expect(visible).not.toContain('done2');
  });

  it('输出保持原清单顺序（不按状态重排）', () => {
    const list = [td('p1', 'pending'), td('d1', 'in_progress'), td('p2', 'pending'), td('x', 'done'), td('p3', 'pending')];
    const visible = selectVisibleTodos(list, 3).map((t) => t.title);
    const orderInList = visible.map((t) => list.findIndex((i) => i.title === t));
    expect(orderInList).toEqual([...orderInList].sort((a, b) => a - b));
  });
});

describe('allTodosDone 回合收尾清空判定', () => {
  it('空清单不算完成（避免把「没有待办」当成「刚做完」）', () => {
    expect(allTodosDone([])).toBe(false);
  });
  it('全部 done 才算完成', () => {
    expect(allTodosDone([td('a', 'done'), td('b', 'done')])).toBe(true);
    expect(allTodosDone([td('a', 'done'), td('b', 'pending')])).toBe(false);
  });
});

describe('hiddenTodoCounts 折叠计数', () => {
  it('按状态分类统计被裁掉的条目', () => {
    const list = [td('a', 'done'), td('b', 'done'), td('c', 'pending'), td('d', 'pending')];
    const visible = [list[3]!];
    const h = hiddenTodoCounts(list, visible);
    expect(h).toEqual({ total: 3, inProgress: 0, pending: 1, done: 2 });
  });
});

describe('previewQueueEntry 队列条目裁行', () => {
  it('不超 2 行原样返回，超出截断加省略号', () => {
    expect(previewQueueEntry('one line')).toBe('one line');
    expect(previewQueueEntry('a\nb')).toBe('a\nb');
    expect(previewQueueEntry('a\nb\nc\nd')).toBe('a\nb …');
  });
});

describe('renderTodos / renderQueue', () => {
  it('空数据零行（不占位）', () => {
    expect(renderTodos([], 60)).toEqual([]);
    expect(renderQueue([], 60)).toEqual([]);
  });

  it('待办渲染标记：✓ 已完成 · ● 进行中 · ○ 待办', () => {
    const lines = plain(renderTodos([td('做完的', 'done'), td('在做的', 'in_progress'), td('没做的', 'pending')], 60));
    expect(lines[0]).toContain('待办');
    expect(lines[1]).toBe('✓ 做完的');
    expect(lines[2]).toBe('● 在做的');
    expect(lines[3]).toBe('○ 没做的');
  });

  it('超 5 条给折叠行，带隐藏项状态分布', () => {
    const list = [
      ...Array.from({ length: 4 }, (_, i) => td(`done${i}`, 'done')),
      td('doing', 'in_progress'),
      ...Array.from({ length: 3 }, (_, i) => td(`todo${i}`, 'pending')),
    ];
    const lines = plain(renderTodos(list, 60));
    const last = lines[lines.length - 1]!;
    expect(last).toContain('还有 3 条');
    expect(last).toContain('已完成');
  });

  it('长标题截断到一行（面板高度按 1 行/条成立）', () => {
    const lines = renderTodos([td('标题'.repeat(60), 'pending')], 40);
    for (const l of lines) expect(l.replace(/\x1b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(40);
  });

  it('队列预览逐条 ↳，超 3 条折叠计数，末行给取回提示', () => {
    const lines = plain(renderQueue(['第一条', '第二条', '第三条', '第四条'], 60));
    expect(lines[0]).toContain('发送队列（4 条');
    expect(lines[1]).toBe('  ↳ 第一条');
    expect(lines.some((l) => l.includes('还有 1 条'))).toBe(true);
    expect(lines[lines.length - 1]).toContain('Esc 取回');
  });

  it('多行队列条目续行缩进对齐', () => {
    const lines = plain(renderQueue(['第一行\n第二行'], 60));
    expect(lines[1]).toBe('  ↳ 第一行');
    expect(lines[2]).toBe('    第二行');
  });

  it('busy 时取回提示变为 ↑ 取回一条（而非 Esc 取回）', () => {
    const idle = plain(renderQueue(['msg'], 60, false));
    const busy = plain(renderQueue(['msg'], 60, true));
    expect(idle[idle.length - 1]).toContain('Esc 取回');
    expect(busy[busy.length - 1]).toContain('↑ 取回');
    expect(busy[busy.length - 1]).not.toContain('Esc 取回');
  });

  it('ChromePanels.setBusy 传递到 renderQueue 的 busy 态', () => {
    const p = new ChromePanels();
    p.setQueue(['msg']);
    p.setBusy(true);
    const lines = plain(p.render(60));
    expect(lines[lines.length - 1]).toContain('↑ 取回');
  });

  it('ChromePanels 组合两块：待办在上、队列在下', () => {
    const p = new ChromePanels();
    p.setTodos([td('待办项', 'pending')]);
    p.setQueue(['排队消息']);
    const lines = plain(p.render(60));
    const todoIdx = lines.findIndex((l) => l.includes('待办项'));
    const queueIdx = lines.findIndex((l) => l.includes('排队消息'));
    expect(todoIdx).toBeGreaterThanOrEqual(0);
    expect(queueIdx).toBeGreaterThan(todoIdx);
  });

  it('ChromePanels 无数据时整体零行', () => {
    expect(new ChromePanels().render(60)).toEqual([]);
  });
});
