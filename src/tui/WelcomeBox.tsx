import { Box, Text } from 'ink';
import { t } from '../i18n.js';

// 顶部 logo：FIGlet "Small" 风格的 S（紧凑双线）。蓝色渲染。
const LOGO_LINES = [
  ' ___ ',
  '/ __|',
  '\\__ \\',
  '|___/',
];

/** 顶部欢迎框：灰色边框 + 蓝色字符画 logo，列出工作目录 / 会话 / 模型 / 版本。开场 banner（灰框、克制配色）。 */
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
            <Text key={i} color="blue">
              {line}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" justifyContent="center">
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
