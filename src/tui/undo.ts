import type { StoredMessage } from '../agent/message.js';
import type { PermissionMode } from '../agent/permission/mode.js';
import type { TodoItem } from '../tools/types.js';
import type { DisplayItem } from './types.js';

/**
 * /undo 的纯函数层。
 *
 * 语义：撤销最近 N 轮用户 prompt——从第 N 个 origin.kind==='user' 的消息起
 * 到数组末尾全部回滚（含该轮产出的 assistant 回复与 tool 结果），不回滚代码改动。
 * 压缩点之前不可撤销：full 压缩把旧轮的 origin 改写为 user_verbatim/compaction_summary，
 * 按 kind === 'user' 扫描天然不把它们算作轮起点（与 turns.ts/backtrack.ts 同一口径）。
 */

/**
 * 计算撤销最近 n 轮后的历史。
 *
 * 反向扫描找到第 n 个 origin.kind === 'user' 的下标，slice(0, idx)——切点处是轮起点，
 * 其前一条是上一轮收尾，天然不会切开 tool_use↔tool_result 配对，压缩产物前缀也完整保留。
 * n 超过可撤销轮数时撤销到最早可撤销轮为止，removedTurns 记实际撤销数。
 * 没有可撤销的轮（或 n < 1）返回 null。不修改入参（返回新切片）。
 */
export function computeUndo(
  history: StoredMessage[],
  n: number,
): { history: StoredMessage[]; removedTurns: number } | null {
  if (!Number.isInteger(n) || n < 1) return null;
  let idx = -1;
  let seen = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.origin.kind === 'user') {
      seen += 1;
      idx = i;
      if (seen === n) break;
    }
  }
  if (idx === -1) return null;
  return { history: history.slice(0, idx), removedTurns: seen };
}

/**
 * 转录区（items）回退 n 轮：移除最后第 n 条 kind === 'user' 的条目及其之后的所有条目，
 * 与 computeUndo 的历史截断在视觉上对齐。user 条目不足 n 条时截到最早一条之前；
 * 没有 user 条目时原样返回。
 * 注意：静默注入轮（goal 续接/cron/skill 激活）在 history 里算轮但没有 user 条目，
 * 转录区截断是近似对齐（与 backtrack 的单轮截断同一假设）。
 */
export function truncateItemsAtTurns(items: DisplayItem[], n: number): DisplayItem[] {
  if (n < 1) return items;
  let idx = -1;
  let seen = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.kind === 'user') {
      seen += 1;
      idx = i;
      if (seen === n) break;
    }
  }
  if (idx === -1) return items;
  return items.slice(0, idx);
}

/**
 * per-turn 附带状态快照。todo 列表与 plan 模式都是「整体替换、无历史」的，
 * 无法从现状反推第 N 轮之前的状态，必须在每轮 submit 首次改动 history 前压栈留存。
 */
export interface UndoSnapshot {
  /** 压栈时 history 的长度 = 该轮首次改动前的精确截断边界（含 hook 注入的前置 user 消息）。 */
  historyLen: number;
  /** 该轮之前的 todo 列表（浅拷贝数组；条目对象只会被整体替换、不会原地改，见 todoList.ts）。 */
  todos: TodoItem[];
  /** 该轮之前的 plan 模式开关。 */
  planMode: boolean;
  /** 该轮之前的 prePlanMode（进 plan 前的权限档）。 */
  prePlanMode: PermissionMode | null;
}

/** 压栈：每轮 submit 首次改动 history 之前调用。 */
export function pushUndoSnapshot(stack: UndoSnapshot[], snapshot: UndoSnapshot): void {
  stack.push(snapshot);
}

/**
 * 弹栈：弹出最近 count 份快照（不足则全弹），返回最深（最早）那一份作为恢复目标；
 * 栈空或 count < 1 返回 undefined。返回undefined 时调用方只能回退 history，附带状态保持现状。
 */
export function popUndoSnapshots(stack: UndoSnapshot[], count: number): UndoSnapshot | undefined {
  if (count < 1 || stack.length === 0) return undefined;
  const pops = Math.min(count, stack.length);
  const target = stack[stack.length - pops]!;
  stack.length -= pops;
  return target;
}

/** 清栈：/new、/resume、/fork、/compact 时调用（跨会话错乱防护；压缩后旧快照失去意义）。 */
export function clearUndoSnapshots(stack: UndoSnapshot[]): void {
  stack.length = 0;
}
