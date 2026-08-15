import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import type { SessionMeta } from '../session/store.js';
import { t } from '../i18n.js';
import { displayWidth } from '../chat/liveBudget.js';
import { TextEditField, type TextEditValue } from './TextEditField.js';

/** 空编辑值（清词用）。 */
const EMPTY_EDIT: TextEditValue = { text: '', cursor: 0 };
/** 字符串转编辑值：光标归尾（rename 预填草稿后便于直接在末尾改写）。 */
const toEditValue = (s: string): TextEditValue => ({ text: s, cursor: Array.from(s).length });

/**
 * 相对时间小工具：<60s 刚刚、<60min N 分钟前、<24h N 小时前、<30d N 天前，
 * 否则显示 YYYY-MM-DD。非法时间原样返回。
 */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const sec = Math.floor((Date.now() - then) / 1000);
  if (sec < 60) return t('time.justNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('time.minutesAgo', { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('time.hoursAgo', { count: hr });
  const day = Math.floor(hr / 24);
  if (day < 30) return t('time.daysAgo', { count: day });
  const d = new Date(then);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * 屏幕可见条数的兜底值：终端行数未知时使用（非 TTY、测试环境的 mock stdout 无 rows）。
 * 与历史行为一致，保证不感知终端尺寸的调用方拿到与从前相同的渲染结果。
 */
const FALLBACK_VISIBLE_ROWS = 10;
/**
 * 可见条数下限：再小的终端也至少展示这么多。
 * 取 3 而不是 1 的理由——列表少于 3 条时已无法浏览，「能用但会越线闪一下」优于「不闪但没法用」。
 */
export const MIN_VISIBLE_ROWS = 3;
/**
 * 可见条数上限：更大的终端不再增加。
 * 超过这个量时逐条扫视的成本已高于直接输入搜索词，继续加高只是让一屏更长。
 */
export const MAX_VISIBLE_ROWS = 12;
/**
 * 选择器自身的固定开销行数（与下方 render 结构一一对应，改结构必须同步改这个数）：
 * marginTop 1 + 上下边框 2 + 标题 1 + 搜索行 1 + 分页行 1 + 底部块 2（重命名两行为上界）。
 */
export const PICKER_CHROME_ROWS = 8;
/** 子 agent 会话区一次展示的条数（只读下钻入口，不做分页）。 */
const SUBAGENT_ROWS = 5;

/** 子 agent 会话区占用的行数：有则区头 1 行 + 展示行（每条已截断为单行）。预算与自适应共用此口径。 */
export function subagentSectionRows(count: number): number {
  return count > 0 ? 1 + Math.min(count, SUBAGENT_ROWS) : 0;
}

/**
 * 按终端可用行数解出屏幕可见条数。
 *
 * 存在的理由：条目数若是固定常量，在足够小的终端上帧总高必然越过「终端行数 − 1」这条红线，
 * 越线会让 Ink 放弃原地重绘、改为全量清屏，表现为每次移动高亮整屏抖动，并连带清掉 scrollback。
 * 行数预算算得多准都挡不住这种情况——内容量本身必须跟着视口走。
 *
 * @param termRows 终端总行数；undefined（非 TTY / 测试）时不做自适应，返回兜底值
 * @param subagentCount 子 agent 会话数，用于折算该区占用的行数
 * @param reservedRows 选择器之外必须留出的行数（状态栏 + 动态区最小高度）
 */
export function resolveVisibleRows(
  termRows: number | undefined,
  subagentCount: number,
  reservedRows: number,
): number {
  if (termRows === undefined) return FALLBACK_VISIBLE_ROWS;
  const avail = termRows - 1 - PICKER_CHROME_ROWS - subagentSectionRows(subagentCount) - reservedRows;
  return Math.min(Math.max(avail, MIN_VISIBLE_ROWS), MAX_VISIBLE_ROWS);
}

/**
 * 按终端显示宽度截断，超出加省略号（宽字符按 2 列计）。
 *
 * 会话标题由对话首句派生，长度不受控（实测最长 101 个显示宽度）。若任其折行，
 * 单条占几行就成了内容的函数，行数预算不再可算——所以标题一律压成单行。
 * 渲染侧另有 wrap="truncate" 兜底，两层的分工是：这里负责视觉（省略号、给标题留合理宽度），
 * 那里负责「即使这里算错也不会折行」。
 */
function clampToWidth(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (displayWidth(text) <= budget) return text;
  let width = 0;
  let out = '';
  for (const ch of text) {
    const chWidth = displayWidth(ch);
    // 留 1 列给省略号
    if (width + chWidth > budget - 1) break;
    out += ch;
    width += chWidth;
  }
  return `${out}…`;
}

/** 搜索键：自定义名 + 标题 + 首条消息预览，小写后做子串匹配。 */
function searchKey(m: SessionMeta): string {
  return `${m.name ?? ''} ${m.title ?? ''} ${m.preview ?? ''}`.toLowerCase();
}

/** 展示名口径：自定义名优先，其次派生标题，最后回退 id。 */
export function sessionDisplayName(m: SessionMeta): string {
  if (m.name !== undefined && m.name !== '') return m.name;
  return m.title !== undefined && m.title !== '' ? m.title : m.id;
}

/**
 * 交互式会话选择器：
 * 输入即增量过滤（标题+预览，空格分词 AND），↑↓ 移动高亮（滑动窗口跟随，到边界钳制不回绕），
 * 回车恢复选中会话，Esc 放弃开新会话。
 * Delete / Ctrl+D 对高亮会话发起删除，进入 [y/N] 二次确认（不可逆本地文件操作）。
 * r 对高亮会话进入重命名编辑态（模态切换：编辑态下可打印字符进名字草稿而非搜索词，
 * Enter 保存、Esc 取消；保存空名 = 清除自定义名回退标题）。
 * 只读元信息（标题/预览/相对时间/条数），不预载 message 正文——规避读大快照卡死。
 * 注：可打印字符一律进入搜索词（含 d），故删除走 Delete / Ctrl+D 而非裸 d；不支持 k/j 导航。
 * 已知取舍：裸 r 被重命名占用，搜索词无法输入字母 r（与删除避让同一思路：过滤是辅助，操作键优先）。
 *
 * 可见条数与标题宽度都由上层传入，不在组件内读终端尺寸——这样行数预算与实际渲染用的是同一组数，
 * 两侧不会各算一套而漂移。两个入参都省略时退化为固定 10 条、标题不截断的历史行为。
 */
export function SessionPicker({
  sessions,
  currentId,
  subagents,
  visibleRows,
  innerWidth,
  onSelect,
  onDelete,
  onRename,
  titleKey,
}: {
  sessions: SessionMeta[];
  /** 当前正在使用的会话 id（禁止删除，删除时给拒绝提示）。 */
  currentId?: string;
  /**
   * 子 agent 会话（只读下钻区，排在主会话之后）：选中即下钻查看历史，不参与删除/重命名。
   * 与主会话共用同一条高亮游标（主会话之后继续往下数）。
   */
  subagents?: SessionMeta[];
  /** 主会话区屏幕可见条数（上层按终端行数解出，见 resolveVisibleRows）；省略用兜底值。 */
  visibleRows?: number;
  /** 弹层内容区宽度（列）；省略则标题不按宽度截断，退化为历史行为。 */
  innerWidth?: number;
  onSelect: (id: string | null) => void;
  /** 删除某会话（落盘删除由上层执行），返回是否删成功。省略时不提供删除能力。 */
  onDelete?: (id: string) => boolean;
  /** 重命名某会话（落盘由上层执行；name 为空串 = 清除自定义名），返回是否改成功。省略时不提供重命名能力。 */
  onRename?: (id: string, name: string) => boolean;
  /** 标题 i18n 键（省略用 sessionPicker.title；/agents 下钻模式传 sessionPicker.agentsTitle）。 */
  titleKey?: string;
}): React.ReactElement {
  const [query, setQuery] = useState<TextEditValue>(EMPTY_EDIT);
  const [sel, setSel] = useState(0);
  // 删除二次确认态：null = 无待确认；否则为待删会话 id。
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // 重命名编辑态：null = 非编辑态；否则为待改名会话 id，renameDraft 为名字草稿（含光标）。
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<TextEditValue>(EMPTY_EDIT);
  // 无法删除当前会话时的一次性提示（下次任意键操作清除）。
  const [notice, setNotice] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const terms = query.text.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return sessions;
    return sessions.filter((m) => terms.every((term) => searchKey(m).includes(term)));
  }, [sessions, query]);

  const filteredSubs = useMemo(() => {
    const subs = subagents ?? [];
    const terms = query.text.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return subs;
    return subs.filter((m) => terms.every((term) => searchKey(m).includes(term)));
  }, [subagents, query]);

  // query 变化后 sel 可能越界，渲染期钳制
  // 游标走全程（主会话 + 全部子 agent 会话），不是只走可见的前 5 条子会话。
  const total = filtered.length + filteredSubs.length;
  const clampedSel = Math.min(sel, Math.max(total - 1, 0));
  // 主会话区窗口：居中锚定的滑动窗口——高亮往哪移窗口就往哪滑，高亮始终落在窗口中部。
  // 不用整页翻页，因为那样游标跨页时整屏条目会一次性换掉、高亮从末行弹回首行；
  // 居中锚定天然给高亮留出上下余量，也就不需要额外的边缘余量参数。
  const visible = visibleRows ?? FALLBACK_VISIBLE_ROWS;
  const mainSel = Math.min(clampedSel, Math.max(filtered.length - 1, 0));
  const windowStart = Math.max(
    0,
    Math.min(mainSel - Math.floor(visible / 2), Math.max(0, filtered.length - visible)),
  );
  const page = filtered.slice(windowStart, windowStart + visible);
  // 子 agent 区同样居中锚定滑动窗口：显示固定 5 行，但游标可在全部子会话中移动，
  // 窗口跟随游标（此前 slice(0, 5) 硬截断，第 6 条起永远无法选中——待办 #25）。
  const subSel = clampedSel - filtered.length;
  const subWindowStart = Math.max(
    0,
    Math.min(subSel - Math.floor(SUBAGENT_ROWS / 2), Math.max(0, filteredSubs.length - SUBAGENT_ROWS)),
  );
  const shownSubs = filteredSubs.slice(subWindowStart, subWindowStart + SUBAGENT_ROWS);
  const confirmTarget = confirmId !== null ? sessions.find((m) => m.id === confirmId) : undefined;
  const renameTarget = renameId !== null ? sessions.find((m) => m.id === renameId) : undefined;

  useInput((input, key) => {
    // 重命名编辑态：Enter 保存、Esc 取消；文本编辑归 rename TextEditField，
    // 导航/删除键不生效（此分支提前 return，下方导航逻辑够不到）
    if (renameId !== null) {
      if (key.escape) {
        setRenameId(null);
        return;
      }
      if (key.return) {
        if (onRename !== undefined) onRename(renameId, renameDraft.text.trim());
        setRenameId(null);
        return;
      }
      return;
    }
    // 删除二次确认态：只认 y / n / Esc，其余按键忽略（防误删）
    if (confirmId !== null) {
      if (input === 'y' || input === 'Y') {
        if (onDelete !== undefined) onDelete(confirmId);
        setConfirmId(null);
        setSel(0);
        return;
      }
      if (input === 'n' || input === 'N' || key.escape) {
        setConfirmId(null);
        return;
      }
      return;
    }
    if (notice !== null) setNotice(null);
    if (key.escape) {
      onSelect(null);
      return;
    }
    if (key.return) {
      // 游标跨两个区：主会话区之后是子 agent 会话区，统一按 id 上抛，由上层区分行为
      const chosen =
        clampedSel < filtered.length ? filtered[clampedSel] : filteredSubs[clampedSel - filtered.length];
      onSelect(chosen !== undefined ? chosen.id : null);
      return;
    }
    const n = Math.max(total, 1);
    // 到边界钳制不回绕：回绕会让「第一条按 ↑」直接跳到末条、窗口整段滑到列表尾，
    // 视觉上等同于画面突变；且本仓另一个选择器也是钳制，两处行为需一致。
    if (key.upArrow) {
      setSel((i) => Math.max(Math.min(i, n - 1) - 1, 0));
      return;
    }
    if (key.downArrow) {
      setSel((i) => Math.min(i + 1, n - 1));
      return;
    }
    // Delete / Ctrl+D 与 r 的拦截逻辑移入搜索 TextEditField 的 onInterceptKey——
    // Ink 的 input 事件是广播，两个 useInput 同激活时同一按键会被处理两次，
    // 这些键的归属必须在编辑器侧拦下，此处不再处理。
    // 文本编辑（←→/Home/End/退格/Delete/可打印字符）同样归 TextEditField。
  });

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        {t(titleKey ?? 'sessionPicker.title')}
      </Text>
      <Text wrap="truncate-start">
        {t('sessionPicker.searchPrefix')}
        <TextEditField
          value={query}
          onChange={(v) => {
            setQuery(v);
            setSel(0);
          }}
          placeholder={t('sessionPicker.searchPlaceholder')}
          isActive={renameId === null && confirmId === null}
          onInterceptKey={(input, key) => {
            // Delete / Ctrl+D：对高亮会话发起删除确认（子 agent 会话区不提供删除）；
            // 未提供 onDelete 或高亮在子会话区时不拦截，Delete 落入文本编辑（删光标后字符）
            if ((key.delete && !key.backspace) || (key.ctrl && input === 'd')) {
              if (onDelete === undefined || clampedSel >= filtered.length) return false;
              const target = filtered[clampedSel];
              if (target === undefined) return false;
              if (target.id === currentId) {
                setNotice(t('sessionPicker.cannotDeleteCurrent'));
                return true;
              }
              setConfirmId(target.id);
              return true;
            }
            // r：对高亮会话进入重命名编辑态（草稿预填当前自定义名，无则预填标题便于在其上改写）；
            // 未提供 onRename 或高亮在子 agent 会话区时不拦截，r 按普通可打印字符落入搜索词
            if (input === 'r' && key.ctrl !== true && key.meta !== true && onRename !== undefined && clampedSel < filtered.length) {
              const target = filtered[clampedSel];
              if (target === undefined) return false;
              setRenameId(target.id);
              setRenameDraft(toEditValue(target.name ?? target.title ?? ''));
              return true;
            }
            return false;
          }}
        />
      </Text>
      {renameId !== null ? (
        <Box flexDirection="column">
          <Text>
            {t('sessionPicker.renamePrompt', {
              title: renameTarget !== undefined ? sessionDisplayName(renameTarget) : renameId,
            })}
            <TextEditField value={renameDraft} onChange={setRenameDraft} isActive={renameId !== null} />
          </Text>
          <Text color="gray">{t('sessionPicker.renameHint')}</Text>
        </Box>
      ) : null}
      {filtered.length === 0 && shownSubs.length === 0 ? (
        <Text color="gray">{t('sessionPicker.empty')}</Text>
      ) : (
        page.map((m, i) => {
          const active = windowStart + i === clampedSel;
          const isCurrent = m.id === currentId;
          const currentTag = isCurrent ? ` ${t('sessionPicker.current')}` : '';
          const metaText = `${relativeTime(m.updatedAt)} · ${t('sessionPicker.count', { count: m.messageCount })}`;
          // 标题可用宽度 = 内宽 − 指针 2 − 当前标记 − 间隔 2 − 右侧元信息；宽度未知时不截断
          const label =
            innerWidth === undefined
              ? sessionDisplayName(m)
              : clampToWidth(
                  sessionDisplayName(m),
                  Math.max(8, innerWidth - 2 - displayWidth(currentTag) - 2 - displayWidth(metaText)),
                );
          return (
            <Text key={m.id} color={active ? 'cyan' : 'white'} inverse={active} wrap="truncate">
              {active ? '› ' : '  '}
              {label}
              {isCurrent ? <Text color="green">{currentTag}</Text> : null}
              {'  '}
              <Text color="gray">{metaText}</Text>
            </Text>
          );
        })
      )}
      {shownSubs.length > 0 && (
        <Box flexDirection="column">
          <Text color="gray" wrap="truncate">
            {t('sessionPicker.subagentsHeader')}
            {filteredSubs.length > SUBAGENT_ROWS
              ? ` ${subWindowStart + 1}-${Math.min(subWindowStart + SUBAGENT_ROWS, filteredSubs.length)}/${filteredSubs.length}`
              : ''}
          </Text>
          {shownSubs.map((m, i) => {
            const active = filtered.length + subWindowStart + i === clampedSel;
            // 子会话行的元信息比主会话长（多 agentType 与 status），标题预算相应更紧
            const metaText = `${m.agentType ?? '-'} · ${m.status ?? '-'} · ${relativeTime(m.updatedAt)} · ${t('sessionPicker.count', { count: m.messageCount })}`;
            const label =
              innerWidth === undefined
                ? sessionDisplayName(m)
                : clampToWidth(sessionDisplayName(m), Math.max(8, innerWidth - 2 - 2 - displayWidth(metaText)));
            return (
              <Text key={m.id} color={active ? 'cyan' : 'white'} inverse={active} wrap="truncate">
                {active ? '› ' : '  '}
                {label}
                {'  '}
                <Text color="gray">{metaText}</Text>
              </Text>
            );
          })}
        </Box>
      )}
      {filtered.length > visible && (
        <Text color="gray" wrap="truncate">
          {t('sessionPicker.pageInfo', {
            start: windowStart + 1,
            end: Math.min(windowStart + visible, filtered.length),
            total: filtered.length,
          })}
        </Text>
      )}
      {confirmId !== null ? (
        <Text color="red">
          {t('sessionPicker.deleteConfirm', {
            title: confirmTarget !== undefined ? sessionDisplayName(confirmTarget) : confirmId,
          })}
        </Text>
      ) : notice !== null ? (
        <Text color="yellow">{notice}</Text>
      ) : renameId === null && (onDelete !== undefined || onRename !== undefined) ? (
        <Text color="gray">
          {onRename !== undefined ? t('sessionPicker.actionHint') : t('sessionPicker.deleteHint')}
        </Text>
      ) : null}
    </Box>
  );
}
