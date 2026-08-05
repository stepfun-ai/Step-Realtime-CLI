import { Box, Text } from 'ink';
import { t } from '../i18n.js';
import { formatCount, formatDuration } from './duration.js';
import { useNowTick } from './useSpinnerFrame.js';

/** 并行子 agent 的单个进度。 */
export interface SubagentProgress {
  /** 子 agent 标识（并行时区分，来自 runner 的 sid）。 */
  id: string;
  /** 类型（explore/general 或自定义）。 */
  type: string;
  /** 任务描述。 */
  description: string;
  /** 状态。 */
  status: 'queued' | 'running' | 'done' | 'error';
  /** 已用工具数。 */
  toolCount: number;
  /** 最新活动（运行中的当前工具/动作）。 */
  activity?: string;
  /** 开始时间戳（ms，start 事件时记）。 */
  startedAt: number;
  /** 结束时间戳（ms，end 事件时记）；缺省 = 仍在运行，时长按当前时刻现算。 */
  endedAt?: number;
  /** 累计计费 token（input − cache_read + output 逐轮累计）；0/缺省不显示 tok 段。 */
  tokens?: number;
}

/**
 * 行内统计段：`{toolCount} tools · {duration}[ · {tokens} tok]`。
 * tokens > 0 才显示 tok 段（避免开头一片 0 tok）。
 * nowMs 用于运行中条目时长现算；终态条目传定格值（endedAt）即可。
 * AgentGroup 行、冻结摘要、WorkflowPanel 成员行三处共用，防格式漂移。
 */
export function formatSubagentStats(a: SubagentProgress, nowMs: number): string {
  const duration = formatDuration((a.endedAt ?? nowMs) - a.startedAt);
  const tok = a.tokens !== undefined && a.tokens > 0 ? ` · ${formatCount(a.tokens)} tok` : '';
  return `${a.toolCount} tools · ${duration}${tok}`;
}

/**
 * 全部终态后冻结进历史的纯文本摘要。
 * 运行进度由动态面板承担，完成结果由历史承担：面板撤下后，scrollback 里留有可回看的定稿记录。
 * 时长与 token 用定格值（endedAt / 最终 tokens）。
 */
export function formatAgentGroupSummary(agents: readonly SubagentProgress[]): string {
  const errored = agents.filter((a) => a.status === 'error').length;
  const many = agents.length > 1;
  const header = many
    ? t('agentGroup.header.manyDone', {
        total: agents.length,
        failed: errored > 0 ? t('agentGroup.failedSuffix', { count: errored }) : '',
      })
    : t('agentGroup.header.singleDone', { failed: errored > 0 ? t('agentGroup.failedTag') : '' });
  const lines = agents.map((a, i) => {
    const branch = i === agents.length - 1 ? '└─' : '├─';
    const mark = a.status === 'done' ? '✓' : '✗';
    const statusText = a.status === 'done' ? t('agentGroup.status.done') : t('agentGroup.status.error');
    // 终态定格：endedAt 缺省（异常路径）时退化为 0s，不用当前时刻（摘要必须可定格）
    return `${branch} ${a.type} · ${a.description} · ${formatSubagentStats(a, a.endedAt ?? a.startedAt)} · ${mark} ${statusText}`;
  });
  return [`✓ ${header}`, ...lines].join('\n');
}

/**
 * 转入后台时的交接记录（进历史，scrollback 留痕）。
 *
 * 面板只承载「前台在跑、用户正在等」的子 agent，回合收尾即撤下。但仍在运行的条目
 * 此刻是转入后台继续跑，不是结束——直接撤下会表现为「进度和 token 凭空消失」。
 * 这条记录交代清楚：谁还在跑、跑到哪了、去哪看后续（bg:N 徽章 / /tasks / 终态通知）。
 */
export function formatDetachedHandoff(agents: readonly SubagentProgress[]): string {
  const now = Date.now();
  const lines = agents.map((a, i) => {
    const branch = i === agents.length - 1 ? '└─' : '├─';
    return `${branch} ${a.type} · ${a.description} · ${formatSubagentStats(a, now)}`;
  });
  return [t('agentGroup.detachedHandoff', { count: agents.length }), ...lines].join('\n');
}

