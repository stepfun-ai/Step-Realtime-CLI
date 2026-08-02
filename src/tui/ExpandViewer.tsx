import { Box, Text, measureElement, useInput, type DOMElement } from 'ink';
import { useLayoutEffect, useRef, useState } from 'react';
import { t } from '../i18n.js';
import { MessageItem, THINKING_MAX_LINES } from './MessageList.js';
import { OffsetViewport } from './OffsetViewport.js';
import { hasCollapsedBody } from './ToolCall.js';
import type { DisplayItem } from './types.js';

/** 查看器最多回看的可展开条目数（再多翻页成本盖过收益，保最新）。 */
const MAX_ITEMS = 10;

type ToolItem = Extract<DisplayItem, { kind: 'tool' }>;
type ThinkingItem = Extract<DisplayItem, { kind: 'thinking' }>;
/** 查看器条目：可展开工具输出 + 被折叠的 thinking 定稿块（同一 Ctrl+O 也展开 thinking）。 */
export type ViewerItem = ToolItem | ThinkingItem;

/**
 * 一轮分组：user 条目是轮边界；entries 为该轮内收集到的可展开条目（时间正序）。
 * 第一个 user 之前的条目（如恢复的旧会话残留、系统首批输出）归 userText=null 的组，
 * 渲染为「会话开始」。
 */
export interface TurnGroup {
  userText: string | null;
  entries: ViewerItem[];
}

/** thinking 定稿块是否真的被折叠（>THINKING_MAX_LINES 才藏了内容，短块全文已可见、不进查看器）。 */
function hasFoldedThinking(it: ThinkingItem): boolean {
  return it.text.split('\n').length > THINKING_MAX_LINES;
}

/** 可展开条目判定（收集口径的单一来源，收集与分组共用）。 */
function isExpandable(it: DisplayItem): it is ViewerItem {
  if (it.kind === 'tool') return hasCollapsedBody(it);
  if (it.kind === 'thinking') return hasFoldedThinking(it);
  return false;
}

/**
 * 从已定稿条目里收集最近的可展开条目并按轮分组返回（组与组内条目均时间正序，最多 max 条）。
 * 先按 v1 口径从最新往回选出 ≤max 条（保证保最新），再正向扫描 items 以 user 条目为边界分组。
 */
export function collectExpandable(items: readonly DisplayItem[], max: number = MAX_ITEMS): TurnGroup[] {
  // 第一遍：从最新往回标出入选下标（口径与 v1 一致：最多 max 条，保最新）
  const picked = new Set<number>();
  for (let i = items.length - 1; i >= 0 && picked.size < max; i--) {
    if (isExpandable(items[i]!)) picked.add(i);
  }
  // 第二遍：正向扫描，user 条目推进轮边界，入选条目落进当前轮
  const groups: TurnGroup[] = [];
  let userText: string | null = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.kind === 'user') {
      userText = it.text;
      continue;
    }
    if (!picked.has(i)) continue;
    const last = groups[groups.length - 1];
    if (last !== undefined && last.userText === userText) {
      last.entries.push(it as ViewerItem);
    } else {
      groups.push({ userText, entries: [it as ViewerItem] });
    }
  }
  return groups;
}

/**
 * Ctrl+O 全屏查看器 v2：替换动态区与输入槽，把最近的可展开条目按轮分组、原生渲染
 * （MessageItem expanded——Markdown/diff 上色/thinking 斜体与主界面同口径），
 * 放进 OffsetViewport 偏移窗口里滚动。
 *
 * 嵌套滚动语义：外层是终端 scrollback（<Static> 定稿历史只追加），查看器是动态区内的
 * 独立内层窗口——OffsetViewport 外层 maxHeight+overflow=hidden 同步压帧高（首帧也不超高，
 * Ink 不进清屏分支、scrollback 不被拽顶），内层负 marginTop=-offset 平移露出
 * [offset, offset+viewRows) 窗口；offset 即本组件的滚动状态（行级）。
 *
 * 轮次导航：每组一个带 ref 容器，useLayoutEffect 里逐个 measureElement 求组高，
 * 前缀和得各轮起始行（存 ref，按键时读，不为它触发渲染）；总自然高经 OffsetViewport
 * 回调进 state，供 clamp 与标题/位置指示。items 流式更新时渲染侧同步 clamp。
 * 关闭由本组件自理（Esc/q/Ctrl+O → onClose），App 只负责开（同 SessionPicker 模式）。
 */
