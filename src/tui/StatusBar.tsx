import { homedir } from 'node:os';
import { Box, Text } from 'ink';
import type { PermissionMode } from '../agent/permission/mode.js';
import type { GoalStatus } from '../agent/goal/mode.js';
import { formatElapsed } from './elapsed.js';
import { formatCount } from './duration.js';

/**
 * 路径缩短：home 前缀替换为 ~；段数 > 3 时只保留尾部 3 段并加 …/ 前缀；
 * 最后仍按总长度兜底，超长只保留尾部字符。
 */
export function shortenPath(p: string, max = 48): string {
  let display = p;
  const home = homedir();
  if (home) {
    const lower = p.toLowerCase();
    const homeLower = home.toLowerCase();
    // Windows 路径大小写不敏感，统一转小写比较
    if (lower === homeLower || lower.startsWith(`${homeLower}\\`) || lower.startsWith(`${homeLower}/`)) {
      display = `~${p.slice(home.length)}`;
    }
  }
  // 按 / 和 \ 切分，兼容 Windows 路径；段数 > 3 时保留尾部 3 段，统一用 / 连接
  const parts = display.split(/[\\/]+/).filter((seg) => seg.length > 0);
  if (parts.length > 3) {
    display = `…/${parts.slice(-3).join('/')}`;
  }
  if (display.length > max) {
    display = `…${display.slice(display.length - max + 1)}`;
  }
  return display;
}

function modeColor(mode: PermissionMode): string {
  return mode === 'yolo' ? 'red' : mode === 'auto' ? 'yellow' : 'green';
}

function goalStatusColor(status: GoalStatus): string {
  return status === 'active' ? 'green' : status === 'blocked' ? 'yellow' : 'gray';
}

/**
 * 底部状态栏：两行式。
 * 第一行：权限模式 / 模型 / 运行状态 / 后台任务计数（仅 >0 显示）/ 工作目录；第二行：左侧快捷键提示，右侧 context 用量。
 * 防换行策略：每行严格单行，窄终端下靠截断降级——第一行路径最先被截断（徽章不收缩，优先级高于路径），
 * 第二行 hints 先被截断，context 永不截断且始终贴右。
 */
export function StatusBar({
  mode,
  planMode = false,
  teamActive = false,
  model,
  thinking,
  busy,
  cwd,
  usedTokens,
  maxContextSize,
  hints,
  backgroundCount = 0,
  latestBgTaskName,
  goal,
}: {
  mode: PermissionMode;
  /** plan 模式开启时优先显示 plan 标签。 */
  planMode?: boolean;
  /** team 团队模式活跃时显示 team 徽章（任务详情走 /team status）。 */
  teamActive?: boolean;
  model: string;
  /** 思考深度档位标签（如 'high' / 'off'；undefined 不显示）。紧凑缩写不进 i18n（同 bg:N）。 */
  thinking?: string;
  busy: boolean;
  cwd: string;
  usedTokens: number;
  maxContextSize: number;
  /** 快捷键提示文案（由调用方拼好传入），窄终端下最先被截断。 */
  hints: string;
  /** 运行中的后台任务数（>0 时在运行状态后显示 bg:N 徽章）。 */
  backgroundCount?: number;
  /** 最近一个 running 状态后台任务的命令名（组件内截断到 20 字符，超出加 …），在 bg:N 后灰色显示。 */
  latestBgTaskName?: string;
  /** 进行中的 goal 摘要（存在时在 bg 徽章后显示 goal 徽章；elapsedMs 由调用方按当前时刻算好）。 */
  goal?: {
    status: GoalStatus;
    turnsUsed: number;
    turnBudget?: number;
    elapsedMs: number;
  };
}): React.ReactElement {
  const pct = maxContextSize > 0 ? Math.min(100, Math.round((usedTokens / maxContextSize) * 100)) : 0;
  const contextText = `context: ${pct}% (${formatCount(usedTokens)}/${formatCount(maxContextSize)})`;
  return (
    <Box flexDirection="column" overflowX="hidden">
      {/* 第一行：徽章 / 模型 / 状态不收缩，路径收缩截断；间隔也要套 flexShrink 0 的壳，否则 yoga 会压缩裸 Text */}
      <Box overflowX="hidden">
        <Box flexShrink={0}>
          {planMode ? (
            <Text color="blue">plan</Text>
          ) : (
            <Text color={modeColor(mode)}>{mode}</Text>
          )}
        </Box>
        <Box flexShrink={0}>
          <Text color="gray">{'  '}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text color="cyan">{model}</Text>
        </Box>
        {/* 思考深度徽章：档位覆盖生效或 config 默认带 default_level 时由调用方传入；think: 为紧凑缩写不进 i18n */}
        {thinking !== undefined ? (
          <Box flexShrink={0}>
            <Text color="gray">{` · think:${thinking}`}</Text>
          </Box>
        ) : null}
        <Box flexShrink={0}>
          <Text color="gray">{'  '}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text color={busy ? 'yellow' : 'gray'}>{busy ? 'busy' : 'ready'}</Text>
        </Box>
        {/* 后台任务徽章：仅 N>0 显示，flexShrink 0 不收缩（优先级高于路径）；bg:N 为纯数字缩写，不进 i18n */}
        {backgroundCount > 0 ? (
          <>
            <Box flexShrink={0}>
              <Text color="gray">{'  '}</Text>
            </Box>
            <Box flexShrink={0}>
              <Text color="cyan">{`bg:${backgroundCount}`}</Text>
              {latestBgTaskName !== undefined ? (
                <Text color="gray">{` ${latestBgTaskName.length > 20 ? `${latestBgTaskName.slice(0, 20)}…` : latestBgTaskName}`}</Text>
              ) : null}
            </Box>
          </>
        ) : null}
        {/* goal 徽章：goal ● 用时 · 轮次[/预算]，● 按状态着色；同 bg:N 为紧凑缩写不进 i18n */}
        {goal !== undefined ? (
          <>
            <Box flexShrink={0}>
              <Text color="gray">{'  '}</Text>
            </Box>
            <Box flexShrink={0}>
              <Text>
                <Text color="gray">goal </Text>
                <Text color={goalStatusColor(goal.status)}>●</Text>
                <Text color="gray">{` ${formatElapsed(goal.elapsedMs)} · ${goal.turnBudget !== undefined ? `${goal.turnsUsed}/${goal.turnBudget}` : goal.turnsUsed}`}</Text>
              </Text>
            </Box>
          </>
        ) : null}
        {/* team 徽章：团队模式活跃时常驻；同 bg:N 为紧凑缩写不进 i18n */}
        {teamActive === true ? (
          <>
            <Box flexShrink={0}>
              <Text color="gray">{'  '}</Text>
            </Box>
            <Box flexShrink={0}>
              <Text color="magenta">team</Text>
            </Box>
          </>
        ) : null}
        <Box flexShrink={0}>
          <Text color="gray">{'  '}</Text>
        </Box>
        {/* ink 的 Text 不吃 flex 属性，套一层 Box 壳做收缩截断 */}
        <Box flexShrink={1} minWidth={0} overflowX="hidden">
          <Text color="gray" wrap="truncate">
            {shortenPath(cwd)}
          </Text>
        </Box>
      </Box>
      {/* 第二行：hints 收缩截断，context 不收缩、右对齐锚定行尾 */}
      <Box justifyContent="space-between" overflowX="hidden">
        <Box flexShrink={1} minWidth={0} overflowX="hidden">
          <Text color="gray" wrap="truncate">
            {hints}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text color="gray">{contextText}</Text>
        </Box>
      </Box>
    </Box>
  );
}
