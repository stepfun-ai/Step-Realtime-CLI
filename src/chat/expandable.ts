/**
 * 收集可在全屏查看器（Ctrl+O）中展开的条目——纯逻辑，无渲染。
 *
 * 可展开条目判定与收集：被折叠的工具输出、长 thinking 等进入全屏查看器。
 * - 工具条目：已完成（非 running）且有被折叠的结果体；spawn_agent 带嵌套子调用也算
 * - thinking 条目：行数超过折叠阈值（主界面只显示前 N 行，其余「还有 N 行」）
 * - 其它类型（user/assistant/note/error/goalPanel/cron）不进查看器
 *
 * 收集方向是从最新向前、保最新，最多 max 条；再按 user 条目为轮边界正向分组。
 */
import type { DisplayItem } from './types.js';

/** thinking 定稿后在主界面显示的行数（超过则折叠，进查看器）。 */
export const THINKING_FOLD_LINES = 3;

export interface ExpandableEntry {
  /** 在原 items 里的下标（查看器内定位用）。 */
  index: number;
  item: Extract<DisplayItem, { kind: 'tool' | 'thinking' }>;
}

export interface TurnGroup {
  /** 轮起始的 user 文本；首条 user 之前的条目为 null（显示「会话开始」）。 */
  userText: string | null;
  entries: ExpandableEntry[];
}

/** 结果体是否在主界面被折叠（决定工具条目是否进查看器）。 */
function hasCollapsedResult(item: Extract<DisplayItem, { kind: 'tool' }>): boolean {
  if (item.status === 'running' || item.result === undefined || item.result === '') return false;
  if (item.name === 'spawn_agent' && (item.subagentToolEvents?.length ?? 0) > 0) return true;
  const lines = item.result.split('\n');
  if (looksLikeDiff(lines)) return lines.length > 200; // diff 主界面截 200 行，超了才进
  // 错误预览前 4 行；普通成功输出整段折叠成一行 → 任何非空 result 都可展开
  return lines.length > 4 || lines[0] !== '';
}

/** diff 头判定（与 blocks.ts 同口径，避免引入循环依赖故本地复制）。 */
function looksLikeDiff(lines: readonly string[]): boolean {
  return lines.some((l) => l.startsWith('@@') || l.startsWith('--- ') || l.startsWith('+++ '));
}

function isExpandable(item: DisplayItem): item is Extract<DisplayItem, { kind: 'tool' | 'thinking' }> {
  if (item.kind === 'tool') return hasCollapsedResult(item);
  if (item.kind === 'thinking') return item.text.split('\n').length > THINKING_FOLD_LINES;
  return false;
}

/**
 * 从最新向前收集最多 max 条可展开项，再按 user 条目正向分组成轮。
 * 返回的 groups 顺序是时间正序（最早的轮在前），组内 entries 也是正序。
 */
export function collectExpandable(items: readonly DisplayItem[], max = 10): TurnGroup[] {
  const picked: ExpandableEntry[] = [];
  for (let i = items.length - 1; i >= 0 && picked.length < max; i--) {
    const it = items[i]!;
    if (isExpandable(it)) picked.push({ index: i, item: it });
  }
  picked.reverse();

  const groups: TurnGroup[] = [];
  let current: TurnGroup = { userText: null, entries: [] };
  for (const e of picked) {
    // 找这条 entry 之前最近的一个 user 条目作为轮边界
    let userText: string | null = null;
    for (let j = e.index - 1; j >= 0; j--) {
      const it = items[j]!;
      if (it.kind === 'user') {
        userText = it.text.split('\n')[0] ?? '';
        break;
      }
    }
    if (userText !== current.userText) {
      if (current.entries.length > 0) groups.push(current);
      current = { userText, entries: [] };
    }
    current.entries.push(e);
  }
  if (current.entries.length > 0) groups.push(current);
  return groups;
}

/** 展平成「轮标题 + 条目内容」的有序行块，供查看器渲染与轮间跳转定位。 */
export interface RenderedSection {
  kind: 'turn-header' | 'entry' | 'blank';
  text: string;
}

/**
 * 把轮组渲染成行块序列。entryRenderer 把单条展开内容变成字符串行数组——
 * 由渲染层（ExpandOverlay）提供，因为它要复用 ItemBlock 的 diff 着色等逻辑。
 * 返回 sections 以及每个轮标题在展平行序列里的行号（←/→ 轮间跳转用）。
 */
export function sectionsFromGroups(
  groups: TurnGroup[],
  entryRenderer: (item: Extract<DisplayItem, { kind: 'tool' | 'thinking' }>) => string[],
): { lines: string[]; turnStarts: number[] } {
  const lines: string[] = [];
  const turnStarts: number[] = [];
  for (const g of groups) {
    turnStarts.push(lines.length);
    lines.push(g.userText === null ? '── 会话开始 ──' : `── ${g.userText.length > 60 ? g.userText.slice(0, 60) + '…' : g.userText} ──`);
    for (const e of g.entries) {
      const head = e.item.kind === 'tool' ? `· ${e.item.name}` : '· thinking';
      lines.push(head);
      for (const body of entryRenderer(e.item)) lines.push(body);
    }
    lines.push('');
  }
  return { lines, turnStarts };
}