/**
 * 面板渲染行数（动态区高度预算用）。
 *
 * 与本文件的渲染结构严格对应，**必须与 AgentGroup 的 JSX 同步修改**：
 * margin 1 + 边框 2 + 头部 1 = 4 固定；每个子 agent 1 行（running 且有 activity 再 +1）；
 * 存在 running 条目时尾部多一行 backgroundHint。
 *
 * 为什么放在组件文件里：这个公式原先散在 App.tsx 的预算组装处，与渲染分离两地，
 * backgroundHint 加入渲染时预算侧漏改，帧高超预算 1 行、恰好越过 rows−1 红线，
 * Ink 走全量清屏分支（clearTerminal 含 \x1b[3J）清掉 scrollback，
 * 表现为「向上滚动被拽回顶部」。同文件同步维护，杜绝这类漂移。
 */
export function agentGroupRows(agents: readonly SubagentProgress[]): number {
  if (agents.length === 0) return 0;
  const bodyRows = agents.reduce(
    (n, a) => n + 1 + (a.status === 'running' && a.activity !== undefined && a.activity !== '' ? 1 : 0),
    0,
  );
  const hintRows = agents.some((a) => a.status === 'running') ? 1 : 0;
  return 4 + bodyRows + hintRows;
}

/**
 * 并行子 agent（一轮多调用并行）的树形分组面板。
 * 头部计数 + 每个子 agent 一行（类型·描述·tools·时长·tok·状态）+ 运行中的最新活动。
 * 时长跳动：仅存在 running 条目时起 1s tick（useNowTick 纪律：空闲零成本），终态行用 endedAt 定格。
 *
 * 改动渲染结构时同步改 agentGroupRows（见其注释）。
 */
export function AgentGroup({ agents }: { agents: SubagentProgress[] }): React.ReactElement | null {
  const hasRunning = agents.some((a) => a.status === 'running');
  useNowTick(hasRunning, 1000);
  if (agents.length === 0) return null;
  const done = agents.filter((a) => a.status === 'done').length;
  const running = agents.filter((a) => a.status === 'running').length;
  const errored = agents.filter((a) => a.status === 'error').length;
  const allDone = done + errored === agents.length;
  // 单个子 agent 与「一轮多调用并行」的多个子 agent，用同一面板渲染，仅头部措辞不同。
  const many = agents.length > 1;

  const header = allDone
    ? many
      ? t('agentGroup.header.manyDone', {
          total: agents.length,
          failed: errored > 0 ? t('agentGroup.failedSuffix', { count: errored }) : '',
        })
      : t('agentGroup.header.singleDone', { failed: errored > 0 ? t('agentGroup.failedTag') : '' })
    : many
      ? t('agentGroup.header.manyRunning', {
          total: agents.length,
          done,
          running,
          failed: errored > 0 ? t('agentGroup.failedSuffixInline', { count: errored }) : '',
        })
      : t('agentGroup.header.singleRunning');

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold wrap="truncate">
        {allDone ? '✓' : '⠶'} {header}
      </Text>
      {agents.map((a, i) => {
        const last = i === agents.length - 1;
        const branch = last ? '└─' : '├─';
        // 状态收敛为单字符圆点（●）：黄=运行中、绿=已完成、红=失败、灰=排队中。
        // 替代原先的「符号 + 状态文字」（约 6-8 列），把行尾宽度让给 stats（tools/时长/tok），
        // 缓解窄终端下 wrap="truncate" 从行尾裁掉 token 段的问题。
        const statusColor =
          a.status === 'done' ? 'green' : a.status === 'error' ? 'red' : a.status === 'running' ? 'yellow' : 'gray';
        return (
          <Box key={i} flexDirection="column">
            {/* 长 description / activity 截断到一行，动态区高度预算按 1 行/条精确成立 */}
            <Text wrap="truncate">
              {branch} <Text color="white">{a.type}</Text>
              <Text color="gray"> · {a.description} · {formatSubagentStats(a, Date.now())} </Text>
              <Text color={statusColor}>●</Text>
            </Text>
            {a.status === 'running' && a.activity !== undefined && a.activity !== '' ? (
              <Text color="gray" wrap="truncate">    {a.activity}</Text>
            ) : null}
          </Box>
        );
      })}
      {/* 前台子 agent 运行中提示可转后台：发现性入口，仅有运行中条目时显示 */}
      {hasRunning ? <Text color="gray">{t('agentGroup.backgroundHint')}</Text> : null}
    </Box>
  );
}
