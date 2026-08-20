/**
 * 组件级渲染缓存。pi-tui 主编排层有行级差分，但组件内部不做缓存；对每帧都被调 render()
 * 的组件，内容没变也在重算，长会话下是卡顿和 OOM 的同源压力。
 * `shouldRender(width)` 为 false 时直接返回 `cached()`，内容变化时 `invalidate()`。
 */
export class RenderCache {
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  private valid = false;

  /** 内容是否需要重新计算。width 变了或缓存已失效 → true。 */
  shouldRender(width: number): boolean {
    return !this.valid || this.cachedWidth !== width;
  }

  /** 存入本次渲染结果。 */
  commit(width: number, lines: string[]): void {
    this.cachedWidth = width;
    this.cachedLines = lines;
    this.valid = true;
  }

  /** 返回缓存的渲染结果。 */
  cached(): string[] {
    return this.cachedLines;
  }

  /** 标记缓存失效（内容变化时调用）。 */
  invalidate(): void {
    this.valid = false;
  }
}

/**
 * 状态行与活动行。
 *
 * StatusLine 两行式布局（徽章 + 路径 / 提示 + context 用量），行宽自己算，
 * 路径先被截断、context 永不截断。
 * ActivityLine：busy 时显示 spinner + 已用时 + 估算产出，以及流式思考的单行预览。
 */
import { homedir } from 'node:os';
import { Text, type Component, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { PermissionMode } from '../agent/permission/mode.js';
import type { GoalStatus } from '../agent/goal/mode.js';
import { c } from './theme.js';
import { pickRandomTip, pickWorkingVerb } from '../chat/workingTips.js';
import { t } from '../i18n.js';

/** 路径缩短：home → ~，段数 > 3 只留尾部 3 段。 */
export function shortenPath(p: string, max = 48): string {
  let display = p;
  const home = homedir();
  if (home !== '') {
    const lower = p.toLowerCase();
    const homeLower = home.toLowerCase();
    if (lower === homeLower || lower.startsWith(`${homeLower}\\`) || lower.startsWith(`${homeLower}/`)) {
      display = `~${p.slice(home.length)}`;
    }
  }
  const parts = display.split(/[\\/]+/).filter((seg) => seg.length > 0);
  if (parts.length > 3) display = `…/${parts.slice(-3).join('/')}`;
  if (display.length > max) display = `…${display.slice(display.length - max + 1)}`;
  return display;
}

/** goal 状态圆点着色。 */
function goalDot(status: GoalStatus): string {
  return status === 'active' ? c.ok('●') : status === 'blocked' ? c.warn('●') : c.dim('●');
}

/** 紧凑计数：4 位以上转 k。 */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
}

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export interface StatusState {
  mode: PermissionMode;
  planMode: boolean;
  model: string;
  thinking?: string;
  busy: boolean;
  cwd: string;
  usedTokens: number;
  maxContextSize: number;
  hints: string;
  backgroundCount: number;
  /** 最近一个 running 后台任务的命令名（在 bg:N 后灰色显示，截断到 20 列）。 */
  latestBgTask?: string;
  queueLen: number;
  /**
   * goal 徽标数据：任何非终态 goal 都显示（不只 active）——用户看不到徽标就不知道
   * 目标还在，blocked 与 paused 同样需要被看见。elapsedMs 由调用方按当前时刻算好。
   */
  goal?: { status: GoalStatus; turnsUsed: number; turnBudget?: number; elapsedMs: number };
  /** team 团队模式是否激活（激活时显示 team 徽标）。 */
  teamActive?: boolean;
}

export class StatusLine implements Component {
  private state: StatusState;
  private readonly cache = new RenderCache();

  constructor(state: StatusState) {
    this.state = state;
  }

  setState(next: Partial<StatusState>): void {
    this.state = { ...this.state, ...next };
    this.cache.invalidate();
  }

  getState(): StatusState {
    return this.state;
  }

  invalidate(): void {
    this.cache.invalidate();
  }

