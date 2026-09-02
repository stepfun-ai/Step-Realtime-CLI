/**
 * 选择器（M3）：会话 / 模型 / 思考深度。候选与过滤交给 pi-tui 的 SelectList
 * （自带过滤、视口跟随），本层只提供候选项、tab 与结算回调，以 overlay 挂载。
 */
import { Container, Editor, SelectList, matchesKey, truncateToWidth, visibleWidth, type Component, type OverlayHandle, type SelectItem, type TUI } from '@earendil-works/pi-tui';
import type { SessionMeta } from '../session/store.js';
import type { StepCodeConfig } from '../config/config.js';
import { c, editorTheme, selectListTheme } from './theme.js';
import { t } from '../i18n.js';

/** 相对时间。 */
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
 * SelectList 自己处理 ↑↓/Enter，过滤串由本壳收字符后下推。
 * 渠道 tab：tabs 多于一个时渲染 tab 条，Tab / Shift+Tab 取模回卷切换，
 * 每个 tab 独立记忆过滤词与选中项。Esc 有过滤词先清词，再按一次才取消。
 */
export class PickerOverlay implements Component {
  private readonly title: string;
  private list: SelectList;
  private filter = '';
  private allItems: SelectItem[];
  private readonly onSelectItem: (item: SelectItem) => void;
  private readonly onCancel: () => void;
  private readonly requestRender: () => void;
  /** 额外按键处理（如会话选择器的 d 删除）；返回 true 表示已消费。 */
  private readonly onKey?: (data: string, selected: SelectItem | null) => boolean;
  private readonly hint: string;
  /** 标题下方的说明行。与底部 hint 分开：hint 承担操作键提示，subtitle 放业务说明。 */
  private readonly subtitle?: string;
  private readonly maxVisible: number;
  /** Shift+Enter 确认（如模型选择器的「仅本会话生效」）；不设则 shift+enter 走普通确认。 */
  private readonly onShiftSelect?: (item: SelectItem) => void;
  private readonly tabs: PickerTab[];
  private readonly itemsForTab?: (tabId: string) => SelectItem[];
  private activeTab = 0;
  /** 每个 tab 记忆的视图状态：过滤词 + 选中项 value。 */
  private readonly tabStates = new Map<number, { filter: string; selected?: string }>();
  /** 当前选中索引（用于 ↑↓ 钳制；SelectList 内部回绕，我们在外层拦截改钳制）。 */
  private selIdx = 0;
  /** 当前过滤后的候选数（用于 ↑↓ 钳制判断是否到边界）。 */
  private filteredCount = 0;

