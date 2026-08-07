import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { t } from '../i18n.js';
import { saveTopLevelKey } from '../config/config.js';
import { insertText, normalizePastedText, resolveEditAction, type PromptEditState } from './promptEdit.js';

/**
 * 首次运行引导：检测无 API key 时现场配置。
 * 简化版向导：只问「粘贴 key」或「查看文档后手动配置」，不进入完整 provider 向导。
 *
 * 设计对齐主流 CLI 的引导体验：三步完成（选平台 → 粘贴 key → 选模型），
 * 但 step-code 默认平台是 StepFun，故简化为一步粘贴 key。
 */

export type FirstRunResult =
  | { kind: 'configured'; apiKey: string }
  | { kind: 'cancel' };

export function FirstRunSetup({
  onDone,
}: {
  onDone: (result: FirstRunResult) => void;
}): React.ReactElement {
  const [step, setStep] = useState<'ask' | 'paste' | 'done'>('ask');
  const [buf, setBuf] = useState('');
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (step === 'ask') {
      if (key.escape) {
        onDone({ kind: 'cancel' });
        return;
      }
      if (key.return || input === '1') {
        setStep('paste');
        return;
      }
      if (input === '2') {
        // 打印文档链接后退出
        console.log('\n配置文档：https://github.com/li-xiu-qi/Step-Realtime-CLI/blob/step-code-explore/docs/zh/quickstart.md#2-配置-api-key\n');
        onDone({ kind: 'cancel' });
        return;
      }
      return;
    }

    if (step === 'paste') {
      if (key.escape) {
        setStep('ask');
        setBuf('');
        setCursor(0);
        return;
      }
      if (key.return) {
        const key = buf.trim();
        if (key === '') return;
        // 写入 ~/.step-code/config.toml 顶层 api_key（简化版，不区分渠道）
        saveTopLevelKey('api_key', key);
        onDone({ kind: 'configured', apiKey: key });
        return;
      }
      // 编辑键
      const editState: PromptEditState = { text: buf, cursor };
      const action = resolveEditAction(input, key);
      if (action) {
        const next = action(editState);
        setBuf(next.text);
        setCursor(next.cursor);
        return;
      }
      if (input !== '' && !key.ctrl && !key.meta) {
        const next = insertText(editState, normalizePastedText(input));
        setBuf(next.text);
        setCursor(next.cursor);
      }
    }
  });

  if (step === 'ask') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text bold color="yellow">
          {t('firstRun.title')}
        </Text>
        <Text>{t('firstRun.hint')}</Text>
        <Text> </Text>
        <Text color="cyan">› [1] {t('firstRun.optionPaste')}</Text>
        <Text>  [2] {t('firstRun.optionManual')}</Text>
        <Text> </Text>
        <Text color="gray">{t('firstRun.escHint')}</Text>
      </Box>
    );
  }

  if (step === 'paste') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold>{t('firstRun.pasteTitle')}</Text>
        <Text color="gray">{t('firstRun.pasteHint')}</Text>
        <Text> </Text>
        <Text>
          {'> '}
          {buf}
          <Text color="cyan">▌</Text>
        </Text>
        <Text> </Text>
        <Text color="gray">{t('firstRun.pasteEscHint')}</Text>
      </Box>
    );
  }

  return <Text>{t('firstRun.done')}</Text>;
}
