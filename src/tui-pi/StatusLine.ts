/**
 * 状态行与活动行。
 *
 * StatusLine 对应 Ink 版 StatusBar 的两行式布局（第一行徽章 + 路径，第二行提示 + context
 * 用量），但实现从 flexbox 收缩改成显式截断——pi-tui 没有布局引擎，行宽由自己算，这反倒
 * 让「路径先被截断、context 永不截断」这条规则变成一行代码，不必再靠 flexShrink 试出来。
 *
 * ActivityLine 对应 WorkingStatus：busy 时显示 spinner + 已用时 + 本轮估算产出，
 * 以及流式思考的单行预览。
 */
import { homedir } from 'node:os';
import { Text, type Component, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { PermissionMode } from '../agent/permission/mode.js';
import type { GoalStatus } from '../agent/goal/mode.js';
import { c } from './theme.js';
import { pickRandomTip, pickWorkingVerb } from '../chat/workingTips.js';
import { t } from '../i18n.js';

/** 路径缩短：逻辑同 Ink 版 StatusBar.shortenPath（home → ~，段数 > 3 只留尾部 3 段）。 */
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

/** goal 状态圆点着色（与 Ink 版 goalStatusColor 同口径）。 */
function goalDot(status: GoalStatus): string {
  return status === 'active' ? c.ok('●') : status === 'blocked' ? c.warn('●') : c.dim('●');
}

/** 紧凑计数：4 位以上转 k（与 Ink 版 duration.formatCount 同口径）。 */
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

  constructor(state: StatusState) {
    this.state = state;
  }

  setState(next: Partial<StatusState>): void {
    this.state = { ...this.state, ...next };
  }

  getState(): StatusState {
    return this.state;
  }

  invalidate(): void {
    // 无缓存：状态行每帧都可能变（busy/token），重排成本是两行字符串拼接
  }

  render(width: number): string[] {
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
    // goal 与 team 是「当前处于某种自主/协作状态」的提示，必须常驻可见：
    // 用户看不到 goal 徽标就不知道下一轮会自动续跑。
    // 形态与 Ink 版一致：goal ● 用时 · 轮次[/预算]，● 按状态着色（绿 active / 黄 blocked / 灰 paused）。
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
    return [line1, line2];
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
  /** 本轮的状态动词与操作提示：busy 上升沿各取一次、整轮固定（不随帧刷新而跳字）。 */
  private verb = '';
  private hint = '';
  /**
   * thinking 预览的文本渲染组件（pi-tui Text）。
   * Text 内部 wrapTextWithAnsi → 每行独立扁平串，进 widthCache 安全。
   * 旧的 slice(replace(全文)) 方式产出的 SlicedString 会拖住父串导致 OOM。
   */
  private readonly textComponent = new Text('', 0, 0);

  invalidate(): void {
    // 无缓存
  }

  setBusy(busy: boolean, startedAt = Date.now()): void {
    const rising = busy && !this.busy;
    this.busy = busy;
    this.startedAt = startedAt;
    if (rising) {
      // 整轮固定：随机只在进入 busy 时发生，render 每 100ms 调用一次，不能在里面取随机
      this.verb = pickWorkingVerb();
      this.hint = pickRandomTip(this.hint);
    }
    if (!busy) {
      this.thinkingActive = false;
      this.thinkingPreview = '';
      this.outputChars = 0;
    }
  }

  setTip(tip: string): void {
    this.tip = tip;
  }

  addOutputChars(n: number): void {
    this.outputChars += n;
  }

  setThinking(active: boolean, preview = ''): void {
    this.thinkingActive = active;
    if (preview !== '') {
      this.thinkingPreview = preview;
      this.textComponent.setText(preview);
    }
  }

  /** 由 PiChat 的 100ms 定时器驱动：只在 busy 时推进帧号。 */
  tick(): void {
    if (this.busy) this.frame = (this.frame + 1) % SPINNER.length;
  }

  render(width: number): string[] {
    if (!this.busy) return [];
    const spin = c.warn(SPINNER[this.frame]!);
    const elapsed = formatElapsed(Date.now() - this.startedAt);
    const tok = this.outputChars > 0 ? ` · ↓ ${formatCount(Math.round(this.outputChars / 4))} tok` : '';
    const state = this.thinkingActive ? '思考中' : this.tip !== '' ? this.tip : this.verb !== '' ? this.verb : '运行中';
    const head = `${spin} ${c.dim(`${state} · ${elapsed}${tok} · Esc 中断`)}`;
    const out = [truncateToWidth(head, width)];
    if (this.thinkingActive && this.thinkingPreview !== '') {
      // 思考流式预览：用 pi-tui Text 组件渲染尾部 N 行。
      //
      // Text 内部走 wrapTextWithAnsi → 每行 ≤ width 的独立扁平串，进 widthCache 的
      // 字符串永远短且不拖父串。对比旧的 slice(replace(全文)) 方式——SlicedString
      // 拖着整份多 MB 父串进 widthCache，是 2026-08-17 第二次 OOM 的根因。
      const indent = '  ';
      const contentW = Math.max(8, width - indent.length);
      const contentLines = this.textComponent.render(contentW);
      const tail = contentLines.slice(-PREVIEW_LINES);
      // 预览行只加 indent，不加 spin——spinner 已在 head 行显示，重复会出现两个圆圈。
      //
      // 逐行 truncateToWidth 是必需的防御：pi-tui Text 的 wrapTextWithAnsi 只按空格折行，
      // 长 URL / base64 / 无空格代码串不会被断开，单行可能远超终端宽度。pi-tui doRender
      // 检测到任一行 visibleWidth > width 就直接 throw（2026-08-17 两次因此崩溃：
      // 一次 line 19 w=89>87，一次 line 399 w=992>67）。这里在着色前钳到 width，是组件层
      // 的安全阀——不依赖上游 Text 是否真的把每个 token 折到位。
      const styled = tail.map((line) => c.thinking(truncateToWidth(indent + line, width)));
      out.push(...styled);
    } else if (this.hint !== '') {
      // 思考预览与操作提示互斥占第二行：预览是本轮实时信息，优先级高于常驻提示
      out.push(c.dim(truncateToWidth(t('input.tipPrefix', { tip: this.hint }), width)));
    }
    return out;
  }
}
