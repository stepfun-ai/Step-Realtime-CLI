/**
 * 输入框正上方的常驻 chrome 面板：TODO 清单 + 发送队列预览。
 *
 * 常驻 chrome：待办面板 + 队列预览，挂在输入框上方。
 *
 * 1. **不参与高度预算降级。** 常驻不收缩，busy 时也不让位
 *    QueuePreview 再丢 TodoPanel），因为动态区超屏会触发清屏事故。pi-tui 差分渲染没有
 *    这个失效模式，面板按内容决定行数，不需要预算协商。
 * 2. **合并成一个组件。** 两块内容都是「输入框上方的状态区」，行数都由数据决定，
 *    合成一个组件后 TUI 组件链少一个节点，且两块之间的空行归属明确。
 *
 * 空数据时 render 返回空数组，一行都不占。
 */
import { truncateToWidth, type Component } from '@earendil-works/pi-tui';
import type { TodoItem } from '../tools/types.js';
import {
  QUEUE_MAX_ITEMS,
  hiddenTodoCounts,
  previewQueueEntry,
  selectVisibleTodos,
} from '../chat/chromePanels.js';
import { c } from './theme.js';
import { t } from '../i18n.js';

export class ChromePanels implements Component {
  private todos: readonly TodoItem[] = [];
  private queue: readonly string[] = [];
  private busy = false;

  setTodos(todos: readonly TodoItem[]): void {
    this.todos = todos;
  }

  setQueue(queue: readonly string[]): void {
    this.queue = queue;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  invalidate(): void {
    // 无缓存：数据变了就重排，两块内容都是十几行以内的字符串拼接
  }

  render(width: number): string[] {
    const out: string[] = [];
    out.push(...renderTodos(this.todos, width));
    out.push(...renderQueue(this.queue, width, this.busy));
    return out;
  }
}

/** TODO 清单：标题 + 最多 5 条（按状态优先级裁剪）+ 折叠计数行。 */
export function renderTodos(todos: readonly TodoItem[], width: number): string[] {
  if (todos.length === 0) return [];
  const visible = selectVisibleTodos(todos);
  const out = [c.toolName(t('panel.todo.title'))];
  for (const td of visible) {
    const mark = td.status === 'done' ? c.ok('✓') : td.status === 'in_progress' ? c.toolName('●') : c.dim('○');
    const title = td.status === 'done' ? c.dim(td.title) : td.status === 'in_progress' ? td.title : c.dim(td.title);
    // 单条截断到一行：面板高度按 1 行/条精确成立，长标题不折行把面板顶高
    out.push(truncateToWidth(`${mark} ${title}`, width));
  }
  const hidden = hiddenTodoCounts(todos, visible);
  if (hidden.total > 0) {
    const parts: string[] = [];
    if (hidden.inProgress > 0) parts.push(t('panel.todo.inProgress', { count: hidden.inProgress }));
    if (hidden.pending > 0) parts.push(t('panel.todo.pending', { count: hidden.pending }));
    if (hidden.done > 0) parts.push(t('panel.todo.done', { count: hidden.done }));
    out.push(c.dim(truncateToWidth(t('panel.todo.more', { count: hidden.total, parts: parts.join(' · ') }), width)));
  }
  return out;
}

/** 队列预览：标题 + 逐条 ↳ 预览（最多 3 条 × 2 行）+ 折叠计数 + 取回提示。 */
export function renderQueue(queue: readonly string[], width: number, busy = false): string[] {
  if (queue.length === 0) return [];
  const shown = queue.slice(0, QUEUE_MAX_ITEMS);
  const rest = queue.length - shown.length;
  const out = [c.dim(t('panel.queue.title', { count: queue.length }))];
  for (const q of shown) {
    const lines = previewQueueEntry(q).split('\n');
    lines.forEach((line, j) => {
      out.push(c.dim(truncateToWidth(`${j === 0 ? '  ↳ ' : '    '}${line}`, width)));
    });
  }
  if (rest > 0) out.push(c.dim(t('panel.queue.more', { count: rest })));
  // 取回提示分两种态：busy 时 Esc 中断而非取回，改用 ↑ 逐条取回；
  // 空闲时 Esc 把队列合并回输入框。
  out.push(c.dim(busy ? t('panel.queue.recallBusy') : t('panel.queue.recall')));
  return out;
}
