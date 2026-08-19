/**
 * Ctrl+O 全屏查看器。
 *
 * 对应 Ink 版 ExpandViewer：收集最近 ≤10 条可展开条目（被折叠的工具输出、长 thinking、
 * 带嵌套子调用的 spawn_agent），按 user 条目分组成轮，在全屏 overlay 里滚动查看。
 *
 * ## 为什么没用 pi-tui 的 ScrollView（实测结论，2026-08-15）
 *
 * `ScrollView.render()` 只是把子组件全量渲染后原样返回——**裁剪与偏移由 TUI 的布局层
 * 通过 `LAYOUT_NODE` 的 scroll 节点完成**。overlay 里的组件自己调 `render()` 拿行数组，
 * 那条布局路径不经过，于是 ScrollView 退化成透明包装：滚动方法能改内部状态，输出却不变。
 * 手动 `updateLayout()` 也不解决——它只登记高度，不参与渲染。
 *
 * 所以这里自己维护行偏移。这不是重复实现 Ink 的 OffsetViewport：那边要负 margin 加
 * `measureElement` 同步测量（Ink 没有行数组，只有组件树），这里行数组就是事实，
 * 偏移窗口是一次 `slice`。
 *
 * 键位（沿用原键位）：↑/k ↓/j 行滚；PageUp/PageDown 页滚；← → 轮间跳；
 * Home/g End/G 首尾；Esc/q/Ctrl+O 关闭。不做自动跟随（Ink 也没有）。
 */
import { matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from '@earendil-works/pi-tui';
import { collectExpandable, sectionsFromGroups, type TurnGroup } from '../chat/expandable.js';
import type { DisplayItem } from '../chat/types.js';
import { c } from './theme.js';
import { t } from '../i18n.js';

/** 把一条可展开条目渲染成纯文本行（查看器里不折叠，全文铺开）。 */
export type EntryRenderer = (item: Extract<DisplayItem, { kind: 'tool' | 'thinking' }>, width: number) => string[];

export class ExpandOverlay implements Component {
  private readonly lines: string[];
  private readonly turnStarts: number[];
  private readonly entryCount: number;
  /** 视口行数（终端行数减去标题栏与底栏）。 */
  private readonly viewRows: number;
  private offset = 0;
  private readonly requestRender: () => void;
  private readonly close: () => void;

  constructor(opts: {
    groups: TurnGroup[];
    width: number;
    viewportRows: number;
    entryRenderer: EntryRenderer;
    requestRender: () => void;
    onClose: () => void;
  }) {
    this.requestRender = opts.requestRender;
    this.close = opts.onClose;
    this.viewRows = Math.max(1, opts.viewportRows - 2);
    const { lines, turnStarts } = sectionsFromGroups(opts.groups, (item) =>
      stripTrailingBlank(opts.entryRenderer(item, opts.width)),
    );
    this.lines = lines;
    this.turnStarts = turnStarts;
    this.entryCount = opts.groups.reduce((n, g) => n + g.entries.length, 0);
  }

  private get maxOffset(): number {
    return Math.max(0, this.lines.length - this.viewRows);
  }

  private scrollBy(delta: number): void {
    this.offset = Math.max(0, Math.min(this.offset + delta, this.maxOffset));
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+o') || data === 'q') {
      this.close();
      return;
    }
    if (matchesKey(data, 'up') || data === 'k') this.scrollBy(-1);
    else if (matchesKey(data, 'down') || data === 'j') this.scrollBy(1);
    else if (matchesKey(data, 'pageUp')) this.scrollBy(-this.viewRows);
    else if (matchesKey(data, 'pageDown')) this.scrollBy(this.viewRows);
    else if (matchesKey(data, 'home') || data === 'g') this.offset = 0;
    else if (matchesKey(data, 'end') || data === 'G') this.offset = this.maxOffset;
    else if (matchesKey(data, 'left')) this.jumpTurn(-1);
    else if (matchesKey(data, 'right')) this.jumpTurn(1);
    this.requestRender();
  }

  /** ←/→ 跳到上/下一个轮标题；不在轮起始时 ← 先回本轮起始（与 Ink 同语义）。 */
  private jumpTurn(dir: 1 | -1): void {
    let cur = 0;
    for (let i = 0; i < this.turnStarts.length; i++) {
      if (this.turnStarts[i]! <= this.offset) cur = i;
    }
    if (dir === 1) {
      const next = this.turnStarts[cur + 1];
      this.offset = Math.min(next ?? this.maxOffset, this.maxOffset);
      return;
    }
    if (this.offset > this.turnStarts[cur]!) this.offset = this.turnStarts[cur]!;
    else if (cur > 0) this.offset = this.turnStarts[cur - 1]!;
    else this.offset = 0;
  }

  render(width: number): string[] {
    const view = this.lines.slice(this.offset, this.offset + this.viewRows);
    const body = view.map((l) => (l.startsWith('── ') ? c.accent(l) : l));
    const title = c.accent(
      t('expandOverlay.title', { turns: this.turnStarts.length, count: this.entryCount, lines: this.lines.length }),
    );
    const from = this.lines.length === 0 ? 0 : this.offset + 1;
    const to = Math.min(this.offset + this.viewRows, this.lines.length);
    const pos = `${from}-${to}/${this.lines.length}`;
    // 底栏键位分档：完整版放不下时降级到短版（保住关闭提示），再放不下由出口钳宽兜底。
    const full = t('expandOverlay.footer');
    const short = t('expandOverlay.footerShort');
    const fits = (keys: string): boolean => visibleWidth(keys) + 1 + visibleWidth(pos) <= width;
    const keys = fits(full) ? full : short;
    const gap = Math.max(1, width - visibleWidth(keys) - visibleWidth(pos));
    const footer = c.dim(keys + ' '.repeat(gap) + pos);
    // 出口逐行钳宽：正文在构造时按旧宽度折行，终端在 overlay 打开期间 resize 会变窄；
    // footer 在 keys+pos 超宽时 gap 保底 1 列也会溢出。pi-tui doRender 对超宽行直接 throw。
    return [title, ...body, footer].map((l) => truncateToWidth(l, width));
  }

  invalidate(): void {
    // 内容在构造时定稿（打开期间不追增量），无缓存需要失效
  }
}

/** 去掉 ItemBlock 末尾的空行：查看器里条目由轮标题分隔，不需要额外空行。 */
function stripTrailingBlank(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * 便捷入口：收集 + 打开全屏 overlay。无可展开内容时返回 null（调用方据此提示）。
 * 关闭由 overlay 自己触发（Esc/q/Ctrl+O），resolve 时焦点交回调用方给的 onClosed。
 */
export function openExpandViewer(
  tui: TUI,
  items: readonly DisplayItem[],
  entryRenderer: EntryRenderer,
  onClosed?: () => void,
): TurnGroup[] | null {
  const groups = collectExpandable(items);
  if (groups.length === 0) return null;
  const overlay = new ExpandOverlay({
    groups,
    width: tui.terminal.columns ?? 80,
    viewportRows: tui.terminal.rows ?? 24,
    entryRenderer,
    requestRender: () => tui.requestRender(),
    onClose: () => {
      handle.hide();
      onClosed?.();
      tui.requestRender();
    },
  });
  const handle = tui.showOverlay(overlay, { width: '100%', maxHeight: '100%', anchor: 'top-left', margin: 0 });
  handle.focus();
  tui.requestRender();
  return groups;
}
