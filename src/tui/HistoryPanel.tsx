import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { StoredMessage } from '../agent/message.js';
import { t } from '../i18n.js';
import { extractUserText } from './backtrack.js';
import { relativeTime } from './SessionPicker.js';

/** /history 面板的单条候选项：本会话里的一条真人用户输入。 */
export interface HistoryPanelItem {
  /** 选中该项回退要撤销的轮数（1 = 撤销最近一轮，含该轮之后所有轮）；不可回退项为 0。 */
  count: number;
  /** 左列：该轮用户输入摘要（已压单行截断）。 */
  label: string;
  /** 右列：该轮时间（灰色显示）。 */
  detail: string;
  /** 完整输入文本：Enter 回退后 / Tab 纯取回时放回输入框。 */
  text: string;
  /** 是否可回退：压缩点之前的保真原话（user_verbatim）不可回退，Enter 退化为仅取回文本。 */
  undoable: boolean;
}

/** 面板确认结果：回退到某轮（撤销 + 文本回输入框）、仅取回文本、或取消。 */
export type HistoryPanelResult = { kind: 'backtrack'; count: number; text: string } | { kind: 'recall'; text: string } | null;

/**
 * 从当前会话 history 装配面板候选：真人用户输入 = origin.kind 'user'（可回退轮起点）
 * 或 'user_verbatim'（压缩保真下来的早期原话，只可取回文本）；injection/compaction_summary
 * 与静默轮天然排除。逆序（最近在上），count 只按 'user' 轮计。
 */
export function collectHistoryItems(history: StoredMessage[]): HistoryPanelItem[] {
  const items: HistoryPanelItem[] = [];
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.origin.kind !== 'user' && m.origin.kind !== 'user_verbatim') continue;
    const undoable = m.origin.kind === 'user';
    if (undoable) count += 1;
    const text = extractUserText(m);
    const summary = text.replace(/\s+/g, ' ').trim();
    items.push({
      count: undoable ? count : 0,
      label: summary.length > 40 ? `${summary.slice(0, 40)}…` : summary,
      detail: relativeTime(m.ts),
      text,
      undoable,
    });
  }
  return items;
}

/**
 * /history 统一回顾回退面板（/history 与 /undo 同入口唤起，替换输入区，照抄 ThinkPicker 的弹层模式）：
 * 列本会话真人用户输入（最近在上），指针 › + 输入摘要（左列）+ 时间（右列灰色）；
 * ↑↓ 移动（越界 clamp 不循环）；Enter = 回退到该轮（撤销该轮及其后所有轮，输入文本放回输入框可编辑重发），
 * 不可回退项（压缩点之前）Enter 退化为仅取回文本；Tab = 仅取回文本不回退；Esc 关闭。
 */
export function HistoryPanel({
  items,
  onSelect,
}: {
  items: HistoryPanelItem[];
  onSelect: (result: HistoryPanelResult) => void;
}): React.ReactElement {
  const [sel, setSel] = useState(0);

  // 越界钳制（列表静态，仅为防御）；无分页
  const clampedSel = Math.min(sel, Math.max(items.length - 1, 0));
  // 左列宽 = 最长摘要（不做终端宽截断，摘要装配时已压单行）
  const colWidth = Math.max(...items.map((m) => m.label.length), 0);

  useInput((_input, key) => {
    if (key.escape) {
      onSelect(null);
      return;
    }
    if (key.return) {
      const chosen = items[clampedSel];
      if (chosen === undefined) {
        onSelect(null);
        return;
      }
      // 不可回退项（压缩点之前的保真原话）：Enter 退化为仅取回文本
      onSelect(chosen.undoable ? { kind: 'backtrack', count: chosen.count, text: chosen.text } : { kind: 'recall', text: chosen.text });
      return;
    }
    if (key.tab) {
      const chosen = items[clampedSel];
      onSelect(chosen !== undefined ? { kind: 'recall', text: chosen.text } : null);
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
        {t('app.history.title')}
      </Text>
      {items.length === 0 ? (
        <Text color="gray">{t('app.history.empty')}</Text>
      ) : (
        items.map((m, i) => {
          const active = i === clampedSel;
          return (
            <Text key={`${m.count}-${i}`} color={active ? 'cyan' : 'white'} inverse={active}>
              {active ? '› ' : '  '}
              {m.label.padEnd(colWidth)}
              {'  '}
              <Text color="gray">
                {m.undoable ? m.detail : `${m.detail} · ${t('app.history.compacted')}`}
              </Text>
            </Text>
          );
        })
      )}
      <Text color="gray">{t('app.history.hint')}</Text>
    </Box>
  );
}
