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
import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { PermissionMode } from '../agent/permission/mode.js';
import { c } from './theme.js';

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
  queueLen: number;
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
    if (s.backgroundCount > 0) badges.push(c.toolName(`bg:${s.backgroundCount}`));
    if (s.queueLen > 0) badges.push(c.accent(`queue:${s.queueLen}`));
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

export class ActivityLine implements Component {
  private busy = false;
  private startedAt = 0;
  private outputChars = 0;
  private thinkingActive = false;
  private thinkingPreview = '';
  private frame = 0;
  private tip = '';

  invalidate(): void {
    // 无缓存
  }

  setBusy(busy: boolean, startedAt = Date.now()): void {
    this.busy = busy;
    this.startedAt = startedAt;
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
    if (preview !== '') this.thinkingPreview = preview;
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
    const state = this.thinkingActive ? '思考中' : this.tip !== '' ? this.tip : '运行中';
    const head = `${spin} ${c.dim(`${state} · ${elapsed}${tok} · Esc 中断`)}`;
    const out = [truncateToWidth(head, width)];
    if (this.thinkingActive && this.thinkingPreview !== '') {
      // 思考流式预览：取尾部单行（整段思考在完成后落成定稿块）
      const flat = this.thinkingPreview.replace(/\s+/g, ' ').trimEnd();
      const tail = flat.slice(-Math.max(0, width - 4));
      out.push(c.thinking(`  ${truncateToWidth(tail, width - 2)}`));
    }
    return out;
  }
}
