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
import { Container, Editor, SelectList, matchesKey, visibleWidth, type Component, type OverlayHandle, type SelectItem, type TUI } from '@earendil-works/pi-tui';
import type { SessionMeta } from '../session/store.js';
import type { StepCodeConfig } from '../config/config.js';
import { c, editorTheme, selectListTheme } from './theme.js';
import { t } from '../i18n.js';

/** 相对时间（与 Ink 版 SessionPicker.relativeTime 同口径）。 */
export function relativeTime(iso: string, now = Date.now()): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '';
  const sec = Math.max(0, Math.round((now - parsed) / 1000));
  if (sec < 60) return t('time.secondsAgo', { count: sec });
  const min = Math.round(sec / 60);
  if (min < 60) return t('time.minutesAgo', { count: min });
  const hour = Math.round(min / 60);
  if (hour < 24) return t('time.hoursAgo', { count: hour });
  const day = Math.round(hour / 24);
  if (day < 30) return t('time.daysAgo', { count: day });
  return new Date(parsed).toISOString().slice(0, 10);
}

export interface PickerTab {
  id: string;
  label: string;
}

/**
 * 带标题与过滤输入的选择器外壳。
 * SelectList 自己处理 ↑↓/Enter，过滤串由本壳收字符后 setFilter 下推。
 *
 * 渠道 tab（对应 Ink 版 ModelPicker 的 tab 条）：tabs 多于一个时渲染 tab 条，
 * Tab / Shift+Tab 取模回卷切换；每个 tab 独立记忆过滤词与选中项，切换时保存/恢复。
 * Esc 语义与 Ink 对齐：有过滤词先清词，再按一次才取消。
 */
export class PickerOverlay implements Component {
  private readonly title: string;
  private list: SelectList;
  private filter = '';
  private readonly onSelectItem: (item: SelectItem) => void;
  private readonly onCancel: () => void;
  private readonly requestRender: () => void;
  /** 额外按键处理（如会话选择器的 d 删除）；返回 true 表示已消费。 */
  private readonly onKey?: (data: string, selected: SelectItem | null) => boolean;
  private readonly hint: string;
  private readonly maxVisible: number;
  /** Shift+Enter 确认（如模型选择器的「仅本会话生效」）；不设则 shift+enter 走普通确认。 */
  private readonly onShiftSelect?: (item: SelectItem) => void;
  private readonly tabs: PickerTab[];
  private readonly itemsForTab?: (tabId: string) => SelectItem[];
  private activeTab = 0;
  /** 每个 tab 记忆的视图状态：过滤词 + 选中项 value。 */
  private readonly tabStates = new Map<number, { filter: string; selected?: string }>();

  constructor(opts: {
    title: string;
    items: SelectItem[];
    maxVisible?: number;
    hint?: string;
    requestRender: () => void;
    onSelect: (item: SelectItem) => void;
    onCancel: () => void;
    onKey?: (data: string, selected: SelectItem | null) => boolean;
    onShiftSelect?: (item: SelectItem) => void;
    tabs?: PickerTab[];
    itemsForTab?: (tabId: string) => SelectItem[];
    initialTab?: string;
  }) {
    this.title = opts.title;
    this.hint = opts.hint ?? t('picker.hint.default');
    this.requestRender = opts.requestRender;
    this.onSelectItem = opts.onSelect;
    this.onCancel = opts.onCancel;
    this.maxVisible = opts.maxVisible ?? 12;
    this.onShiftSelect = opts.onShiftSelect;
    this.tabs = opts.tabs ?? [];
    this.itemsForTab = opts.itemsForTab;
    if (opts.initialTab !== undefined) {
      const idx = this.tabs.findIndex((t) => t.id === opts.initialTab);
      if (idx >= 0) this.activeTab = idx;
    }
    this.list = this.buildList(opts.items);
    this.onKey = opts.onKey;
  }

