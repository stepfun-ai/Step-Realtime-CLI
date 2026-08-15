import { Box, Text } from 'ink';
import { t } from '../i18n.js';
import type { GoalStatus } from '../agent/goal/mode.js';
import { formatElapsed } from '../chat/elapsed.js';

/** /goal 面板的一次性展示数据（DisplayItem 持有，渲染时不再回查 GoalMode）。 */
export interface GoalPanelData {
  objective: string;
  completionCriterion?: string;
  status: GoalStatus;
  turnsUsed: number;
  turnBudget?: number;
  tokensUsed?: number;
  tokenBudget?: number;
  terminalReason?: string;
  elapsedMs: number;
}

function statusColor(status: GoalStatus): string {
  return status === 'active' ? 'green' : status === 'blocked' ? 'yellow' : 'gray';
}

/** /goal 状态面板：圆角框 + 目标 + 完成标准 + 状态/用时/轮次摘要行。 */
export function GoalPanel({ data }: { data: GoalPanelData }): React.ReactElement {
  const turns = data.turnBudget !== undefined ? `${data.turnsUsed}/${data.turnBudget}` : `${data.turnsUsed}`;
  const tokens =
    data.tokensUsed !== undefined
      ? t('goalPanel.tokensSuffix', {
          tokens: data.tokenBudget !== undefined ? `${data.tokensUsed}/${data.tokenBudget}` : `${data.tokensUsed}`,
        })
      : '';
  return (
    <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold color={statusColor(data.status)}>
        {t('goalPanel.title', { status: t(`goalPanel.status.${data.status}`) })}
      </Text>
      <Text>{data.objective}</Text>
      {data.completionCriterion !== undefined ? (
        <Text dimColor>{t('goalPanel.criterion', { text: data.completionCriterion })}</Text>
      ) : null}
      <Text dimColor>
        {t('goalPanel.summary', {
          status: t(`goalPanel.status.${data.status}`),
          elapsed: formatElapsed(data.elapsedMs),
          turns,
          tokens,
        })}
      </Text>
      {data.terminalReason !== undefined ? (
        <Text dimColor>{t('goalPanel.reason', { reason: data.terminalReason })}</Text>
      ) : null}
    </Box>
  );
}
