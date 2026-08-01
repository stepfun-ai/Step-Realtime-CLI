import { z } from 'zod';
import { ok, type ToolDef } from './types.js';

const TodoItemSchema = z.object({
  title: z.string().min(1).describe('简短、可执行的任务标题。'),
  status: z.enum(['pending', 'in_progress', 'done']).describe('当前状态。'),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

const schema = z.object({
  todos: z
    .array(TodoItemSchema)
    .optional()
    .describe('更新后的完整任务清单（整体替换）。省略则只读取当前清单；传空数组则清空。'),
});

function render(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return '（任务清单为空）';
  return todos
    .map((t, i) => {
      const mark = t.status === 'done' ? '✓' : t.status === 'in_progress' ? '●' : '○';
      return `${i + 1}. ${mark} [${t.status}] ${t.title}`;
    })
    .join('\n');
}

const SOFT_REMINDER =
  '\n\n提醒：继续用任务清单跟踪进度。完成一项立即标记 done，并保持恰好一个 in_progress。';

/**
 * 维护任务清单（TODO）。多步骤、跨回合的任务用它来跟踪进度，防止遗漏。
 * 本体存独立 store（不占对话历史），读写合一：传 todos 整体替换 / 空数组清空 / 省略只读。
 * in_progress 唯一是软约束——靠提醒，不强制校验。
 */
export const todoListTool: ToolDef<z.infer<typeof schema>> = {
  name: 'todo_list',
  description:
    '维护当前任务清单（TODO）。多步骤任务用它跟踪进度：传 todos 整体替换清单，传空数组清空，不传参数则读取当前清单。条目 {title, status: pending/in_progress/done}。',
  schema,
  async execute(input, ctx) {
    if (ctx.todos === undefined) {
      return ok('当前上下文不支持任务清单。');
    }
    if (input.todos === undefined) {
      return ok(`当前任务清单：\n${render(ctx.todos.items)}`);
    }
    ctx.todos.items.splice(0, ctx.todos.items.length, ...input.todos);
    if (input.todos.length === 0) {
      return ok('已清空任务清单。');
    }
    return ok(`已更新任务清单：\n${render(ctx.todos.items)}${SOFT_REMINDER}`);
  },
};