  render(width: number): string[] {
    if (!this.cache.shouldRender(width)) return this.cache.cached();

    const s = this.state;
    const badges: string[] = [];
    badges.push(s.planMode ? c.accent('plan') : c.mode(s.mode)(s.mode));
    badges.push(c.toolName(s.model));
    if (s.thinking !== undefined) badges.push(c.dim(`think:${s.thinking}`));
    badges.push(s.busy ? c.warn('busy') : c.dim('ready'));
    if (s.backgroundCount > 0) {
      const name = s.latestBgTask !== undefined && s.latestBgTask !== '' ? ` ${truncateToWidth(s.latestBgTask, 20)}` : '';
      badges.push(c.toolName(`bg:${s.backgroundCount}`) + c.dim(name));
    }
    if (s.queueLen > 0) badges.push(c.accent(`queue:${s.queueLen}`));
    // goal 与 team 是「当前处于某种自主/协作状态」的提示，必须常驻可见：看不到徽标就不知道下一轮会自动续跑
    if (s.goal !== undefined) {
      const g = s.goal;
      const turns = g.turnBudget !== undefined ? `${g.turnsUsed}/${g.turnBudget}` : `${g.turnsUsed}`;
      badges.push(`${c.dim('goal ')}${goalDot(g.status)}${c.dim(` ${formatElapsed(g.elapsedMs)} · ${turns}`)}`);
    }
    if (s.teamActive === true) badges.push(c.accent('team'));
    const left = badges.join(c.dim('  '));
    // 路径是唯一可被压缩的部分：先算徽章占宽，剩下的给路径
    const room = width - visibleWidth(left) - 2;
    const path = room > 8 ? c.dim(`  ${truncateToWidth(shortenPath(s.cwd), room)}`) : '';
    const line1 = left + path;

    const pct = s.maxContextSize > 0 ? Math.min(100, Math.round((s.usedTokens / s.maxContextSize) * 100)) : 0;
    const ctx = c.dim(`context: ${pct}% (${formatCount(s.usedTokens)}/${formatCount(s.maxContextSize)})`);
    const ctxWidth = visibleWidth(ctx);
    const hintRoom = width - ctxWidth - 1;
    const hints = hintRoom > 4 ? c.dim(truncateToWidth(s.hints, hintRoom)) : '';
    const gap = Math.max(1, width - visibleWidth(hints) - ctxWidth);
    const line2 = hints + ' '.repeat(gap) + ctx;
    const lines = [line1, line2];
    // 出口总钳：上方逐段 truncateToWidth 已覆盖常规路径，但 line1 把多段带样式串拼起来后，
    // 边缘情况下叠加可见宽仍可能越界 width。这里在写入缓存前截断，保证拿缓存时拿到的就是
    // 已截断行——若放在取缓存之后再 map，每次返回新引用会破坏 renderCache 的「同引用=命中」契约。
    const clamped = lines.map((l) => truncateToWidth(l, width));
    this.cache.commit(width, clamped);
    return clamped;
  }
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** thinking 预览最多显示的行数（尾部 N 行）。 */
const PREVIEW_LINES = 3;

export class ActivityLine implements Component {
  private busy = false;
  private startedAt = 0;
  private outputChars = 0;
  private thinkingActive = false;
  private thinkingPreview = '';
  private frame = 0;
  private tip = '';
  /** 进度心跳：token 增长 / 思考预览更新 / 工具活动都刷新。超 STALL_MS 无进展 → 停滞态变红。 */
  private lastProgressAt = 0;
  /** 停滞阈值：3 秒无新 token 且无工具活动（参照成熟实现的同一判据）。 */
  static readonly STALL_MS = 3_000;
  /** 本轮的状态动词与操作提示：busy 上升沿各取一次、整轮固定（不随帧刷新而跳字）。 */
  private verb = '';
  private hint = '';
  /** thinking 预览用 pi-tui Text 渲染，它内部按行折行、不拖父串，避免 OOM。 */
  private readonly textComponent = new Text('', 0, 0);
  /**
   * thinking 预览的样式化结果缓存。render 在 tick 驱动下每 80ms 重算一次（让 spinner 转），
   * 但 thinking 预览文本没变时不能跟着重算——那会让预览行在 spinner 转动时发生视觉跳动。
   * 故只把 preview 变化时重算的 tail 存这里，render 里 preview 文本未变则直接复用。
   */
  private cachedTail: string[] = [];
  private cachedTailText = '';
  /**
   * 全量输出缓存。render 输出随 spinner 帧 / token / elapsed 变化，若逐帧刷新会在用户上滚时
   * 触发视口跳顶，故只在内容实质变化（setThinking / setBusy / setTip）时失效。
   */
  private readonly cache = new RenderCache();

  invalidate(): void {
    this.cache.invalidate();
  }

  setBusy(busy: boolean, startedAt = Date.now()): void {
    const rising = busy && !this.busy;
    this.busy = busy;
    this.startedAt = startedAt;
    if (rising) {
      // 整轮固定：随机只在进入 busy 时发生，render 每 100ms 调用一次，不能在里面取随机
      this.verb = pickWorkingVerb();
      this.hint = pickRandomTip(this.hint);
      this.lastProgressAt = startedAt;
    }
    if (!busy) {
      this.thinkingActive = false;
      this.thinkingPreview = '';
      this.outputChars = 0;
    }
    this.cache.invalidate();
  }

