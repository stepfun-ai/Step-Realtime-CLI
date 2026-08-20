/**
 * pi-tui 侧命令的纯文本生成。
 *
 * 放在 PiChat 之外的理由是可测：这些函数只做「数据 → 展示文本」，
 * 不碰控制器状态，也不需要起终端。需要改会话状态的命令留在 PiChat 里。
 *
 * 命令文本输出：把各命令的结果拼成文本行。对应输出原先散在 App.tsx 的 case 分支里，
 * 与渲染混在一起，抽出成纯函数便于测试与复用。
 * 只能通过起整棵 React 树才能验证；这里拆开后可以直接断言文本。
 */
import type { BackgroundTask } from '../agent/background/manager.js';
import type { GoalState } from '../agent/goal/mode.js';
import type { StoredMessage } from '../agent/message.js';
import { extractUserText } from '../chat/backtrack.js';
import { formatMemoryEntryLine, measureMemoryIndex, MEMORY_INDEX_BUDGET, scanMemory } from '../agent/memory.js';
import { formatCount, formatDuration } from '../chat/duration.js';
import { t } from '../i18n.js';
import { getLocale } from '../i18n.js';

/** `/tasks` 的文本清单。 */
export function formatTaskList(tasks: readonly BackgroundTask[], now: number): string {
  if (tasks.length === 0) return t('commandText.tasks.empty');
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
  return t('commandText.tasks.title', { count: tasks.length }) + '\n' + lines.join('\n') + '\n\n' + t('commandText.tasks.footer');
}

/** `/memory` 无参时的清单文本。enabled=false 时返回开启提示。 */
export function formatMemoryList(cwd: string, enabled: boolean, now: number): string {
  if (!enabled) return t('commandText.memory.disabled');
  const scan = scanMemory(cwd);
  const lines: string[] = [];
  const globals = scan.entries.filter((e) => e.scope === 'global');
  const projects = scan.entries.filter((e) => e.scope === 'project');
  lines.push(t('app.memory.listGlobal'));
  if (globals.length === 0) lines.push(t('app.memory.listEmpty'));
  for (const e of globals) lines.push(formatMemoryEntryLine(e));
  lines.push(t('app.memory.listProject'));
  if (projects.length === 0) lines.push(t('app.memory.listEmpty'));
  for (const e of projects) lines.push(formatMemoryEntryLine(e));
  lines.push(t('app.memory.indexUsage', { used: measureMemoryIndex(scan), budget: MEMORY_INDEX_BUDGET }));
  if (scan.broken.length > 0) {
    lines.push(t('commandText.memory.brokenHeader'));
    for (const e of scan.broken) lines.push(`  - ${e.absPath}`);
  }
  // 回顾提示判据：条目过多，或最旧条目超 30 天没动过
  const oldest = scan.entries[scan.entries.length - 1];
  const tooOld =
    oldest !== undefined && oldest.updatedAt !== '' && now - Date.parse(oldest.updatedAt) > 30 * 24 * 3600 * 1000;
  if (scan.entries.length > 30 || tooOld) {
    lines.push(t('commandText.memory.reviewHint'));
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
 * 交互形态上仍有一处限制：`/provider add` 的向导只做手动录入，没有「目录导入」
 * 路径（Ink 版会 fetch 远端 catalog 选供应商后批量导入别名）。手动录入对任何渠道都
 * 走得通，目录导入依赖外部端点可用性且只覆盖少数供应商，记在设计档案的差异清单里。
 */
export const NOT_WIRED: ReadonlySet<string> = new Set([]);

/** 未接线命令的提示文本。 */
export function notWiredText(name: string): string {
  // Ink 版已在 M5 删除，提示不能再让用户「去用 Ink 版」——那条路不存在了
  return t('commandText.notWired', { name });
}

/** `/goal` 无参时的状态面板文本。 */
export function formatGoalPanel(g: GoalState, now: number): string {
  const lines = [t('commandText.goal.objective', { objective: g.objective })];
  if (g.completionCriterion !== undefined && g.completionCriterion !== '') {
    lines.push(t('goalPanel.criterion', { text: g.completionCriterion }));
  }
  const budget: string[] = [t('commandText.goal.turnsUsed', { turns: g.turnsUsed })];
  if (g.turnBudget !== undefined) budget.push(t('commandText.goal.turnBudget', { budget: g.turnBudget }));
  budget.push(t('commandText.goal.tokenBudget', { tokens: formatCount(g.tokensUsed) }));
  if (g.tokenBudget !== undefined) budget.push(t('commandText.goal.tokenBudget', { tokens: formatCount(g.tokenBudget) }));
  budget.push(formatDuration(Math.max(0, now - g.createdAt)));
  lines.push(t('commandText.goal.status', { status: g.status, budget: budget.join(' · ') }));
  if (g.terminalReason !== undefined && g.terminalReason !== '') lines.push(t('goalPanel.reason', { reason: g.terminalReason }));
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
      ? t('commandText.team.noMissions')
      : missions
          .map(
            (m) =>
              t('commandText.team.missionLine', {
                id: m.id,
                status: m.status,
                title: m.title,
                kind: m.kind,
                scope: m.scope.length > 0 ? m.scope.join(getLocale() === 'zh' ? '、' : ', ') : t('commandText.team.noScope'),
              }) +
              (m.deps.length > 0 ? t('commandText.team.depSuffix', { deps: m.deps.join(getLocale() === 'zh' ? '、' : ', ') }) : ''),
          )
          .join('\n');
  return t('app.team.statusBody', { base, dir, body });
}

/** `/loop` 的定时任务清单文本。 */
export function formatCronJobs(
  jobs: readonly { id: string; cron: string; prompt: string; recurring: boolean; nextFireAt: Date }[],
): string {
  if (jobs.length === 0) return t('commandText.cron.empty');
  const lines = jobs.map((j) => {
    const kind = j.recurring ? t('commandText.cron.recurring') : t('cronCard.oneShot');
    const prompt = j.prompt.length > 50 ? j.prompt.slice(0, 47) + '...' : j.prompt;
    return t('commandText.cron.line', { id: j.id, cron: j.cron, kind, next: j.nextFireAt.toLocaleString() }) +
      `\n    ${prompt}`;
  });
  return t('commandText.cron.header', { count: jobs.length }) + '\n' + lines.join('\n');
}

/**
 * `/history` 的可回退轮次清单（最近的排最前）。
 *
 * ，但那个函数住在 HistoryPanel.tsx 里，
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