  constructor(opts: {
    title: string;
    items: SelectItem[];
    maxVisible?: number;
    hint?: string;
    subtitle?: string;
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
    this.allItems = [...opts.items];
    this.hint = opts.hint ?? t('picker.hint.default');
    this.subtitle = opts.subtitle;
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
    this.filteredCount = opts.items.length;
    this.selIdx = 0;
    this.onKey = opts.onKey;
  }

  /**
   * 自定义过滤：对 value + label + description 做空格分词 AND 子串匹配（大小写不敏感）。
   * SelectList 自带过滤只做 value 前缀匹配，故先在本层筛出候选，再喂给 SelectList 并
   * setFilter('') 原样展示；直接 setFilter 会再触发它的前缀过滤，把结果砍一遍。
   */
  private applyFilter(): void {
    const tokens = this.filter.toLowerCase().split(/\s+/).filter((t) => t !== '');
    let candidates: SelectItem[];
    if (tokens.length === 0) {
      candidates = this.allItems;
    } else {
      candidates = this.allItems.filter((item) => {
        const haystack = `${item.value} ${item.label} ${item.description ?? ''}`.toLowerCase();
        return tokens.every((tok) => haystack.includes(tok));
      });
    }
    // 重建 SelectList：items 换掉后内部索引语义失效
    // 必须传副本：SelectList 内部持有 items 引用，后续 allItems.length=0 会连带清空它
    this.list = this.buildList([...candidates]);
    this.list.setFilter('');
    this.filteredCount = candidates.length;
    this.selIdx = 0;
    this.requestRender();
  }

  private buildList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, this.maxVisible, selectListTheme);
    list.onSelect = (item) => this.onSelectItem(item);
    list.onCancel = () => this.onCancel();
    list.onSelectionChange = (item) => {
      // 同步选中索引：SelectList 内部改了索引，我们也要知道（用于 ↑↓ 钳制）
      const idx = items.indexOf(item);
      if (idx >= 0) this.selIdx = idx;
    };
    return list;
  }

  invalidate(): void {
    this.list.invalidate();
  }

  setItems(items: SelectItem[]): void {
    this.allItems = [...items];
    this.applyFilter();
  }

  getSelected(): SelectItem | null {
    return this.list.getSelectedItem();
  }

  /** 当前过滤串（为空 = 未在搜索）。供 onKey 回调判断 d/r 等快捷键是否该拦截。 */
  getFilter(): string {
    return this.filter;
  }

  /** 切 tab：保存当前 tab 的过滤词与选中项，恢复目标 tab 的。 */
  private switchTab(dir: 1 | -1): void {
    this.tabStates.set(this.activeTab, { filter: this.filter, selected: this.list.getSelectedItem()?.value });
    this.activeTab = (this.activeTab + dir + this.tabs.length) % this.tabs.length;
    const saved = this.tabStates.get(this.activeTab);
    this.filter = saved?.filter ?? '';
    const items = this.itemsForTab?.(this.tabs[this.activeTab]!.id) ?? [];
    // 更新 allItems 为当前 tab 的候选集，让 applyFilter 在正确集合上过滤
    // 必须赋新数组：allItems 可能与外部数组共享引用，length=0 会连带清空外部
    this.allItems = [...items];
    this.list = this.buildList(items);
    this.applyFilter();
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
      // 有过滤词先清词，再按一次才取消
      if (this.filter !== '') {
        this.filter = '';
        this.applyFilter();
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
      this.applyFilter();
      return;
    }
    // 可打印字符进过滤串；空格也进（支持 "step flash" 这种多词 AND 过滤）
    if (data.length === 1 && data.charCodeAt(0) >= 32 && !data.startsWith('\x1b')) {
      this.filter += data;
      this.applyFilter();
      return;
    }
    // Windows 终端 Enter 兼容：部分配置下 Enter 送来 \r/\n/\r\n 或 SS3-OM，
    // pi-tui 的 matchesKey 可能漏认或误判为方向键。这里在最外层显式确认。
    if (data.includes('\r') || data.includes('\n') || data === '\x1bOM') {
      const sel = this.list.getSelectedItem();
      if (sel !== null) this.onSelectItem(sel);
      return;
    }
    // ↑↓ 钳制：SelectList 内部回绕（到顶跳到底），这里在外层拦截钳制
    if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
      if (this.filteredCount > 0) {
        const delta = matchesKey(data, 'up') ? -1 : 1;
        const next = Math.max(0, Math.min(this.selIdx + delta, this.filteredCount - 1));
        if (next !== this.selIdx) {
          this.selIdx = next;
          this.list.setSelectedIndex(this.selIdx);
          this.requestRender();
        }
      }
      return;
    }
    // 兼容 Windows 终端 Enter 键：pi-tui 的 matchesKey 在 Kitty protocol 激活时只认 \r，
    // 但部分 Windows 终端配置下 Enter 送来 \n。归一化后避免按 Enter 没反应。
    // Shift+Enter 已在上方被 onShiftSelect 拦截，这里只影响普通 Enter。
    const inputForList = data === '\n' ? '\r' : data;
    this.list.handleInput(inputForList);
    this.requestRender();
  }

  render(width: number): string[] {
    const head = `${c.accent(this.title)}${this.filter !== '' ? c.dim(t('picker.filterPrefix') + this.filter) : ''}`;
    const lines = [head];
    if (this.subtitle !== undefined) lines.push(c.dim(this.subtitle));
    if (this.tabs.length > 1) {
      // tab 条滚动窗口：放不下时保证 activeTab 可见——从 active 向两侧贪心扩展，
      // 两端有隐藏 tab 时各留 2 列给 ‹ / … 指示符
      const segWidth = (from: number, to: number): number => {
        let w = 0;
        for (let i = from; i < to; i++) {
          w += visibleWidth(this.tabs[i]!.label) + 2; // padding 各 1 列
          if (i > from) w += 1; // 段间空格
        }
        return w;
      };
      const barMax = Math.max(width - 6, 8);
      let start = 0;
      let end = this.tabs.length;
      let hiddenLeft = false;
      let hiddenRight = false;
      if (segWidth(0, this.tabs.length) > barMax) {
        // 贪心窗口：从 activeTab 向两侧扩展，保证 active 可见
        const fits = (s: number, e: number): boolean =>
          segWidth(s, e) + (s > 0 ? 2 : 0) + (e < this.tabs.length ? 2 : 0) <= barMax;
        start = this.activeTab;
        end = this.activeTab + 1;
        for (;;) {
          let grew = false;
          if (end < this.tabs.length && fits(start, end + 1)) { end++; grew = true; }
          if (start > 0 && fits(start - 1, end)) { start--; grew = true; }
          if (!grew) break;
        }
        hiddenLeft = start > 0;
        hiddenRight = end < this.tabs.length;
      }
      let bar = hiddenLeft ? c.dim('‹ ') : '';
      for (let i = start; i < end; i++) {
        const t = this.tabs[i]!;
        const seg = i === this.activeTab ? c.tabActive(` ${t.label} `) : c.dim(` ${t.label} `);
        bar += (bar === '' || bar.endsWith(' ')) ? seg : ` ${seg}`;
      }
      if (hiddenRight) bar += c.dim(' …');
      lines.push(bar);
    }
    // pi-tui 的 doRender 对任何 visibleWidth 超终端宽的行直接 throw 崩溃（实测 line 27/399/5620
    // 都是同类）。tab 贪心窗口只决定显示哪些 tab、不保证总宽不超，title/filter 也可能超长，
    // 故组件层最后一道防线：每行 truncateToWidth 钳到 width。
    return [...lines, ...this.list.render(width), c.dim(this.hint)].map((l) => truncateToWidth(l, width));
  }
}

