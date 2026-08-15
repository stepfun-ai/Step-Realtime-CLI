import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { displayWidth, padEndByWidth } from '../chat/liveBudget.js';
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
 *
 * visibleRows 省略时渲染全部条目（历史行为）；传入后按该条数渲染，防止小终端越线。
 * 与 SessionPicker / ModelPicker 同一设计原则：可见条数由上层决定，组件内不读终端尺寸。
 */
export function ThinkPicker({
  items,
  hasHistory,
  onSelect,
  visibleRows,
}: {
  items: ThinkPickerItem[];
  /** 会话已有历史时为 true，顶部显示 cache 失效警告。 */
  hasHistory: boolean;
  onSelect: (name: string | null) => void;
  /** 屏幕可见条数（上层按终端行数解出）；省略则渲染全部条目。 */
  visibleRows?: number;
}): React.ReactElement {
  const [sel, setSel] = useState(0);

  // 按可见条数截断，防止小终端帧总高超红线
  const shown = visibleRows === undefined ? items : items.slice(0, visibleRows);
  // 游标在 shown 范围内钳制（上层保证 visibleRows ≤ items.length 时不会漏项）
  const clampedSel = Math.min(sel, Math.max(shown.length - 1, 0));
  // 左列宽：最长档位名的显示宽度（宽字符按 2 列），档位少通常不受限
  const colWidth = Math.max(...shown.map((m) => displayWidth(m.name)), 0);

  useInput((_input, key) => {
    if (key.escape) {
      onSelect(null);
      return;
    }
    if (key.return) {
      const chosen = shown[clampedSel];
      onSelect(chosen !== undefined ? chosen.name : null);
      return;
    }
    // ↑↓ clamp 移动：越界停住不循环
    if (key.upArrow) {
      setSel((i) => Math.max(i - 1, 0));
      return;
    }
    if (key.downArrow) {
      setSel((i) => Math.min(i + 1, Math.max(shown.length - 1, 0)));
    }
  });

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        {t('thinkPicker.title')}
      </Text>
      {hasHistory && <Text color="yellow">{t('app.think.cacheWarning')}</Text>}
      {shown.length === 0 ? (
        <Text color="gray">{t('thinkPicker.empty')}</Text>
      ) : (
        shown.map((m, i) => {
          const active = i === clampedSel;
          return (
            <Text key={m.name} color={active ? 'cyan' : 'white'} inverse={active}>
              {active ? '› ' : '  '}
              {padEndByWidth(m.name, colWidth)}
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
