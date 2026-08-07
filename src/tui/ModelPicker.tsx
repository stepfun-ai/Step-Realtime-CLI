import { Box, Text, useInput, useStdout } from 'ink';
import { useMemo, useState } from 'react';
import { displayWidth, padEndByWidth } from './liveBudget.js';
import { t } from '../i18n.js';

/** 模型选择器的单条候选项（由 App 从 [models.<别名>] 表装配）。 */
export interface ModelPickerItem {
  /** 别名（Enter 确认后回传给切换逻辑）。 */
  alias: string;
  /** 左列显示名（displayName ?? 别名）。 */
  label: string;
  /** 右列渠道名（entry.provider ?? 顶层 provider，灰色显示）。 */
  channel: string;
  /** 是否当前生效模型（后缀 ← 当前 标记）。 */
  current: boolean;
}

/**
 * 装配模型选择器候选清单（纯函数，便于测试钉住「当前」判定）。
 *
 * 「当前」按别名判定，不按真实模型 id：多个别名可指向同一 id（如 step37 / step37-plan 同为
 * step-3.7-flash、仅 provider 不同），按 id 判定会把这些别名全部误标为当前。真正的「当前」
 * 是当前激活的那个别名（currentAlias），唯一；裸 id 直切时 currentAlias 为 null，无别名标当前
 *（此时用的是顶层默认 provider，不是任何别名的渠道绑定，标谁都不准确）。
 */
export function buildModelPickerItems(
  models: Record<string, { model?: string; provider?: string; displayName?: string }>,
  currentAlias: string | null,
  defaultProvider: string,
): ModelPickerItem[] {
  return Object.entries(models).map(([alias, entry]) => ({
    alias,
    label: entry.displayName ?? alias,
    channel: entry.provider ?? defaultProvider,
    current: currentAlias !== null && alias === currentAlias,
  }));
}

/** 渠道 tab 的「全部」id（恒第一 tab，不做渠道预过滤）。 */
const ALL_TAB = 'all';

/** 每个 tab 独立记忆的视图状态（切 tab 时保存/恢复）。 */
interface TabViewState {
  sel: number;
  query: string;
}

/** 搜索键：别名 + 显示名 + 渠道名，小写后做子串匹配。 */
function searchKey(m: ModelPickerItem): string {
  return `${m.alias} ${m.label} ${m.channel}`.toLowerCase();
}

/**
 * 交互式模型选择器（/model 无参唤起，替换输入区）：
 * 顶部渠道 tab 条：全部 恒第一，其余渠道按 items 首现顺序去重，Tab / Shift+Tab 取模回卷切换；
 * 每个 tab 独立记忆光标位置与过滤词，切换时保存/恢复。渠道 tab 是结构性预过滤
 * （只留该渠道条目），之上再叠加输入过滤（别名/显示名/渠道，空格分词 AND）。
 * 所有模型同属一个渠道时退化为无 tab 条的扁平列表，Tab 键不消费，行为与旧版一致。
 * 列表区：指针 › + 显示名（左列）+ 渠道名（右列灰色）+ 当前项 ← 当前 后缀；
 * ↑↓ 移动（越界 clamp 不循环），Backspace 删过滤字，Enter 确认，Esc 取消（有过滤词时先清词）。
 * tab 条总宽超终端时右端截断并加 … 占位（v1 不做滚动窗口）。
 * 会话已有历史时顶部显示 prompt cache 失效警告。
 * initialChannel 用于「新增渠道后自动拉起并预选到该渠道 tab」的场景，缺省从「全部」起。
 *
 * 可见条数由上层通过 visibleRows 传入；省略时默认 10 条（历史行为），
 * 与 SessionPicker 同一设计原则——组件内不读终端尺寸，行数预算与实际渲染用同一组数。
 */