/** 会话选择器候选项：标题 + 相对时间 + 消息数。 */
export function sessionItems(metas: readonly SessionMeta[], now = Date.now(), currentSessionId?: string): SelectItem[] {
  return metas.map((m) => ({
    value: m.id,
    label: m.id === currentSessionId ? `${c.ok('●')} ${m.name ?? m.title ?? m.preview?.slice(0, 40) ?? m.id}` : (m.name ?? m.title ?? m.preview?.slice(0, 40) ?? m.id),
    description: `${relativeTime(m.updatedAt, now)} · ${t('sessionPicker.count', { count: m.messageCount })} · ${m.id.slice(0, 8)}${m.id === currentSessionId ? ' ' + c.ok(t('sessionPicker.current')) : ''}`,
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
      // 当前生效模型标「当前」（绿色后缀）
      const mark = it.alias === currentAlias ? ` ${c.ok(t('modelPicker.current'))}` : '';
      items.push({
        value: it.alias,
        label: `${it.display ?? it.alias}${mark}`,
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
  return rows.map((r) => {
    const isCurrent = current === r.value || (current === undefined && r.value === '__default__');
    // 当前生效项标「当前」（绿色后缀）
    return {
      ...r,
      label: isCurrent ? `${r.label} ${c.ok(t('modelPicker.current'))}` : r.label,
    };
  });
}

/** 模型选择器的渠道 tab 集合：'all' 恒第一，其余渠道按配置首现顺序（与 modelItems 分组同序）。 */
export function modelTabs(config: StepCodeConfig): PickerTab[] {
  const seen: string[] = [];
  for (const entry of Object.values(config.models ?? {})) {
    const channel = entry.provider ?? config.provider ?? 'default';
    if (!seen.includes(channel)) seen.push(channel);
  }
  return [{ id: 'all', label: t('modelPicker.tabAll') }, ...seen.map((ch) => ({ id: ch, label: ch }))];
}

/**
 * 把选择器挂成 overlay 并返回结果（取消为 null）。
 *
 * 当 opts.container 提供时，改为内联替换输入区模式：
 * - container.clear() 清空容器
 * - container.addChild(overlay) 内联挂载选择器
 * - tui.setFocus(overlay) 路由输入到选择器
 * - 结束时 container.clear() + opts.onRestore() 恢复输入区
 *
 * 当 opts.container 未提供时，走浮层 overlay 模式（向后兼容）。
 */
export function showPicker(
  tui: TUI,
  opts: {
    title: string;
    items: SelectItem[];
    hint?: string;
    /** 标题下方的说明行；业务说明走这里，别塞进 hint（那会顶掉操作键提示）。 */
    subtitle?: string;
    onKey?: (data: string, selected: SelectItem | null, overlay: PickerOverlay) => boolean;
    /** Shift+Enter 确认入口（模型选择器「仅本会话生效」）。 */
    onShiftSelect?: (value: string) => void;
    tabs?: PickerTab[];
    itemsForTab?: (tabId: string) => SelectItem[];
    initialTab?: string;
    /** 内联模式：选择器挂载到此容器（替换输入区）。提供时走内联模式。 */
    container?: Container;
    /** 内联模式：选择器关闭时回调，用于恢复输入区（恢复 editor 焦点）。 */
    onRestore?: () => void;
  },
): Promise<string | null> {
  const inline = opts.container !== undefined;
  return new Promise<string | null>((resolve) => {
    let overlay: PickerOverlay | undefined;
    let handle: OverlayHandle | undefined;
    const finish = (value: string | null): void => {
      if (inline) {
        opts.container!.clear();
        opts.onRestore?.();
      } else {
        handle?.hide();
      }
      tui.requestRender();
      resolve(value);
    };
    overlay = new PickerOverlay({
      title: opts.title,
      items: opts.items,
      hint: opts.hint,
      subtitle: opts.subtitle,
      requestRender: () => tui.requestRender(),
      onSelect: (item) => finish(item.value),
      onCancel: () => finish(null),
      onKey: (data, selected) => (opts.onKey !== undefined && overlay !== undefined ? opts.onKey(data, selected, overlay) : false),
      onShiftSelect:
        opts.onShiftSelect !== undefined
          ? (item) => {
              const v = item.value;
              if (inline) {
                opts.container!.clear();
                opts.onRestore?.();
              } else {
                handle?.hide();
              }
              tui.requestRender();
              resolve(null); // shift 路径自带结算，主 promise 置 null 防重复应用
              opts.onShiftSelect!(v);
            }
          : undefined,
      tabs: opts.tabs,
      itemsForTab: opts.itemsForTab,
      initialTab: opts.initialTab,
    });
    if (inline) {
      opts.container!.clear();
      opts.container!.addChild(overlay);
      tui.setFocus(overlay);
    } else {
      handle = tui.showOverlay(overlay, { width: '80%', maxHeight: '70%', anchor: 'bottom-center' });
      handle.focus();
    }
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


/**
 * 单行输入。hint 在输入框上方说明填什么，keyHint 在下方说明按什么键。
 *
 * 键位提示放输入框下方而不是拼进 hint：位置与主界面输入框的 footer 提示一致。
 * 用户找键位提示时看的是同一个地方。
 */
/**
 * 带校验的单行输入：非法值当场报错重问，不推进流程。
 *
 * 校验失败只置行内错误、不清输入现场（把上次输入回填成 initial 还原），
 * 否则用户填错一个字符要整条重打。
 *
 * 没有这层时，新增渠道向导的行为是：非法值静默接受（base_url 少了 http:// 也照写盘），
 * 或者按 Esc 取消掉整个七步流程（填到最后一步才发现填错，前六步全白填）。
 *
 * @param validate 返回错误文案表示不通过，返回 null 表示放行。收到的是 trim 后的值。
 */
export async function askValidated(
  tui: TUI,
  hint: string,
  validate: (value: string) => string | null,
  opts: { initial?: string; keyHint?: string } = {},
): Promise<string | null> {
  let initial = opts.initial;
  let error: string | undefined;
  for (;;) {
    // 错误占的是键位提示那一行：位置与主界面输入框的 footer 提示一致
    const footer = error !== undefined ? c.error(error) : (opts.keyHint ?? t('providerWizard.hint.text'));
    const raw = await askLine(tui, hint, initial, footer);
    if (raw === null) return null;
    const value = raw.trim();
    const msg = validate(value);
    if (msg === null) return value;
    error = msg;
    initial = raw;
  }
}

export function askLine(tui: TUI, hint: string, initial?: string, keyHint?: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const host = new Container();
    let settled = false;
    // 记住调用前的焦点目标，finish 时恢复——否则 askLine 结束后焦点悬空，
    // 输入进不去、ctrl+c 也不到 ChatEditor 处理（2026-08-18 /rename 卡死）。
    const prevFocus = (tui as TUI & { getFocusedComponent?: () => Component | null }).getFocusedComponent?.() ?? null;
    const finish = (v: string | null): void => {
      if (settled) return;
      settled = true;
      tui.removeChild(host);
      // 恢复调用前的焦点；拿不到就不动，让 tui 自己处理
      if (prevFocus !== null) tui.setFocus(prevFocus);
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
    if (keyHint !== undefined) {
      const keyLine = new Banner();
      keyLine.setLines([c.dim(keyHint)]);
      host.addChild(keyLine);
    }
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
