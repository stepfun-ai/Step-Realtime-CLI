import { Box, Text, useInput, usePaste } from 'ink';
import { useState, useCallback } from 'react';
import { t } from '../i18n.js';
// @ts-ignore - TS6133: saveProviderKey 实际在下方 useInput 回调中使用，TS 无法穿透 useEffect 闭包追踪
import { saveProviderKey } from '../config/config.js';
import {
  insertText,
  normalizePastedText,
  resolveEditAction,
  type PromptEditState,
} from './promptEdit.js';

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

export type FirstRunResult =
  | { kind: 'configured'; apiKey: string; provider: string }
  | { kind: 'cancel' };

interface ProviderOption {
  /** 在 [providers.<name>] 里写的渠道名。 */
  name: string;
  /** 显示名称。 */
  label: string;
  /** base_url 默认值。 */
  baseUrl: string;
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    name: 'stepfun-plan',
    label: 'StepFun Plan 订阅',
    baseUrl: 'https://api.stepfun.com/step_plan/v1',
  },
  {
    name: 'stepfun',
    label: 'StepFun API 按量',
    baseUrl: 'https://api.stepfun.com',
  },
  {
    // 3 号是「自定义」占位，name 实际在 step2 由用户输入决定
    name: 'custom',
    label: '自定义 base_url',
    baseUrl: 'https://',
  },
];

/** 向导步骤：选择接入方式 → 输入 base_url（仅自定义）/ 粘贴 key → 确认。 */
type Step = 'select' | 'baseUrl' | 'key' | 'confirm';

// ──────────────────────────────────────────────
// 子组件：可编辑输入框（自绘光标，与 PromptInput.tsx 渲染逻辑对齐）
// ──────────────────────────────────────────────

function EditableInput({
  value,
  cursor,
  onChange,
  title,
  hint,
  placeholder,
}: {
  value: string;
  cursor: number;
  onChange: (next: { text: string; cursor: number }) => void;
  title: string;
  hint: string;
  placeholder?: string;
}): React.ReactElement {
  // 单行字段（API key / base_url）语义：粘贴的长 key 在终端里常被折行，
  // 换行符若进字段再写进 TOML 字符串即成非法控制字符、直接毁掉 config 解析。
  // 故插入前把所有 \r/\n 一律剥掉（normalizePastedText 只把 \r\n 归一成 \n，不够）。
  const toSingleLine = (raw: string): string => normalizePastedText(raw).replace(/[\r\n]+/g, '');

  // bracketed paste：一次性整体插入，不走 useInput 字符分支
  usePaste(
    useCallback(
      (raw: string) => {
        const next = insertText({ text: value, cursor }, toSingleLine(raw));
        onChange(next);
      },
      [value, cursor, onChange],
    ),
  );

  useInput(
    (input, key) => {
      // Enter：透传给上层（由 useInput 在 EditableInput 之外统一处理）
      if (key.return) {
        return;
      }
      // Esc：透传给上层
      if (key.escape) {
        return;
      }
      const editState: PromptEditState = { text: value, cursor };
      const action = resolveEditAction(input, key);
      if (action) {
        const next = action(editState);
        if (next.text !== value || next.cursor !== cursor) {
          onChange(next);
        }
        return;
      }
      // 可打印字符：无 ctrl/meta 修饰时在光标处插入
      if (input !== '' && !key.ctrl && !key.meta) {
        const next = insertText(editState, toSingleLine(input));
        onChange(next);
      }
    },
    { isActive: true },
  );

  const chars = Array.from(value);
  const at = Math.max(0, Math.min(cursor, chars.length));
  const cursorChar = at < chars.length ? chars[at]! : ' ';
  const onNewline = cursorChar === '\n';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{title}</Text>
      <Text color="gray">{hint}</Text>
      <Text> </Text>
      <Text>
        {'> '}
        {chars.slice(0, at).join('')}
        <Text inverse>{onNewline ? ' ' : cursorChar}</Text>
        {onNewline ? '\n' : ''}
        {at < chars.length ? chars.slice(at + 1).join('') : ''}
      </Text>
      {placeholder !== undefined && value === '' ? (
        <Text dimColor>{placeholder}</Text>
      ) : null}
    </Box>
  );
}

// ──────────────────────────────────────────────
// 主组件
// ──────────────────────────────────────────────