  private buildList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, this.maxVisible, selectListTheme);
    list.onSelect = (item) => this.onSelectItem(item);
    list.onCancel = () => this.onCancel();
    return list;
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

  /** 切 tab：保存当前 tab 的过滤词与选中项，恢复目标 tab 的（对应 Ink 版 switchTab）。 */
  private switchTab(dir: 1 | -1): void {
    this.tabStates.set(this.activeTab, { filter: this.filter, selected: this.list.getSelectedItem()?.value });
    this.activeTab = (this.activeTab + dir + this.tabs.length) % this.tabs.length;
    const saved = this.tabStates.get(this.activeTab);
    this.filter = saved?.filter ?? '';
    const items = this.itemsForTab?.(this.tabs[this.activeTab]!.id) ?? [];
    // 重建 SelectList：候选集换掉后选中索引语义失效，按 saved.selected 找回位置
    this.list = this.buildList(items);
    this.list.setFilter(this.filter);
    if (saved?.selected !== undefined) {
      const idx = items.findIndex((i) => i.value === saved.selected);
      if (idx >= 0) this.list.setSelectedIndex(idx);
    }
    this.requestRender();
  }

  handleInput(data: string): void {
    if (this.tabs.length > 1 && (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab'))) {
      this.switchTab(matchesKey(data, 'shift+tab') ? -1 : 1);
      return;
    }
    if (matchesKey(data, 'escape')) {
      // 与 Ink 对齐：有过滤词先清词，再按一次才取消
      if (this.filter !== '') {
        this.filter = '';
        this.list.setFilter('');
        this.requestRender();
        return;
      }
      this.onCancel();
      return;
    }
    if (this.onShiftSelect !== undefined && matchesKey(data, 'shift+enter')) {
      const sel = this.list.getSelectedItem();
      if (sel !== null) this.onShiftSelect(sel);
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
    const head = `${c.accent(this.title)}${this.filter !== '' ? c.dim(t('picker.filterPrefix') + this.filter) : ''}`;
    const lines = [head];
    if (this.tabs.length > 1) {
      // tab 条：active 反色加粗，其余灰色；总宽超 width 时右端截断加 …（v1 不做滚动窗口）
      let bar = '';
      for (let i = 0; i < this.tabs.length; i++) {
        const t = this.tabs[i]!;
        const seg = i === this.activeTab ? c.tabActive(` ${t.label} `) : c.dim(` ${t.label} `);
        const next = bar === '' ? seg : `${bar} ${seg}`;
        if (visibleWidth(next) > width - 3) {
          bar += c.dim(' …');
          break;
        }
        bar = next;
      }
      lines.push(bar);
    }
    return [...lines, ...this.list.render(width), c.dim(this.hint)];
  }
}

/** 会话选择器候选项：标题 + 相对时间 + 消息数。 */
export function sessionItems(metas: readonly SessionMeta[], now = Date.now()): SelectItem[] {
  return metas.map((m) => ({
    value: m.id,
    label: m.name ?? m.title ?? m.preview?.slice(0, 40) ?? m.id,
    description: `${relativeTime(m.updatedAt, now)} · ${t('sessionPicker.count', { count: m.messageCount })} · ${m.id.slice(0, 8)}`,
  }));
}

/**
 * 模型选择器候选项：按渠道分组（同渠道的别名连续排列，渠道按配置首现顺序），
 * 描述里带真实 id 与窗口大小。当前生效的别名标一个「当前」。
 * channel 传入且非 'all' 时只留该渠道条目（渠道 tab 的结构性预过滤）。
 */
export function modelItems(config: StepCodeConfig, currentAlias?: string, channel?: string): SelectItem[] {
  const entries = Object.entries(config.models ?? {});
  const byChannel = new Map<string, { alias: string; model: string; ctx?: number; display?: string }[]>();
  for (const [alias, entry] of entries) {
    const ch = entry.provider ?? config.provider ?? 'default';
    const list = byChannel.get(ch) ?? [];
    list.push({ alias, model: entry.model ?? alias, ctx: entry.maxContextSize, display: entry.displayName });
    byChannel.set(ch, list);
  }
  const items: SelectItem[] = [];
  for (const [ch, list] of byChannel.entries()) {
    if (channel !== undefined && channel !== 'all' && ch !== channel) continue;
    for (const it of list) {
      const ctxText = it.ctx !== undefined ? ` · ${Math.round(it.ctx / 1000)}k` : '';
      const mark = it.alias === currentAlias ? '● ' : '';
      items.push({
        value: it.alias,
        label: `${mark}${it.display ?? it.alias}`,
        description: `${ch} · ${it.model}${ctxText}`,
      });
    }
  }
  return items;
}

/** 思考深度候选项：三档 + 关闭 + 跟随配置默认。 */
export function thinkItems(current?: string): SelectItem[] {
  const rows: { value: string; label: string; description: string }[] = [
    { value: 'high', label: 'high', description: t('picker.thinkLevel.high') },
    { value: 'medium', label: 'medium', description: t('picker.thinkLevel.medium') },
    { value: 'low', label: 'low', description: t('picker.thinkLevel.low') },
    { value: 'off', label: 'off', description: t('picker.thinkLevel.off') },
    { value: '__default__', label: t('picker.thinkLevel.default'), description: t('picker.thinkLevel.default') },
  ];
  return rows.map((r) => ({
    ...r,
    label: (current === r.value || (current === undefined && r.value === '__default__') ? '● ' : '') + r.label,
  }));
}

/** 模型选择器的渠道 tab 集合：'all' 恒第一，其余渠道按配置首现顺序（与 modelItems 分组同序）。 */
export function modelTabs(config: StepCodeConfig): PickerTab[] {
  const seen: string[] = [];
  for (const entry of Object.values(config.models ?? {})) {
    const channel = entry.provider ?? config.provider ?? 'default';
    if (!seen.includes(channel)) seen.push(channel);
  }
  return [{ id: 'all', label: t('modelPicker.tabAll') }, ...seen.sort().map((ch) => ({ id: ch, label: ch }))];
}

/** 把选择器挂成 overlay 并返回结果（取消为 null）。 */
export function showPicker(
  tui: TUI,
  opts: {
    title: string;
    items: SelectItem[];
    hint?: string;
    onKey?: (data: string, selected: SelectItem | null, overlay: PickerOverlay) => boolean;
    /** Shift+Enter 确认入口（模型选择器「仅本会话生效」）。 */
    onShiftSelect?: (value: string) => void;
    tabs?: PickerTab[];
    itemsForTab?: (tabId: string) => SelectItem[];
    initialTab?: string;
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
      onShiftSelect:
        opts.onShiftSelect !== undefined
          ? (item) => {
              const v = item.value;
              handle?.hide();
              tui.requestRender();
              resolve(null); // shift 路径自带结算，主 promise 置 null 防重复应用
              opts.onShiftSelect!(v);
            }
          : undefined,
      tabs: opts.tabs,
      itemsForTab: opts.itemsForTab,
      initialTab: opts.initialTab,
    });
    handle = tui.showOverlay(overlay, { width: '80%', maxHeight: '70%', anchor: 'center' });
    handle.focus();
    tui.requestRender();
  });
}

