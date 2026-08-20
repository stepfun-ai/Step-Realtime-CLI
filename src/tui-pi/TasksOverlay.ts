/**
 * `/tasks` 交互弹层：任务列表 + 输出预览 + 停止确认。
 *
 * 任务查看器：上列表 + 下输出预览的单栏形态。
 * 终端宽度常态 80-120 列，三栏切下来每栏放不下一条命令行，纵向分区信息密度更高。
 *
 * 保留的交互：↑↓/jk 选任务、Tab 循环过滤（全部→运行中→已完成→失败）、s 停止（y/n 二次
 * 确认，防误杀）、o 全屏看输出、r 刷新、Esc/q 关闭。1 秒 tick 由调用方驱动（复用 PiChat
 * 的 ticker），运行中任务的用时与输出跟着走。
 */
import { matchesKey, truncateToWidth, type Component } from '@earendil-works/pi-tui';
import type { BackgroundTask } from '../agent/background/manager.js';
import { formatDuration } from '../chat/duration.js';
import { c } from './theme.js';
import { t } from '../i18n.js';

/** 过滤档位：Tab 循环。 */
export type TaskFilter = 'all' | 'running' | 'done' | 'failed';
const FILTER_ORDER: TaskFilter[] = ['all', 'running', 'done', 'failed'];

/** 输出预览区行数（弹层里固定，全文看走 o 打开查看器）。 */
const PREVIEW_ROWS = 8;

function getFilterLabel(filter: TaskFilter): string {
  switch (filter) {
    case 'all':
      return t('tasksOverlay.filterAll');
    case 'running':
      return t('tasksOverlay.filterRunning');
    case 'done':
      return t('tasksOverlay.filterDone');
    case 'failed':
      return t('tasksOverlay.filterFailed');
  }
}

export function filterTasks(tasks: readonly BackgroundTask[], filter: TaskFilter): BackgroundTask[] {
  if (filter === 'all') return [...tasks];
  if (filter === 'running') return tasks.filter((t) => t.status === 'running');
  if (filter === 'failed') return tasks.filter((t) => t.status === 'failed');
  return tasks.filter((t) => t.status === 'completed' || t.status === 'killed');
}

/** 排序：运行中在前，其余按启动时间倒序（与 formatTaskList 同口径）。 */
export function sortTasks(tasks: readonly BackgroundTask[]): BackgroundTask[] {
  const order: Record<string, number> = { running: 0, failed: 1, completed: 2, killed: 3 };
  return [...tasks].sort((a, b) => {
    const d = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    if (d !== 0) return d;
    return Date.parse(b.startedAt) - Date.parse(a.startedAt);
  });
}

/** 单行任务摘要：状态 · id · 用时 · exit code · 命令。 */
export function taskRow(task: BackgroundTask, now: number, selected: boolean, width: number): string {
  const started = Date.parse(task.startedAt);
  const end = task.endedAt !== undefined ? Date.parse(task.endedAt) : now;
  const dur = Number.isNaN(started) ? '' : formatDuration(Math.max(0, end - started));
  const code = task.status === 'failed' && task.exitCode !== undefined ? ` exit ${task.exitCode}` : '';
  const mark =
    task.status === 'running' ? c.warn('●') : task.status === 'failed' ? c.error('✗') : task.status === 'killed' ? c.dim('⊘') : c.ok('✓');
  const head = `${selected ? c.toolName('›') : ' '} ${mark} ${task.id} ${c.dim(`${dur}${code}`)}  `;
  const cmd = selected ? task.command : c.dim(task.command);
  return truncateToWidth(head + cmd, width);
}

export class TasksOverlay implements Component {
  private filter: TaskFilter = 'all';
  private sel = 0;
  /** 停止确认态：待确认的任务 id（非空时 y 执行、n/Esc 取消）。 */
  private confirmStop: string | null = null;
  private readonly getTasks: () => readonly BackgroundTask[];
  private readonly stopTask: (id: string) => boolean;
  private readonly openOutput: (task: BackgroundTask) => void;
  private readonly requestRender: () => void;
  private readonly close: () => void;
  private readonly now: () => number;

  constructor(opts: {
    getTasks: () => readonly BackgroundTask[];
    stopTask: (id: string) => boolean;
    openOutput: (task: BackgroundTask) => void;
    requestRender: () => void;
    onClose: () => void;
    now?: () => number;
  }) {
    this.getTasks = opts.getTasks;
    this.stopTask = opts.stopTask;
    this.openOutput = opts.openOutput;
    this.requestRender = opts.requestRender;
    this.close = opts.onClose;
    this.now = opts.now ?? ((): number => Date.now());
  }

  private visible(): BackgroundTask[] {
    return sortTasks(filterTasks(this.getTasks(), this.filter));
  }

  private selected(): BackgroundTask | undefined {
    const list = this.visible();
    return list[Math.min(this.sel, Math.max(0, list.length - 1))];
  }

