/**
 * pi-tui 侧命令的纯文本生成。
 *
 * 放在 PiChat 之外的理由是可测：这些函数只做「数据 → 展示文本」，
 * 不碰控制器状态，也不需要起终端。需要改会话状态的命令留在 PiChat 里。
 *
 * Ink 版的对应输出散在 App.tsx 的 case 分支里，与 setState 混在一起，
 * 只能通过起整棵 React 树才能验证；这里拆开后可以直接断言文本。
 */
import type { BackgroundTask } from '../agent/background/manager.js';
import type { GoalState } from '../agent/goal/mode.js';
import type { StoredMessage } from '../agent/message.js';
import { extractUserText } from '../tui/backtrack.js';
import { formatMemoryEntryLine, measureMemoryIndex, MEMORY_INDEX_BUDGET, scanMemory } from '../agent/memory.js';
import { formatCount, formatDuration } from '../tui/duration.js';

/** `/tasks` 的文本清单（Ink 版是 TasksViewer 弹层，pi 版先给只读文本）。 */
export function formatTaskList(tasks: readonly BackgroundTask[], now: number): string {
  if (tasks.length === 0) return '当前没有后台任务';
  const order: Record<string, number> = { running: 0, failed: 1, completed: 2, killed: 3 };
  const sorted = [...tasks].sort((a, b) => {
    const d = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    if (d !== 0) return d;
    return Date.parse(b.startedAt) - Date.parse(a.startedAt);
  });
  const lines = sorted.map((t) => {
    const started = Date.parse(t.startedAt);
    const end = t.endedAt !== undefined ? Date.parse(t.endedAt) : now;
    const dur = Number.isNaN(started) ? '' : ` · ${formatDuration(Math.max(0, end - started))}`;
    const code = t.status === 'failed' && t.exitCode !== undefined ? ` · exit ${t.exitCode}` : '';
    const kind = t.kind !== undefined && t.kind !== 'process' ? ` · ${t.kind}` : '';
    const cmd = t.command.length > 60 ? t.command.slice(0, 57) + '...' : t.command;
    return `  ${t.status.padEnd(9)} ${t.id}${kind}${dur}${code}\n    ${cmd}`;
  });
  return `后台任务（${tasks.length}）：\n${lines.join('\n')}\n\n用 task_output <id> 看输出，task_stop <id> 终止`;
}

/** `/memory` 无参时的清单文本。enabled=false 时返回开启提示。 */
export function formatMemoryList(cwd: string, enabled: boolean, now: number): string {
  if (!enabled) return '记忆功能未开启（用 /memory on 开启）';
  const scan = scanMemory(cwd);
  const lines: string[] = [];
  const globals = scan.entries.filter((e) => e.scope === 'global');
  const projects = scan.entries.filter((e) => e.scope === 'project');
  lines.push('全局记忆（~/.step-code/memory/）：');
  if (globals.length === 0) lines.push('  （空）');
  for (const e of globals) lines.push(formatMemoryEntryLine(e));
  lines.push('项目记忆（.step-code/memory/）：');
  if (projects.length === 0) lines.push('  （空）');
  for (const e of projects) lines.push(formatMemoryEntryLine(e));
  lines.push(`索引占用：${measureMemoryIndex(scan)} / ${MEMORY_INDEX_BUDGET} 字符`);
  if (scan.broken.length > 0) {
    lines.push('以下文件缺字段或解析失败：');
    for (const e of scan.broken) lines.push(`  - ${e.absPath}`);
  }
  // 回顾提示与 Ink 版同判据：条目过多，或最旧条目超 30 天没动过
  const oldest = scan.entries[scan.entries.length - 1];
  const tooOld =
    oldest !== undefined && oldest.updatedAt !== '' && now - Date.parse(oldest.updatedAt) > 30 * 24 * 3600 * 1000;
  if (scan.entries.length > 30 || tooOld) {
    lines.push('建议做一次回顾：删掉过期观察，合并重复条目');
  }
  return lines.join('\n');
}

