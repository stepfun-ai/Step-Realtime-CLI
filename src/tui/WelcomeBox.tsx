import { Box, Text } from 'ink';
import { t } from '../i18n.js';

// 红色像素小生物 logo（两只眼睛 + 小腿），呼应阶跃 AI 的 space-invader 风格图标。
const LOGO_LINES = [' ▟█▙ ', '█▀█▀█', '▘▘ ▘▘'];

/** 顶部欢迎框：灰色边框 + 红色像素 logo，列出工作目录 / 会话 / 模型 / 版本。开场 banner（灰框、克制配色）。 */
export function WelcomeBox({
  cwd,
  sessionId,
  model,
  version,
}: {
  cwd: string;
  sessionId: string;
  model: string;
  version: string;
}): React.ReactElement {
  const row = (label: string, value: string): React.ReactElement => (
    <Text>
      <Text color="gray">{label.padEnd(11)}</Text>
      <Text>{value}</Text>
    </Text>
  );
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
      <Box flexDirection="row">
        <Box flexDirection="column" marginRight={2}>
          {LOGO_LINES.map((line, i) => (
            <Text key={i} color="red">
              {line}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>{t('welcome.title')}</Text>
          <Text color="gray">{t('welcome.helpHint')}</Text>
        </Box>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {row('Directory:', cwd)}
        {row('Session:', sessionId)}
        {row('Model:', model)}
        {row('Version:', version)}
      </Box>
    </Box>
  );
}
