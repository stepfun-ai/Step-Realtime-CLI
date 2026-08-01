import { Box, Text } from 'ink';
import { t } from '../i18n.js';

/** 预览面板最多逐条展示的条数，超出折叠成「… 还有 N 条」。 */
const MAX_ITEMS = 3;
/** 单条预览最多显示的行数，超出加省略号。 */
const MAX_LINES = 2;

/** 把一条队列消息裁成最多 MAX_LINES 行；超出的行丢弃并在末尾补省略号。 */
export function previewEntry(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= MAX_LINES) return text;
  return `${lines.slice(0, MAX_LINES).join('\n')} …`;
}

/**
 * 发送队列预览面板（替换原单行横幅）：
 * 标题行说明消费时机（回合结束按序发送 · Esc 中断后立即续发），
 * 逐条 `  ↳ ` 预览、dim 色、每条最多 2 行，超过 3 条只显示前 3 条并折叠计数。
 * 每行独立 Text + wrap=truncate：行数截行数、宽度截宽度，
 * 长行不再折行，动态区高度预算按渲染行数精确成立。
 * 数据来自 App 的 queue.current；空队列不渲染。
 */
export function QueuePreview({ queue }: { queue: string[] }): React.ReactElement | null {
  if (queue.length === 0) return null;
  const shown = queue.slice(0, MAX_ITEMS);
  const rest = queue.length - shown.length;
  return (
    <Box flexDirection="column">
      <Text color="gray" wrap="truncate">{t('app.queue.previewTitle', { count: queue.length })}</Text>
      {shown.map((q, i) =>
        previewEntry(q)
          .split('\n')
          .map((line, j) => (
            <Text key={`${i}:${j}`} color="gray" dimColor wrap="truncate">
              {j === 0 ? '  ↳ ' : ''}
              {line}
            </Text>
          )),
      )}
      {rest > 0 ? (
        <Text color="gray" dimColor wrap="truncate">
          {t('app.queue.previewMore', { count: rest })}
        </Text>
      ) : null}
      {/* 可发现性提示：busy + 空输入时 ↑ 取回队尾进输入框编辑（发送从头部消费，编辑从尾部取回） */}
      <Text color="gray" dimColor wrap="truncate">
        {t('app.queue.recallHint')}
      </Text>
    </Box>
  );
}