export function ExpandViewer({
  items,
  maxRows,
  onClose,
}: {
  items: readonly DisplayItem[];
  /** 可用行高（含标题栏与底栏，调用方给）；undefined = 不窗口化（非 TTY / 测试环境）。 */
  maxRows?: number;
  onClose: () => void;
}): React.ReactElement {
  const groups = collectExpandable(items);
  const entryCount = groups.reduce((n, g) => n + g.entries.length, 0);
  // 上下各留一行给标题栏与底栏
  const viewRows = maxRows !== undefined ? Math.max(maxRows - 2, 1) : Number.MAX_SAFE_INTEGER;
  const [offset, setOffset] = useState(0);
  const [natural, setNatural] = useState<number | null>(null);
  const total = natural ?? 0;
  const maxOffset = Math.max(0, total - viewRows);
  // items 更新（busy 中流式追加）可能改变总行数：渲染侧同步 clamp，不依赖 effect
  const clamped = Math.min(Math.max(offset, 0), maxOffset);
  const clampTo = (v: number): number => Math.min(Math.max(v, 0), maxOffset);

  // 各组容器 ref：useLayoutEffect 里逐个量组高，前缀和得各轮起始行。
  // 存 ref 而非 state——只有 ←/→ 按键时才读（按键本身经 setOffset 触发渲染），
  // 避免测量 dispatch 再叠一层嵌套更新（流式期的级联风险见 LiveViewport）。
  const groupRefs = useRef<(DOMElement | null)[]>([]);
  const turnStartsRef = useRef<number[]>([]);
  useLayoutEffect(() => {
    const starts: number[] = [];
    let acc = 0;
    for (let i = 0; i < groups.length; i++) {
      starts.push(acc);
      const el = groupRefs.current[i];
      if (el !== null && el !== undefined) acc += measureElement(el).height;
    }
    turnStartsRef.current = starts;
  });

  /** 当前 offset 所在的轮下标（最后一个起始行 ≤ offset 的组）。 */
  const currentTurn = (o: number): number => {
    const starts = turnStartsRef.current;
    let idx = 0;
    for (let i = 0; i < starts.length; i++) {
      if (starts[i]! <= o) idx = i;
      else break;
    }
    return idx;
  };

  useInput((key, meta) => {
    if (meta.escape || key === 'q' || (meta.ctrl && key === 'o')) {
      onClose();
      return;
    }
    if (meta.upArrow || key === 'k') setOffset((o) => clampTo(o - 1));
    else if (meta.downArrow || key === 'j') setOffset((o) => clampTo(o + 1));
    else if (meta.pageUp) setOffset((o) => clampTo(o - viewRows));
    else if (meta.pageDown) setOffset((o) => clampTo(o + viewRows));
    else if (meta.leftArrow) {
      // 上一轮：已在某轮起始行则去前一轮起始行，否则先回本轮起始行
      setOffset((o) => {
        const starts = turnStartsRef.current;
        if (starts.length === 0) return 0;
        const cur = currentTurn(o);
        const target = starts[cur] === o ? Math.max(cur - 1, 0) : cur;
        return clampTo(starts[target]!);
      });
    } else if (meta.rightArrow) {
      // 下一轮：第一个起始行 > 当前 offset 的组（clamp 到 maxOffset）
      setOffset((o) => {
        const starts = turnStartsRef.current;
        for (let i = 0; i < starts.length; i++) {
          if (starts[i]! > o) return clampTo(starts[i]!);
        }
        return clampTo(o);
      });
    } else if (meta.home || key === 'g') setOffset(0);
    else if (meta.end || key === 'G') setOffset(maxOffset);
  });

  const body = groups.map((g, gi) => (
    <Box
      key={gi}
      ref={(el: DOMElement | null) => {
        groupRefs.current[gi] = el;
      }}
      flexDirection="column"
      marginTop={gi === 0 ? 0 : 1}
    >
      <Text color="gray" wrap="truncate">
        {t('expandViewer.turnSeparator', {
          n: gi + 1,
          // userText 单行截断：只取首行，列宽截断交给 wrap=truncate
          text: g.userText !== null ? g.userText.split('\n')[0]! : t('expandViewer.sessionStart'),
        })}
      </Text>
      {g.entries.map((entry, ei) => (
        <MessageItem key={entry.kind === 'tool' ? entry.id : `thinking-${ei}`} item={entry} expanded={true} />
      ))}
    </Box>
  ));

  const lastRow = total === 0 ? 0 : Math.min(clamped + viewRows, total);
  return (
    <Box flexDirection="column">
      <Text color="gray" wrap="truncate">
        {t('expandViewer.title', { turns: groups.length, count: entryCount, lines: total })}
      </Text>
      {maxRows !== undefined ? (
        <OffsetViewport offset={clamped} maxRows={viewRows} onNaturalHeight={(h) => setNatural((prev) => (prev === h ? prev : h))}>
          {body}
        </OffsetViewport>
      ) : (
        <Box flexDirection="column">{body}</Box>
      )}
      <Box justifyContent="space-between">
        <Text color="gray" wrap="truncate">
          {t('expandViewer.footer')}
        </Text>
        <Text color="gray">{t('expandViewer.position', { start: total === 0 ? 0 : clamped + 1, end: lastRow, total })}</Text>
      </Box>
    </Box>
  );
}
