/**
 * ④ `/agents` 分组面板：当前会话派生的子 agent 总览。
 *
 * 多子 agent 并跑时，进度嵌在各自的 spawn_agent 卡片里，缺少"总览"。本面板列出
 * 当前会话所有子 agent（运行中 + 已完成），实时更新。选中后进入只读浏览（复用 ③ 的
 * browseSubagentSession 路径）。
 *
 * 与 TasksOverlay 同款挂载路径：tui.showOverlay + 1 秒 tick 驱动重渲。
 * 数据每帧从 getAgents() 现取（SubagentStore.list），运行中子 agent 的进度靠 runner
 * 每轮 saveSnapshot 刷新，延迟 ≤ 1 轮。
 */
import { matchesKey, truncateToWidth, type Component } from '@earendil-works/pi-tui';
import type { SessionMeta } from '../session/store.js';
import { c } from './theme.js';

/** 排序：运行中在前，其余按 updatedAt 倒序。 */
export function sortAgents(agents: readonly SessionMeta[]): SessionMeta[] {
  const order: Record<string, number> = { running: 0, done: 1, error: 2, aborted: 3 };
  return [...agents].sort((a, b) => {
    const d = (order[a.status ?? ''] ?? 9) - (order[b.status ?? ''] ?? 9);
    if (d !== 0) return d;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}

/** 单行子 agent 摘要：状态 · 类型 · 名称 · 消息数 · id。全部截断到 width。 */
export function agentRow(agent: SessionMeta, selected: boolean, width: number): string {
  const mark =
    agent.status === 'running'
      ? c.warn('●')
      : agent.status === 'done'
        ? c.ok('✓')
        : agent.status === 'error'
          ? c.error('✗')
          : c.dim('·');
  const sel = selected ? c.toolName('›') : ' ';
  const type = c.accent(agent.agentType ?? 'general');
  const label = agent.name ?? agent.title ?? agent.id.slice(0, 8);
  const msgs = c.dim(`${agent.messageCount} 条`);
  const head = `${sel} ${mark} ${type} ${label}  ${msgs}`;
  return truncateToWidth(head, width);
}

export class AgentsOverlay implements Component {
  private sel = 0;
  private readonly getAgents: () => readonly SessionMeta[];
  private readonly onBrowse: (id: string) => void;
  private readonly requestRender: () => void;
  private readonly close: () => void;

  constructor(opts: {
    getAgents: () => readonly SessionMeta[];
    onBrowse: (id: string) => void;
    requestRender: () => void;
    onClose: () => void;
  }) {
    this.getAgents = opts.getAgents;
    this.onBrowse = opts.onBrowse;
    this.requestRender = opts.requestRender;
    this.close = opts.onClose;
  }

  private visible(): SessionMeta[] {
    return sortAgents(this.getAgents());
  }

  handleInput(data: string): void {
    const list = this.visible();
    if (matchesKey(data, 'escape') || data === 'q') {
      this.close();
      return;
    }
    if (matchesKey(data, 'up') || data === 'k') {
      this.sel = Math.max(0, this.sel - 1);
    } else if (matchesKey(data, 'down') || data === 'j') {
      this.sel = Math.min(Math.max(0, list.length - 1), this.sel + 1);
    } else if (matchesKey(data, 'return')) {
      const agent = list[this.sel];
      if (agent !== undefined) {
        this.onBrowse(agent.id);
        return; // onBrowse 会关掉弹层（进入浏览态），这里不重渲
      }
    }
    this.requestRender();
  }

  /** 选中子 agent 的详情栏。 */
  private renderDetail(agent: SessionMeta, width: number): string[] {
    const rows: Array<{ label: string; value: string; color?: (s: string) => string }> = [
      { label: 'id', value: agent.id },
      { label: '类型', value: agent.agentType ?? 'general' },
      { label: '状态', value: agent.status ?? '未知', color: (s) => this.statusColor(agent.status ?? '', s) },
      { label: '消息', value: String(agent.messageCount) },
    ];
    if (agent.name !== undefined || agent.title !== undefined) {
      rows.push({ label: '任务', value: agent.name ?? agent.title ?? '' });
    }
    if (agent.preview !== undefined && agent.preview !== '') {
      rows.push({ label: '首条', value: agent.preview });
    }
    const out: string[] = [];
    for (const r of rows) {
      const prefix = c.dim(`${r.label}: `);
      const value = r.color !== undefined ? r.color(r.value) : r.value;
      out.push(truncateToWidth(`  ${prefix}${value}`, width));
    }
    return out;
  }

  private statusColor(status: string, value: string): string {
    switch (status) {
      case 'running': return c.warn(value);
      case 'done': return c.ok(value);
      case 'error': return c.error(value);
      default: return c.dim(value);
    }
  }

  render(width: number): string[] {
    const list = this.visible();
    const out: string[] = [
      c.accent(truncateToWidth(`子 agent 总览（${list.length} 个）`, width)),
    ];
    if (list.length === 0) {
      out.push(c.dim(truncateToWidth('本会话还没有派生过子 agent', width)));
    } else {
      const sel = Math.min(this.sel, list.length - 1);
      for (const [i, agent] of list.entries()) {
        out.push(agentRow(agent, i === sel, width));
      }
      const agent = list[sel];
      if (agent !== undefined) {
        out.push('');
        out.push(...this.renderDetail(agent, width));
      }
    }
    out.push(c.dim(truncateToWidth('↑↓/jk 选择 · Enter 浏览 · Esc 关闭', width)));
    return out;
  }

  invalidate(): void {
    // 数据每帧从 getAgents() 现取，无缓存
  }
}