/**
 * pi 版尚未接线的命令。
 *
 * M4c 之后全部 29 条注册命令都已接线，这个集合空着，但机制留下：新增命令时
 * 先登记进来，用户会看到「pi 版尚未接线」而不是「未知命令」——命令存在与命令
 * 打错是两件事，提示混在一起会让人以为功能被删了。
 *
 * 仍有一处功能缺口不走这里：`/provider add` 的渠道向导（多步表单）没做，
 * 由 runProvider 单独提示改配置文件的替代路径。
 */
export const NOT_WIRED: ReadonlySet<string> = new Set([]);

/** 未接线命令的提示文本。 */
export function notWiredText(name: string): string {
  return `/${name} 在 pi 版尚未接线（用不带 --pi 的 Ink 版执行）`;
}

/** `/goal` 无参时的状态面板文本（Ink 版是 GoalPanel 圆角框，pi 版给等价文本）。 */
export function formatGoalPanel(g: GoalState, now: number): string {
  const lines = [`目标：${g.objective}`];
  if (g.completionCriterion !== undefined && g.completionCriterion !== '') {
    lines.push(`完成标准：${g.completionCriterion}`);
  }
  const budget: string[] = [`已用 ${g.turnsUsed} 轮`];
  if (g.turnBudget !== undefined) budget.push(`预算 ${g.turnBudget} 轮`);
  budget.push(`${formatCount(g.tokensUsed)} tokens`);
  if (g.tokenBudget !== undefined) budget.push(`预算 ${formatCount(g.tokenBudget)}`);
  budget.push(formatDuration(Math.max(0, now - g.createdAt)));
  lines.push(`状态：${g.status} · ${budget.join(' · ')}`);
  if (g.terminalReason !== undefined && g.terminalReason !== '') lines.push(`原因：${g.terminalReason}`);
  return lines.join('\n');
}

/** `/team status` 的任务清单文本。 */
export function formatTeamStatus(
  base: string,
  dir: string,
  missions: readonly { id: string; status: string; title: string; kind: string; scope: readonly string[]; deps: readonly string[] }[],
): string {
  const body =
    missions.length === 0
      ? '（还没有登记任务，用 team_plan 拆分）'
      : missions
          .map(
            (m) =>
              `  ${m.id} [${m.status}] ${m.title}（${m.kind}，${m.scope.length > 0 ? m.scope.join('、') : '无范围限制'}）` +
              (m.deps.length > 0 ? ` ← 依赖 ${m.deps.join('、')}` : ''),
          )
          .join('\n');
  return `团队模式：基准分支 ${base}\n档案目录：${dir}\n任务：\n${body}`;
}

/** `/loop` 的定时任务清单文本。 */
export function formatCronJobs(
  jobs: readonly { id: string; cron: string; prompt: string; recurring: boolean; nextFireAt: Date }[],
): string {
  if (jobs.length === 0) return '当前没有定时任务（说清要定时做什么，我会用 cron_create 创建）';
  const lines = jobs.map((j) => {
    const kind = j.recurring ? '周期' : '一次性';
    const prompt = j.prompt.length > 50 ? j.prompt.slice(0, 47) + '...' : j.prompt;
    return `  ${j.id} · ${j.cron} · ${kind} · 下次 ${j.nextFireAt.toLocaleString()}\n    ${prompt}`;
  });
  return `定时任务（${jobs.length}）：\n${lines.join('\n')}`;
}

/**
 * `/history` 的可回退轮次清单（最近的排最前）。
 *
 * 与 Ink 版 `collectHistoryItems` 同判据，但那个函数住在 HistoryPanel.tsx 里，
 * 从 .tsx 取它会把 React 一起拖进 pi 侧的模块图，所以这里按同规则重写一份：
 * 只有 origin.kind === 'user' 的消息算可撤销的轮（hook 注入、cron 触发、
 * 续接注入这些不是用户发的，不占轮次）。
 */
export function collectUndoTurns(history: readonly StoredMessage[]): { turns: number; label: string }[] {
  const out: { turns: number; label: string }[] = [];
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.origin.kind !== 'user') continue;
    count += 1;
    const summary = extractUserText(m).replace(/\s+/g, ' ').trim();
    out.push({ turns: count, label: summary.length > 46 ? summary.slice(0, 43) + '...' : summary });
  }
  return out;
}
