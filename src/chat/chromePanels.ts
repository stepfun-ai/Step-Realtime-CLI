/**
 * 常驻 chrome 面板的纯逻辑：TODO 清单裁剪与队列预览裁剪。
 *
 * 从旧版的 TodoPanel / QueuePreview 抽出（那边逻辑与 JSX 混在一起）。
 * 渲染在 tui-pi/ChromePanels.ts，这里只做「显示哪些、怎么裁」的决策，可单测。
 */
import type { TodoItem } from '../tools/types.js';

/** TODO 面板最多可见条数。 */
export const TODO_MAX_VISIBLE = 5;
/** 队列预览最多逐条展示的条数。 */
export const QUEUE_MAX_ITEMS = 3;
/** 单条队列预览最多显示的行数。 */
export const QUEUE_MAX_LINES = 2;

/** 回合收尾判定：清单非空且全部完成 → 清空，面板不常驻；有未完成项则跨回合保留。 */
export function allTodosDone(todos: readonly TodoItem[]): boolean {
  return todos.length > 0 && todos.every((td) => td.status === 'done');
}

/**
 * 空间不足时按状态优先级选可见条目（输出保持原清单顺序）：
 * 1) 进行中全部保留——回答「正在做什么」，是面板的核心信息；
 * 2) 最新一条已完成——保留进度上下文，更早的已完成先被挤掉；
 * 3) 按原顺序填充待办——回答「接下来做什么」；
 * 4) 待办不足时从最近往回补，填满名额。
 *
 * 直接 slice 尾部会让前面堆积的已完成把进行中/待办挤出可视区，所以按状态选而非按位置切。
 */
export function selectVisibleTodos(todos: readonly TodoItem[], max: number = TODO_MAX_VISIBLE): TodoItem[] {
  if (todos.length <= max) return [...todos];
  const picked = new Set<number>();
  const take = (i: number): void => {
    if (picked.size < max) picked.add(i);
  };
  todos.forEach((td, i) => {
    if (td.status === 'in_progress') take(i);
  });
  if (picked.size < max) {
    for (let i = todos.length - 1; i >= 0; i--) {
      if (todos[i]!.status === 'done') {
        picked.add(i);
        break;
      }
    }
  }
  for (let i = 0; i < todos.length && picked.size < max; i++) {
    if (todos[i]!.status === 'pending') take(i);
  }
  for (let i = todos.length - 1; i >= 0 && picked.size < max; i--) {
    take(i);
  }
  return [...picked].sort((a, b) => a - b).map((i) => todos[i]!);
}

/** 隐藏条目的状态分布（折叠行用；零值不列）。 */
export function hiddenTodoCounts(
  todos: readonly TodoItem[],
  visible: readonly TodoItem[],
): { total: number; inProgress: number; pending: number; done: number } {
  const visibleSet = new Set(visible);
  const hidden = todos.filter((td) => !visibleSet.has(td));
  return {
    total: hidden.length,
    inProgress: hidden.filter((td) => td.status === 'in_progress').length,
    pending: hidden.filter((td) => td.status === 'pending').length,
    done: hidden.filter((td) => td.status === 'done').length,
  };
}

/** 把一条队列消息裁成最多 QUEUE_MAX_LINES 行；超出的行丢弃并在末尾补省略号。 */
export function previewQueueEntry(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= QUEUE_MAX_LINES) return text;
  return `${lines.slice(0, QUEUE_MAX_LINES).join('\n')} …`;
}

/**
 * 队列里没有系统注入条目，所以预览不需要「系统条目占位」逻辑。
 *
 * Ink 版有这一层（notifyMsgRef / silentQueuedRef 两张登记表判定后台通知信封与 silent
 * 注入文本，显示成人读占位）。pi 版查过 `this.queue.push` 的全部调用点，只有两处：
 * 用户在 busy 期间提交的文本、以及会改动回合前提的斜杠命令原文——都是用户自己写的。
 * 后台通知走 `injectBackgroundNotifications` 直接进回合，不经队列。
 *
 * 这条注释留着是为了下次有人往队列里塞系统文本时知道要补占位渲染。
 */