export function FirstRunSetup({
  onDone,
}: {
  onDone: (result: FirstRunResult) => void;
}): React.ReactElement {
  const [step, setStep] = useState<Step>('select');
  // select 步骤的选中项索引
  const [selIdx, setSelIdx] = useState(0);
  // 自定义 base_url 输入
  const [customBaseUrl, setCustomBaseUrl] = useState({ text: 'https://', cursor: 8 });
  // API key 输入
  const [keyState, setKeyState] = useState({ text: '', cursor: 0 });
  // 选中的渠道（select 步骤结果）
  const [chosen, setChosen] = useState<ProviderOption | null>(null);

  // ── Esc 路由（仅在 select / confirm 步骤激活；baseUrl / key 由 EditableInput 自行处理）──
  useInput(
    (_input, key) => {
      if (!key.escape) return;
      if (step === 'select') {
        onDone({ kind: 'cancel' });
      } else if (step === 'confirm') {
        if (chosen?.name === 'custom') {
          setStep('baseUrl');
        } else {
          setStep('key');
        }
      }
    },
    { isActive: step === 'select' || step === 'confirm' },
  );

  // ── Enter / 数字键路由（select / baseUrl / confirm 消费 Enter；key 步骤也激活以处理确认）──
  useInput(
    (input, key) => {
      if (!key.return && !/^[1-4]$/.test(input)) return;
      if (step === 'select') {
        const idx = input === '1' ? 0 : input === '2' ? 1 : input === '3' ? 2 : input === '4' ? 3 : selIdx;
        const option = PROVIDER_OPTIONS[idx]!;
        if (!option) return;
        if (idx === 3) {
          console.log(
            '\n配置文档：https://github.com/li-xiu-qi/Step-Realtime-CLI/blob/step-code-explore/docs/zh/quickstart.md#2-%E9%85%8D%E7%BD%AE-api-key\n',
          );
          onDone({ kind: 'cancel' });
          return;
        }
        setChosen(option);
        setKeyState({ text: '', cursor: 0 });
        if (option.name === 'custom') {
          setCustomBaseUrl({ text: 'https://', cursor: 8 });
          setStep('baseUrl');
        } else {
          setStep('key');
        }
      } else if (step === 'baseUrl') {
        const url = customBaseUrl.text.trim();
        if (url === '') return;
        setChosen((prev) => (prev !== null ? { ...prev, baseUrl: url } : prev));
        setKeyState({ text: '', cursor: 0 });
        setStep('key');
      } else if (step === 'key') {
        const apiKey = keyState.text.trim();
        if (apiKey === '') return;
        if (chosen === null) return;
        // 写入配置
        saveProviderKey(chosen.name, 'base_url', chosen.baseUrl);
        saveProviderKey(chosen.name, 'api_key', apiKey);
        setStep('confirm');
      } else if (step === 'confirm') {
        if (chosen === null) return;
        onDone({ kind: 'configured', apiKey: keyState.text.trim(), provider: chosen.name });
      }
    },
    { isActive: true },
  );

  // ── 上下键路由（仅 select 步骤）──
  useInput(
    (_input, key) => {
      if (step !== 'select') return;
      if (key.upArrow) {
        setSelIdx((i) => (i - 1 + PROVIDER_OPTIONS.length) % PROVIDER_OPTIONS.length);
      } else if (key.downArrow) {
        setSelIdx((i) => (i + 1) % PROVIDER_OPTIONS.length);
      }
    },
    { isActive: step === 'select' },
  );

  // ── 渲染 ──
  if (step === 'select') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text bold color="yellow">{t('firstRun.title')}</Text>
        <Text>{t('firstRun.hint')}</Text>
        <Text> </Text>
        {PROVIDER_OPTIONS.map((opt, i) => (
          <Text key={opt.name} color={i === selIdx ? 'cyan' : 'white'} bold={i === selIdx}>
            {i === selIdx ? '› ' : '  '}[{i + 1}] {opt.label}
          </Text>
        ))}
        <Text> </Text>
        <Text color="gray">{t('firstRun.escHint')}</Text>
      </Box>
    );
  }

  if (step === 'baseUrl') {
    return (
      <Box flexDirection="column">
        <EditableInput
          value={customBaseUrl.text}
          cursor={customBaseUrl.cursor}
          onChange={(next) => setCustomBaseUrl(next)}
          title={t('firstRun.baseUrlTitle')}
          hint={t('firstRun.baseUrlHint')}
        />
        <Text color="gray">{t('firstRun.pasteEscHint')}</Text>
      </Box>
    );
  }

  if (step === 'key') {
    const displayBaseUrl = chosen !== null ? chosen.baseUrl : '';
    return (
      <Box flexDirection="column">
        {chosen !== null && (
          <Text color="gray">
            {t('firstRun.providerLabel', { label: chosen.label })} · {displayBaseUrl}
          </Text>
        )}
        <EditableInput
          value={keyState.text}
          cursor={keyState.cursor}
          onChange={(next) => setKeyState(next)}
          title={t('firstRun.pasteTitle')}
          hint={t('firstRun.pasteHint')}
        />
        <Text color="gray">{t('firstRun.pasteEscHint')}</Text>
      </Box>
    );
  }

  if (step === 'confirm') {
    if (chosen === null) return <Text />;
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
        <Text bold color="green">{t('firstRun.confirmTitle')}</Text>
        <Text> </Text>
        <Text>
          {t('firstRun.confirmProvider', { label: chosen.label })}
          {'\n'}
          {t('firstRun.confirmBaseUrl', { url: chosen.baseUrl })}
          {'\n'}
          {t('firstRun.confirmKeyHint')}
        </Text>
        <Text> </Text>
        <Text color="gray">{t('firstRun.confirmHint')}</Text>
      </Box>
    );
  }

  return <Text>{t('firstRun.done')}</Text>;
}