/**
 * 启动期的会话选择器（`--resume` 不带 id 时用）。
 *
 * 与 PiChat 里的 `/resume` 是同一套候选构造，区别只在这里要自己起一个 TuiMainScreen：
 * 此时 PiChat 还没创建，没有可复用的主屏。选完即 stop，屏幕让给随后启动的 PiChat。
 */
export async function pickSessionStandalone(metas: readonly SessionMeta[]): Promise<string | null> {
  const { ProcessTerminal, TuiMainScreen } = await import('@earendil-works/pi-tui');
  const tui = new TuiMainScreen(new ProcessTerminal());
  tui.start();
  try {
    return await showPicker(tui, {
      title: t('picker.resumeTitle'),
      items: sessionItems(metas),
      hint: t('picker.resumeHint'),
    });
  } finally {
    tui.stop();
  }
}

/** 极简单行展示组件（提示行）。原在 FirstRun.ts，会话重命名也要用，移到这里共用。 */
export class Banner implements Component {
  private lines: string[] = [];
  setLines(lines: string[]): void {
    this.lines = lines;
  }
  invalidate(): void {
    // 无缓存：内容极短，每帧重拼比维护脏标记便宜
  }
  render(): string[] {
    return this.lines;
  }
}


export function askLine(tui: TUI, hint: string, initial?: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const host = new Container();
    let settled = false;
    const finish = (v: string | null): void => {
      if (settled) return;
      settled = true;
      tui.removeChild(host);
      tui.requestRender();
      resolve(v);
    };
    const hintLine = new Banner();
    hintLine.setLines([c.dim(hint)]);
    const editor = new EscEditor(tui, editorTheme);
    editor.onSubmit = (text) => finish(text);
    editor.onEscapeKey = () => {
      finish(null);
      return true;
    };
    if (initial !== undefined) editor.setText(initial);
    host.addChild(hintLine);
    host.addChild(editor);
    tui.addChild(host);
    tui.setFocus(editor);
    tui.requestRender();
  });
}

/** Editor 子类：把 Esc 交给引导（父类只用它关补全菜单，这里没有补全）。 */
class EscEditor extends Editor {
  onEscapeKey?: () => boolean;
  override handleInput(data: string): void {
    // \x1b 单字节即 Esc；带后续字节的是方向键等序列，交给父类
    if (data === '\x1b' && this.onEscapeKey?.() === true) return;
    super.handleInput(data);
  }
}
