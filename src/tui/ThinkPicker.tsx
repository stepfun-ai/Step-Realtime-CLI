import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { t } from '../i18n.js';

/** 思考深度选择器的单条候选项（由 App 从档位表装配；off 固定追加在尾部）。 */
export interface ThinkPickerItem {
  /** 档位名，或 'off'（Enter 确认后回传给切换逻辑）。 */
  name: string;
  /** 右列 budget 说明（off 项为关闭文案，灰色显示）。 */
  detail: string;
  /** 是否当前生效项（后缀 ← 当前 标记）。 */
  current: boolean;
}

/**
 * 交互式思考深度选择器（/think 无参唤起，替换输入区，对齐 ModelPicker 的弹层挂载模式）：
 * 档位少（默认 3 档 + off），故无搜索/分页——只有指针 › + 档位名（左列）+ budget（右列灰色）
 * + 当前项 ← 当前 后缀；↑↓ 移动（越界 clamp 不循环），Enter 确认，Esc 取消。
 * 会话已有历史时顶部显示 prompt cache 失效警告。
 */
export function ThinkPicker({
  items,
  hasHistory,
  onSelect,
}: {
  items: ThinkPickerItem[];
  /** 会话已有历史时为 true，顶部显示 cache 失效警告。 */
  hasHistory: boolean;
  onSelect: (name: string | null) => void;
}): React.ReactElement {
  const [sel, setSel] = useState(0);

  // 越界钳制（列表静态，仅为防御）；无分页
  const clampedSel = Math.min(sel, Math.max(items.length - 1, 0));
  // 左列宽 = 最长档位名（档位少，不做终端宽截断）
  const colWidth = Math.max(...items.map((m) => m.name.length), 0);

  useInput((_input, key) => {
    if (key.escape) {
      onSelect(null);
      return;
    }
    if (key.return) {
      const chosen = items[clampedSel];
      onSelect(chosen !== undefined ? chosen.name : null);
      return;
    }
    // ↑↓ clamp 移动：越界停住不循环
    if (key.upArrow) {
      setSel((i) => Math.max(i - 1, 0));
      return;
    }
    if (key.downArrow) {
      setSel((i) => Math.min(i + 1, Math.max(items.length - 1, 0)));
    }
  });

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        {t('thinkPicker.title')}
      </Text>
      {hasHistory && <Text color="yellow">{t('app.think.cacheWarning')}</Text>}
      {items.length === 0 ? (
        <Text color="gray">{t('thinkPicker.empty')}</Text>
      ) : (
        items.map((m, i) => {
          const active = i === clampedSel;
          return (
            <Text key={m.name} color={active ? 'cyan' : 'white'} inverse={active}>
              {active ? '› ' : '  '}
              {m.name.padEnd(colWidth)}
              {'  '}
              <Text color="gray">{m.detail}</Text>
              {m.current ? <Text color="green">{` ${t('modelPicker.current')}`}</Text> : null}
            </Text>
          );
        })
      )}
      <Text color="gray">{t('thinkPicker.hint')}</Text>
    </Box>
  );
}
