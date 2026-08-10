import { Box, Text } from 'ink';
import type { TodoItem } from '../tools/types.js';
import { t } from '../i18n.js';

const MAX_VISIBLE = 5;

/** 回合收尾判定：清单非空且全部完成 → 清空，面板不常驻；有未完成项则跨回合保留。 */
export function allTodosDone(todos: readonly TodoItem[]): boolean {
  return todos.length > 0 && todos.every((td) => td.status === 'done');
}

/**
 * 空间不足时按状态优先级选可见条目（输出保持原清单顺序）：
 * 1) 进行中全部保留——回答「正在做什么」，是面板的核心信息；
 * 2) 最新一条已完成——保留进度上下文，更早的已完成先被挤掉；
 * 3) 按原顺序填充待办——回答「接下来做什么」；
 * 4) 待办不足时从最近往回补已完成，填满名额。
 * 硬切列表尾部（slice）会让前面堆积的已完成把进行中/待办挤出可视区，故按状态选。
 */
export function selectVisibleTodos(todos: readonly TodoItem[], max: number = MAX_VISIBLE): TodoItem[] {
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
      if (todos[i].status === 'done') {
        picked.add(i);
        break;
      }
    }
  }
  for (let i = 0; i < todos.length && picked.size < max; i++) {
    if (todos[i].status === 'pending') take(i);
  }
  for (let i = todos.length - 1; i >= 0 && picked.size < max; i--) {
    take(i);
  }
  return [...picked].sort((a, b) => a - b).map((i) => todos[i]);
}

/** 精简常驻 TODO 面板：显示当前任务清单，最多 5 条（按状态优先级裁剪）+ 折叠行。 */
export function TodoPanel({ todos }: { todos: readonly TodoItem[] }): React.ReactElement | null {
  if (todos.length === 0) return null;
  const visible = selectVisibleTodos(todos);
  const visibleSet = new Set(visible);
  const hidden = todos.filter((td) => !visibleSet.has(td));
  // 折叠行带隐藏条目的状态分布（非零才列），让被裁掉的部分可感知
  const hiddenCounts = { in_progress: 0, pending: 0, done: 0 };
  for (const td of hidden) hiddenCounts[td.status]++;
  const detailParts: string[] = [];
  if (hiddenCounts.in_progress > 0) detailParts.push(`${hiddenCounts.in_progress} ${t('todo.status.doing')}`);
  if (hiddenCounts.pending > 0) detailParts.push(`${hiddenCounts.pending} ${t('todo.status.pending')}`);
  if (hiddenCounts.done > 0) detailParts.push(`${hiddenCounts.done} ${t('todo.status.done')}`);
  const hiddenDetail = detailParts.join(' · ');
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="cyan" bold wrap="truncate">
        {t('todo.title')}
      </Text>
      {visible.map((t, i) => {
        const mark = t.status === 'done' ? '✓' : t.status === 'in_progress' ? '●' : '○';
        const color = t.status === 'done' ? 'green' : t.status === 'in_progress' ? 'cyan' : 'gray';
        const strike = t.status === 'done';
        return (
          // 长 title 截断到一行（wrap=truncate），保证动态区高度预算按 1 行/条精确成立
          <Text key={i} color={color} strikethrough={strike} wrap="truncate">
            {`${mark} ${t.title}`}
          </Text>
        );
      })}
      {hidden.length > 0 ? (
        <Text color="gray" wrap="truncate">
          {t('todo.more', { count: hidden.length, detail: hiddenDetail })}
        </Text>
      ) : null}
    </Box>
  );
}