  setTip(tip: string): void {
    this.tip = tip;
    this.cache.invalidate();
  }

  addOutputChars(n: number): void {
    this.outputChars += n;
    if (n > 0) this.lastProgressAt = Date.now();
    // 不失效缓存：token 计数是装饰性更新，不触发视觉变化
  }

  /** 工具活动心跳（tool_start/tool_end 时调用）：停滞判定把工具执行算作进展。 */
  noteToolActivity(): void {
    this.lastProgressAt = Date.now();
  }

  setThinking(active: boolean, preview = ''): void {
    this.thinkingActive = active;
    if (preview !== '') {
      this.thinkingPreview = preview;
      this.textComponent.setText(preview);
      this.lastProgressAt = Date.now();
      // preview 变了，缓存失效——render 下次会重算 thinking tail 并更新缓存。
      this.cachedTailText = '';
    }
    this.cache.invalidate();
  }

  /**
   * 由 PiChat 的 spinner 定时器（80ms）驱动：只在 busy 时推进帧号并失效缓存。
   * 失效缓存是必须的——render 短路会返回旧输出，若不失效，spinner 字符永远是推进前的那个，
   * 实测 tick 五次输出全同一个字符（spinner 根本不转）。thinking 预览的抖动由 render 内部
   * 复用缓存解决（见 render），不靠这里不失效缓存来冻结。
   */
  tick(): void {
    if (!this.busy) return;
    this.frame = (this.frame + 1) % SPINNER.length;
    this.cache.invalidate();
  }

  render(width: number): string[] {
    if (!this.busy) return [];
    if (!this.cache.shouldRender(width)) return this.cache.cached();

    const spin = c.warn(SPINNER[this.frame]!);
    const elapsed = formatElapsed(Date.now() - this.startedAt);
    const tok = this.outputChars > 0 ? ` · ↓ ${formatCount(Math.round(this.outputChars / 4))} tok` : '';
    const state = this.thinkingActive ? '思考中' : this.tip !== '' ? this.tip : this.verb !== '' ? this.verb : '运行中';
    // 停滞检测：STALL_MS 无进展（无新 token、无思考更新、无工具活动）→ 状态词变红并标注
    // 停滞时长，把「还在等」与「疑似卡住」区分开（参照成熟实现的 stalled 语义，2s 渐变
    // 在我们这里简化为阈值切换——差分渲染下渐变要每帧重绘，不值得）。
    const stalledFor = Date.now() - this.lastProgressAt;
    const stalled = stalledFor > ActivityLine.STALL_MS;
    const stateText = stalled
      ? c.error(`${state}（${formatElapsed(stalledFor)} 无新输出）`)
      : c.dim(state);
    const head = `${spin} ${stateText}${c.dim(` ${elapsed}${tok} Esc 中断`)}`;
    const out = [truncateToWidth(head, width)];
    if (this.thinkingActive && this.thinkingPreview !== '') {
      // 思考流式预览：尾部 N 行。预览行只加 indent 不加 spin（spinner 已在 head 行）。
      const indent = '  ';
      const contentW = Math.max(8, width - indent.length);
      // preview 文本没变时复用上次样式化结果：render 在 spinner tick 下每 80ms 重算一次，
      // 若不复用，预览行会随 spinner 转动而每帧重渲染，产生视觉跳动。
      // preview 变了（setThinking 传新文本）才重算并更新缓存。
      let styled: string[];
      if (this.thinkingPreview === this.cachedTailText) {
        styled = this.cachedTail;
      } else {
        const tail = this.textComponent.render(contentW).slice(-PREVIEW_LINES);
        // 逐行钳到 width：wrapTextWithAnsi 对无空格串（长 URL / base64）不折行，
        // 任一行超宽会让 pi-tui doRender 直接 throw。这里在着色前钳，作组件层安全阀。
        styled = tail.map((line) => c.thinking(truncateToWidth(indent + line, width)));
        this.cachedTail = styled;
        this.cachedTailText = this.thinkingPreview;
      }
      out.push(...styled);
    } else if (this.hint !== '') {
      // 思考预览与操作提示互斥占第二行：预览是本轮实时信息，优先级高于常驻提示
      out.push(c.dim(truncateToWidth(t('input.tipPrefix', { tip: this.hint }), width)));
    }
    this.cache.commit(width, out);
    return out;
  }
}