export function ModelPicker({
  items,
  hasHistory,
  onSelect,
  initialChannel,
  visibleRows,
}: {
  items: ModelPickerItem[];
  /** 会话已有历史时为 true，顶部显示 cache 失效警告。 */
  hasHistory: boolean;
  onSelect: (alias: string | null, sessionOnly?: boolean) => void;
  /** 打开时预选到对应渠道 tab（无该渠道 tab 时退回「全部」）；缺省行为不变。 */
  initialChannel?: string;
  /** 列表区屏幕可见条数（上层按终端行数解出）；省略用兜底值 10（历史行为）。 */
  visibleRows?: number;
}): React.ReactElement {
  const { stdout } = useStdout();

  // 渠道按 items 首现顺序去重；'all' 恒第一 tab。仅一个渠道时不渲染 tab 条、不消费 Tab 键
  const channels = useMemo(() => {
    const seen: string[] = [];
    for (const m of items) {
      if (!seen.includes(m.channel)) seen.push(m.channel);
    }
    return seen;
  }, [items]);
  const [activeTab, setActiveTab] = useState(() =>
    initialChannel !== undefined && channels.includes(initialChannel) ? initialChannel : ALL_TAB,
  );
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [tabStates, setTabStates] = useState<Record<string, TabViewState>>({});
  const showTabs = channels.length > 1;
  const tabs = useMemo(() => [ALL_TAB, ...channels], [channels]);

  // 渠道结构性预过滤（非 all tab 只留该渠道条目），之上叠加现有 query 过滤
  const channelItems = useMemo(
    () => (activeTab === ALL_TAB ? items : items.filter((m) => m.channel === activeTab)),
    [items, activeTab],
  );
  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return channelItems;
    return channelItems.filter((m) => terms.every((term) => searchKey(m).includes(term)));
  }, [channelItems, query]);

  // 居中锚定滑动窗口：高亮往哪移窗口就往哪滑，高亮始终落在窗口中部。
  // 不用整页翻页，因为那样游标跨页时整屏条目会一次性换掉、高亮从末行弹回首行。
  const pageSize = visibleRows ?? 10;
  const clampedSel = Math.min(sel, Math.max(filtered.length - 1, 0));
  const windowStart = Math.max(
    0,
    Math.min(clampedSel - Math.floor(pageSize / 2), Math.max(0, filtered.length - pageSize)),
  );
  const page = filtered.slice(windowStart, windowStart + pageSize);

  // 左列宽：当前页最长显示名的显示宽度（宽字符按 2 列），上限终端宽一半（防长名把渠道列挤出屏幕）
  const colWidth = Math.min(
    Math.max(...page.map((m) => displayWidth(m.label)), 0),
    Math.max(Math.floor((stdout?.columns ?? 80) / 2), 8),
  );

  // tab 条右端截断：可用宽 = 终端列数 - 边框/padding 占用 - 余量；放不下的 tab 整体省略，末尾加 …
  const barMaxWidth = Math.max((stdout?.columns ?? 80) - 6, 8);
  const tabBar = useMemo(() => {
    const segs: { id: string; label: string }[] = [];
    let used = 0;
    let truncated = false;
    for (const id of tabs) {
      const label = id === ALL_TAB ? t('modelPicker.tabAll') : id;
      const width = label.length + (segs.length > 0 ? 2 : 0);
      // 截断时还要给 … 留 2 列（空格 + 省略号）
      if (used + width > barMaxWidth - 2) {
        truncated = true;
        break;
      }
      used += width;
      segs.push({ id, label });
    }
    return { segs, truncated };
  }, [tabs, barMaxWidth]);

  /** Tab / Shift+Tab 取模回卷切换：保存当前 tab 视图状态，恢复目标 tab 的。 */
  const switchTab = (dir: 1 | -1): void => {
    const idx = tabs.indexOf(activeTab);
    const next = tabs[(idx + dir + tabs.length) % tabs.length]!;
    setTabStates((m) => ({ ...m, [activeTab]: { sel: clampedSel, query } }));
    const saved = tabStates[next];
    setSel(saved?.sel ?? 0);
    setQuery(saved?.query ?? '');
    setActiveTab(next);
  };

  useInput((input, key) => {
    // Tab / Shift+Tab 切渠道 tab（仅多渠道时消费）
    if (key.tab && showTabs) {
      switchTab(key.shift ? -1 : 1);
      return;
    }
    if (key.escape) {
      // 有过滤词先清词，再按一次才取消（词是 per-tab 的）
      if (query !== '') {
        setQuery('');
        setSel(0);
        return;
      }
      onSelect(null);
      return;
    }
    if (key.return) {
      const chosen = filtered[clampedSel];
      onSelect(chosen !== undefined ? chosen.alias : null, key.shift);
      return;
    }
    // ↑↓ clamp 移动：越界停住不循环
    if (key.upArrow) {
      setSel((i) => Math.max(i - 1, 0));
      return;
    }
    if (key.downArrow) {
      setSel((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setSel(0);
      return;
    }
    if (input !== '' && !key.ctrl && !key.meta && !key.tab) {
      setQuery((q) => q + input);
      setSel(0);
    }
  });

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        {t('modelPicker.title')}
      </Text>
      {hasHistory && <Text color="yellow">{t('modelPicker.cacheWarning')}</Text>}
      <Text>
        {t('modelPicker.searchPrefix')}
        {query === '' ? (
          <Text dimColor>{t('modelPicker.searchPlaceholder')}</Text>
        ) : (
          <Text color="yellow">{query}</Text>
        )}
      </Text>
      {showTabs && (
        <Text>
          {tabBar.segs.map((seg, i) => (
            <Text key={seg.id}>
              {i > 0 ? '  ' : ''}
              {seg.id === activeTab ? (
                <Text inverse bold>
                  {seg.label}
                </Text>
              ) : (
                <Text color="gray">{seg.label}</Text>
              )}
            </Text>
          ))}
          {tabBar.truncated ? <Text color="gray"> …</Text> : null}
        </Text>
      )}
      {filtered.length === 0 ? (
        <Text color="gray">{t('modelPicker.empty')}</Text>
      ) : (
        page.map((m, i) => {
          const active = windowStart + i === clampedSel;
          // 用 displayWidth 截断/填充，CJK 宽字符按 2 列计，避免折行或截断位置错误
          const label = padEndByWidth(m.label, colWidth);
          return (
            <Text key={m.alias} color={active ? 'cyan' : 'white'} inverse={active}>
              {active ? '› ' : '  '}
              {label}
              {'  '}
              <Text color="gray">{m.channel}</Text>
              {m.current ? <Text color="green">{` ${t('modelPicker.current')}`}</Text> : null}
            </Text>
          );
        })
      )}
      {filtered.length > pageSize && (
        <Text color="gray">
          {t('sessionPicker.pageInfo', {
            start: windowStart + 1,
            end: Math.min(windowStart + pageSize, filtered.length),
            total: filtered.length,
          })}
        </Text>
      )}
      <Text color="gray">{t('modelPicker.hint')}</Text>
    </Box>
  );
}
