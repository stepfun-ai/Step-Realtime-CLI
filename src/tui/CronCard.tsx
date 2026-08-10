import { Box, Text } from 'ink';
import { t } from '../i18n.js';

/** cron 触发卡片的一次性展示数据（DisplayItem 持有）。 */
export interface CronCardData {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  coalesced: number;
}

/**
 * cron 触发卡片：
 * ● 标题行 + dim 详情行（cron 表达式 | job id | 一次性 | 合并 N 次）+ prompt 正文。
 * 注入模型的 prompt 本身在转录区只经此卡片呈现，不再显示为普通用户消息。
 */
export function CronCard({ data }: { data: CronCardData }): React.ReactElement {
  const details = [data.cron, `job ${data.id}`];
  if (!data.recurring) details.push(t('cronCard.oneShot'));
  if (data.coalesced > 1) details.push(t('cronCard.coalesced', { count: data.coalesced }));
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold color="cyan">
        {`● ${t('cronCard.title')}`}
      </Text>
      <Text dimColor>{`  ${details.join(' | ')}`}</Text>
      <Text>{`  ${data.prompt}`}</Text>
    </Box>
  );
}
