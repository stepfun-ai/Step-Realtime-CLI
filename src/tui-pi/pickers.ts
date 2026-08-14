/**
 * 选择器（M3）：会话 / 模型 / 思考深度。
 *
 * 与 Ink 版的实现差异：三个选择器在 Ink 侧各自维护「候选列表 + 过滤串 + 选中位 + 视口跟随」
 * （ModelPicker 还专门修过一次「选中项滚出可视区不跟随」），这里全部交给 pi-tui 的
 * SelectList——它自带过滤、滚动信息与视口跟随，我们只提供候选项与结算回调。
 *
 * 挂载方式用 tui.showOverlay：overlay 在 diff 之前被合成进行数组，本身参与同一套差分渲染，
 * 不存在 Ink 的 Static/动态区之分，所以选择器不需要额外的行数预算计算
 * （Ink 版为此维护了 estimateChromeRows / planBoxRows 这类与渲染结构一一对应的公式）。
 */
import { SelectList, matchesKey, type Component, type OverlayHandle, type SelectItem, type TUI } from '@earendil-works/pi-tui';
import type { SessionMeta } from '../session/store.js';
import type { StepCodeConfig } from '../config/config.js';
import { c, selectListTheme } from './theme.js';

/** 相对时间（与 Ink 版 SessionPicker.relativeTime 同口径）。 */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.round(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * 带标题与过滤输入的选择器外壳。
 * SelectList 自己处理 ↑↓/Enter/Esc，过滤串由本壳收字符后 setFilter 下推。
 */
export class PickerOverlay implements Component {
  private readonly title: string;
  private readonly list: SelectList;
  private filter = '';
  private readonly onCancel: () => void;
  private readonly requestRender: () => void;
  /** 额外按键处理（如会话选择器的 d 删除）；返回 true 表示已消费。 */
  private readonly onKey?: (data: string, selected: SelectItem | null) => boolean;
  private readonly hint: string;

  constructor(opts: {
    title: string;
    items: SelectItem[];
    maxVisible?: number;
    hint?: string;
    requestRender: () => void;
    onSelect: (item: SelectItem) => void;
    onCancel: () => void;
    onKey?: (data: string, selected: SelectItem | null) => boolean;
  }) {
    this.title = opts.title;
    this.hint = opts.hint ?? '↑↓ 选择 · Enter 确认 · 输入过滤 · Esc 取消';
    this.requestRender = opts.requestRender;
    this.onCancel = opts.onCancel;
    this.list = new SelectList(opts.items, opts.maxVisible ?? 12, selectListTheme);
    this.list.onSelect = opts.onSelect;
    this.list.onCancel = opts.onCancel;
    this.onKey = opts.onKey;
  }

  invalidate(): void {
    this.list.invalidate();
  }

  setItems(items: SelectItem[]): void {
    // SelectList 没有 setItems，重建过滤即可让它重新计算候选
    (this.list as unknown as { items: SelectItem[] }).items = items;
    this.list.setFilter(this.filter);
    this.requestRender();
  }

  getSelected(): SelectItem | null {
    return this.list.getSelectedItem();
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      this.onCancel();
      return;
    }
    if (this.onKey?.(data, this.list.getSelectedItem()) === true) return;
    if (matchesKey(data, 'backspace') || matchesKey(data, 'delete')) {
      this.filter = [...this.filter].slice(0, -1).join('');
      this.list.setFilter(this.filter);
      this.requestRender();
      return;
    }
    // 可打印字符进过滤串；其余（方向键、Enter）交给 SelectList
    if (data.length === 1 && data.charCodeAt(0) >= 32 && data !== ' ') {
      this.filter += data;
      this.list.setFilter(this.filter);
      this.requestRender();
      return;
    }
    this.list.handleInput(data);
    this.requestRender();
  }

  render(width: number): string[] {
    const head = `${c.accent(this.title)}${this.filter !== '' ? c.dim(`  过滤：${this.filter}`) : ''}`;
    return [head, ...this.list.render(width), c.dim(this.hint)];
  }
}

/** 会话选择器候选项：标题 + 相对时间 + 消息数。 */
export function sessionItems(metas: readonly SessionMeta[], now = Date.now()): SelectItem[] {
  return metas.map((m) => ({
    value: m.id,
    label: m.name ?? m.title ?? m.preview?.slice(0, 40) ?? m.id,
    description: `${relativeTime(m.updatedAt, now)} · ${m.messageCount} 条 · ${m.id.slice(0, 8)}`,
  }));
}

/**
 * 模型选择器候选项：按渠道分组（同渠道的别名连续排列），描述里带真实 id 与窗口大小。
 * 当前生效的别名标一个「当前」。
 */
export function modelItems(config: StepCodeConfig, currentAlias?: string): SelectItem[] {
  const entries = Object.entries(config.models ?? {});
  const byChannel = new Map<string, { alias: string; model: string; ctx?: number; display?: string }[]>();
  for (const [alias, entry] of entries) {
    const channel = entry.provider ?? config.provider ?? 'default';
    const list = byChannel.get(channel) ?? [];
    list.push({ alias, model: entry.model ?? alias, ctx: entry.maxContextSize, display: entry.displayName });
    byChannel.set(channel, list);
  }
  const items: SelectItem[] = [];
  for (const [channel, list] of [...byChannel.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const it of list) {
      const ctxText = it.ctx !== undefined ? ` · ${Math.round(it.ctx / 1000)}k` : '';
      const mark = it.alias === currentAlias ? '● ' : '';
      items.push({
        value: it.alias,
        label: `${mark}${it.display ?? it.alias}`,
        description: `${channel} · ${it.model}${ctxText}`,
      });
    }
  }
  return items;
}

/** 思考深度候选项：三档 + 关闭 + 跟随配置默认。 */
export function thinkItems(current?: string): SelectItem[] {
  const rows: { value: string; label: string; description: string }[] = [
    { value: 'high', label: 'high', description: '最深思考，慢但更稳' },
    { value: 'medium', label: 'medium', description: '默认档位' },
    { value: 'low', label: 'low', description: '浅思考，快' },
    { value: 'off', label: 'off', description: '本会话不发思考字段' },
    { value: '__default__', label: '跟随配置默认', description: '清除会话级覆盖' },
  ];
  return rows.map((r) => ({
    ...r,
    label: (current === r.value || (current === undefined && r.value === '__default__') ? '● ' : '') + r.label,
  }));
}

/** 把选择器挂成 overlay 并返回结果（取消为 null）。 */
export function showPicker(
  tui: TUI,
  opts: {
    title: string;
    items: SelectItem[];
    hint?: string;
    onKey?: (data: string, selected: SelectItem | null, overlay: PickerOverlay) => boolean;
  },
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let overlay: PickerOverlay | undefined;
    let handle: OverlayHandle | undefined;
    const finish = (value: string | null): void => {
      handle?.hide();
      tui.requestRender();
      resolve(value);
    };
    overlay = new PickerOverlay({
      title: opts.title,
      items: opts.items,
      hint: opts.hint,
      requestRender: () => tui.requestRender(),
      onSelect: (item) => finish(item.value),
      onCancel: () => finish(null),
      onKey: (data, selected) => (opts.onKey !== undefined && overlay !== undefined ? opts.onKey(data, selected, overlay) : false),
    });
    handle = tui.showOverlay(overlay, { width: '80%', maxHeight: '70%', anchor: 'center' });
    handle.focus();
    tui.requestRender();
  });
}