  handleInput(data: string): void {
    // 停止确认优先吃键：确认态下其它键位一律不生效，防手滑连按误杀
    if (this.confirmStop !== null) {
      if (data === 'y' || data === 'Y') {
        this.stopTask(this.confirmStop);
        this.confirmStop = null;
      } else if (data === 'n' || data === 'N' || matchesKey(data, 'escape')) {
        this.confirmStop = null;
      }
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'escape') || data === 'q') {
      this.close();
      return;
    }
    if (matchesKey(data, 'tab')) {
      this.filter = FILTER_ORDER[(FILTER_ORDER.indexOf(this.filter) + 1) % FILTER_ORDER.length]!;
      this.sel = 0;
    } else if (matchesKey(data, 'up') || data === 'k') {
      this.sel = Math.max(0, this.sel - 1);
    } else if (matchesKey(data, 'down') || data === 'j') {
      this.sel = Math.min(Math.max(0, this.visible().length - 1), this.sel + 1);
    } else if (data === 's') {
      const task = this.selected();
      // 只有运行中的任务能停：对已终态任务提示比静默无反应好
      if (task !== undefined && task.status === 'running') this.confirmStop = task.id;
    } else if (data === 'o' || matchesKey(data, 'return')) {
      const task = this.selected();
      if (task !== undefined) this.openOutput(task);
    }
    this.requestRender();
  }

  /**
   * 选中任务的详情栏。
   * 固定行序，无值的字段整行省略；内容缩进 2 列，截断到 width。
   */
  private renderDetail(task: BackgroundTask, width: number): string[] {
    const rows: Array<{ label: string; value: string; color?: (s: string) => string }> = [
      { label: t('tasksOverlay.detail.id'), value: task.id },
      { label: t('tasksOverlay.detail.status'), value: t(`background.status.${task.status}`), color: (s) => this.statusColor(task.status, s) },
    ];
    if (task.kind !== undefined) rows.push({ label: t('tasksOverlay.detail.kind'), value: t(`tasksOverlay.kind.${task.kind}`) });
    if (task.agentType !== undefined) rows.push({ label: t('tasksOverlay.detail.agentType'), value: task.agentType });
    rows.push({ label: t('tasksOverlay.detail.command'), value: task.command });
    // 时间：运行中 = 已运行时长；终态 = 结束于多久前
    const start = Date.parse(task.startedAt);
    if (!Number.isNaN(start)) {
      if (task.status === 'running') {
        const dur = formatDuration(Math.max(0, this.now() - start));
        rows.push({ label: t('tasksOverlay.detail.time'), value: t('tasksOverlay.timeRunning', { dur }) });
      } else if (task.endedAt !== undefined) {
        const end = Date.parse(task.endedAt);
        if (!Number.isNaN(end)) {
          const rel = formatDuration(Math.max(0, end - start));
          rows.push({ label: t('tasksOverlay.detail.time'), value: t('tasksOverlay.timeFinished', { dur: rel }) });
        }
      }
    }
    if (task.exitCode !== undefined) rows.push({ label: t('tasksOverlay.detail.exitCode'), value: String(task.exitCode) });
    // 时长（运行中与终态统一口径）
    const started = Date.parse(task.startedAt);
    const ended = task.endedAt !== undefined ? Date.parse(task.endedAt) : this.now();
    if (!Number.isNaN(started)) rows.push({ label: t('tasksOverlay.detail.duration'), value: formatDuration(Math.max(0, ended - started)) });

    const out: string[] = [];
    for (const r of rows) {
      const prefix = c.dim(`${r.label}: `);
      const value = r.color !== undefined ? r.color(r.value) : r.value;
      out.push(truncateToWidth(`  ${prefix}${value}`, width));
    }
    return out;
  }

  /** 状态颜色映射（与 taskRow 的 STATUS_STYLE 同口径）。 */
  private statusColor(status: string, value: string): string {
    switch (status) {
      case 'running': return c.warn(value);
      case 'completed': return c.ok(value);
      case 'failed': return c.error(value);
      case 'killed': return c.dim(value);
      default: return value;
    }
  }

  render(width: number): string[] {
    const list = this.visible();
    const total = this.getTasks().length;
    const out: string[] = [
      c.accent(t('tasksOverlay.title', { filter: getFilterLabel(this.filter), shown: list.length, total })),
    ];
    if (list.length === 0) {
      out.push(c.dim(this.filter === 'all' ? t('tasksOverlay.emptyAll') : t('tasksOverlay.emptyFiltered', { filter: getFilterLabel(this.filter) })));
    } else {
      const now = this.now();
      const sel = Math.min(this.sel, list.length - 1);
      for (const [i, task] of list.entries()) {
        out.push(taskRow(task, now, i === sel, width));
      }
    }
    const task = this.selected();
    if (task !== undefined) {
      // 详情栏：选中任务的元信息。
      // 放在列表与输出预览之间，用圆角框视觉区分。
      out.push('');
      out.push(...this.renderDetail(task, width));
      out.push('');
      out.push(c.dim(truncateToWidth(t('tasksOverlay.outputTitle', { id: task.id }), width)));
      const lines = task.output === '' ? [t('tasksOverlay.noOutput')] : task.output.split('\n');
      for (const l of lines.slice(-PREVIEW_ROWS)) out.push(c.dim(truncateToWidth(`  ${l}`, width)));
    }
    if (this.confirmStop !== null) {
      out.push(c.warn(truncateToWidth(t('tasksOverlay.confirmStop', { id: this.confirmStop }), width)));
    } else {
      // footer 是固定键位文案（约 64 列），窄终端/分屏下会超宽崩溃，必须截断
      out.push(c.dim(truncateToWidth(t('tasksOverlay.footer'), width)));
    }
    return out;
  }

  invalidate(): void {
    // 内容每帧从 getTasks() 现取（运行中任务的用时与输出在变），无缓存
  }
}
