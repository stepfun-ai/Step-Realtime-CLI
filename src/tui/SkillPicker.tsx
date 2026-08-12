import { Box, Text, useInput, useStdout } from 'ink';
import { useMemo, useState } from 'react';
import { TextEditField, type TextEditValue } from './TextEditField.js';
import { t } from '../i18n.js';

/** 空编辑值（清词用）。 */
const EMPTY_EDIT: TextEditValue = { text: '', cursor: 0 };

/** 技能选择器的单条候选项（由 App 从 skillsRef 装配）。 */
export interface SkillPickerItem {
  /** 技能名（Enter 确认后回传给激活逻辑）。 */
  name: string;
  /** 描述（右列显示，灰色）。 */
  description: string;
}

/** 每页展示的技能条数（对齐 ModelPicker）。 */
const PAGE_SIZE = 10;

/** 名称列宽上限（防长名把描述挤出屏幕）。 */
const NAME_COL_MAX = 24;

/** 搜索键：技能名 + 描述，小写后做子串匹配。 */
function searchKey(s: SkillPickerItem): string {
  return `${s.name} ${s.description}`.toLowerCase();
}

/**
 * 交互式技能选择器（/skill 无参唤起，替换输入区）：
 * 列表区：指针 › + 技能名（左列，截断至 NAME_COL_MAX）+ 描述（右列灰色）；
 * ↑↓ 移动（越界 clamp 不循环），输入即增量过滤（名称/描述，空格分词 AND），
 * Backspace 删过滤字，Enter 确认，Esc 取消（有过滤词时先清词）。
 * 页窗口跟随高亮项（整页翻页，对齐 ModelPicker 的块分页）。
 */
export function SkillPicker({
  items,
  onSelect,
}: {
  items: SkillPickerItem[];
  onSelect: (name: string | null) => void;
}): React.ReactElement {
  const { stdout } = useStdout();
  const [query, setQuery] = useState<TextEditValue>(EMPTY_EDIT);
  const [sel, setSel] = useState(0);

  const filtered = useMemo(() => {
    const terms = query.text.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return items;
    return items.filter((s) => terms.every((term) => searchKey(s).includes(term)));
  }, [items, query]);

  // query 变化后 sel 可能越界，渲染期钳制；页窗口跟随高亮项
  const clampedSel = Math.min(sel, Math.max(filtered.length - 1, 0));
  const pageStart = Math.floor(clampedSel / PAGE_SIZE) * PAGE_SIZE;
  const page = filtered.slice(pageStart, pageStart + PAGE_SIZE);
  // 名称列宽 = 当页最长技能名，上限 NAME_COL_MAX
  const nameColW = Math.min(
    Math.max(...page.map((s) => s.name.length), 0),
    NAME_COL_MAX,
  );
  // 描述列宽 = 终端宽 - 名称列 - 指针 - 间隔，防长描述折行失控
  const descColW = Math.max(
    (stdout?.columns ?? 80) - nameColW - 4,
    8,
  );

  useInput((_input, key) => {
    if (key.escape) {
      if (query.text !== '') {
        setQuery(EMPTY_EDIT);
        setSel(0);
        return;
      }
      onSelect(null);
      return;
    }
    if (key.return) {
      const chosen = filtered[clampedSel];
      onSelect(chosen !== undefined ? chosen.name : null);
      return;
    }
    if (key.upArrow) {
      setSel((i) => Math.max(i - 1, 0));
      return;
    }
    if (key.downArrow) {
      setSel((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
      return;
    }
    // 文本编辑（←→/Home/End/退格/Delete/可打印字符）归 TextEditField
  });

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        {t('skillPicker.title')}
      </Text>
      <Text>
        {t('skillPicker.searchPrefix')}
        <TextEditField
          value={query}
          onChange={(v) => {
            setQuery(v);
            setSel(0);
          }}
          placeholder={t('skillPicker.searchPlaceholder')}
        />
      </Text>
      {filtered.length === 0 ? (
        <Text color="gray">{t('skillPicker.empty')}</Text>
      ) : (
        page.map((s, i) => {
          const active = pageStart + i === clampedSel;
          const name = s.name.length > nameColW ? s.name.slice(0, nameColW) : s.name.padEnd(nameColW);
          const desc = s.description.length > descColW ? s.description.slice(0, descColW) : s.description;
          return (
            <Text key={s.name} color={active ? 'cyan' : 'white'} inverse={active}>
              {active ? '› ' : '  '}
              {name}
              {'  '}
              <Text color="gray">{desc}</Text>
            </Text>
          );
        })
      )}
      {filtered.length > PAGE_SIZE && (
        <Text color="gray">
          {t('sessionPicker.pageInfo', {
            start: pageStart + 1,
            end: Math.min(pageStart + PAGE_SIZE, filtered.length),
            total: filtered.length,
          })}
        </Text>
      )}
      <Text color="gray">{t('skillPicker.hint')}</Text>
    </Box>
  );
}
