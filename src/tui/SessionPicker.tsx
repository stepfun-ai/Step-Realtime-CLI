import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import type { SessionMeta } from '../session/store.js';
import { t } from '../i18n.js';

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

/** 每页展示的会话条数。 */
const PAGE_SIZE = 10;
/** 子 agent 会话区一次展示的条数（只读下钻入口，不做分页）。 */
const SUBAGENT_ROWS = 5;

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
 * 输入即增量过滤（标题+预览，空格分词 AND），↑↓ 移动高亮（分页滚动），
 * 回车恢复选中会话，Esc 放弃开新会话。
 * Delete / Ctrl+D 对高亮会话发起删除，进入 [y/N] 二次确认（不可逆本地文件操作）。
 * r 对高亮会话进入重命名编辑态（模态切换：编辑态下可打印字符进名字草稿而非搜索词，
 * Enter 保存、Esc 取消；保存空名 = 清除自定义名回退标题）。
 * 只读元信息（标题/预览/相对时间/条数），不预载 message 正文——规避读大快照卡死。
 * 注：可打印字符一律进入搜索词（含 d），故删除走 Delete / Ctrl+D 而非裸 d；不支持 k/j 导航。
 * 已知取舍：裸 r 被重命名占用，搜索词无法输入字母 r（与删除避让同一思路：过滤是辅助，操作键优先）。
 */
export function SessionPicker({
  sessions,
  currentId,
  subagents,
  onSelect,
  onDelete,
  onRename,
}: {
  sessions: SessionMeta[];
  /** 当前正在使用的会话 id（禁止删除，删除时给拒绝提示）。 */
  currentId?: string;
  /**
   * 子 agent 会话（只读下钻区，排在主会话之后）：选中即下钻查看历史，不参与删除/重命名。
   * 与主会话共用同一条高亮游标（主会话之后继续往下数）。
   */
  subagents?: SessionMeta[];
  onSelect: (id: string | null) => void;
  /** 删除某会话（落盘删除由上层执行），返回是否删成功。省略时不提供删除能力。 */
  onDelete?: (id: string) => boolean;
  /** 重命名某会话（落盘由上层执行；name 为空串 = 清除自定义名），返回是否改成功。省略时不提供重命名能力。 */
  onRename?: (id: string, name: string) => boolean;
}): React.ReactElement {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  // 删除二次确认态：null = 无待确认；否则为待删会话 id。
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // 重命名编辑态：null = 非编辑态；否则为待改名会话 id，renameDraft 为名字草稿。
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  // 无法删除当前会话时的一次性提示（下次任意键操作清除）。
  const [notice, setNotice] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return sessions;
    return sessions.filter((m) => terms.every((term) => searchKey(m).includes(term)));
  }, [sessions, query]);

  const filteredSubs = useMemo(() => {
    const subs = subagents ?? [];
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return subs;
    return subs.filter((m) => terms.every((term) => searchKey(m).includes(term)));
  }, [subagents, query]);
  const shownSubs = filteredSubs.slice(0, SUBAGENT_ROWS);

  // query 变化后 sel 可能越界，渲染期钳制；页窗口跟随高亮项（只对主会话区分页）
  const total = filtered.length + shownSubs.length;
  const clampedSel = Math.min(sel, Math.max(total - 1, 0));
  const pageStart = Math.floor(Math.min(clampedSel, Math.max(filtered.length - 1, 0)) / PAGE_SIZE) * PAGE_SIZE;
  const page = filtered.slice(pageStart, pageStart + PAGE_SIZE);
  const confirmTarget = confirmId !== null ? sessions.find((m) => m.id === confirmId) : undefined;
  const renameTarget = renameId !== null ? sessions.find((m) => m.id === renameId) : undefined;

  useInput((input, key) => {
    // 重命名编辑态：可打印字符进名字草稿，Enter 保存、Esc 取消，其余导航/删除键不生效
    if (renameId !== null) {
      if (key.escape) {
        setRenameId(null);
        return;
      }
      if (key.return) {
        if (onRename !== undefined) onRename(renameId, renameDraft.trim());
        setRenameId(null);
        return;
      }
      if (key.backspace) {
        setRenameDraft((d) => d.slice(0, -1));
        return;
      }
      if (input !== '' && !key.ctrl && !key.meta) {
        setRenameDraft((d) => d + input);
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
        clampedSel < filtered.length ? filtered[clampedSel] : shownSubs[clampedSel - filtered.length];
      onSelect(chosen !== undefined ? chosen.id : null);
      return;
    }
    const n = Math.max(total, 1);
    if (key.upArrow) {
      setSel((i) => (i - 1 + n) % n);
      return;
    }
    if (key.downArrow) {
      setSel((i) => (i + 1) % n);
      return;
    }
    // Delete / Ctrl+D：对高亮会话发起删除确认（Backspace 仍删搜索词）；子 agent 会话区不提供删除
    if ((key.delete && !key.backspace) || (key.ctrl && input === 'd')) {
      if (onDelete === undefined || clampedSel >= filtered.length) return;
      const target = filtered[clampedSel];
      if (target === undefined) return;
      if (target.id === currentId) {
        setNotice(t('sessionPicker.cannotDeleteCurrent'));
        return;
      }
      setConfirmId(target.id);
      return;
    }
    // r：对高亮会话进入重命名编辑态（草稿预填当前自定义名，无则预填标题便于在其上改写）；
    // 未提供 onRename 或高亮在子 agent 会话区时不拦截，r 按普通可打印字符落入搜索词
    if (input === 'r' && !key.ctrl && !key.meta && onRename !== undefined && clampedSel < filtered.length) {
      const target = filtered[clampedSel];
      if (target === undefined) return;
      setRenameId(target.id);
      setRenameDraft(target.name ?? target.title ?? '');
      return;
    }
    if (key.backspace) {
      setQuery((q) => q.slice(0, -1));
      setSel(0);
      return;
    }
    if (input !== '' && !key.ctrl && !key.meta) {
      setQuery((q) => q + input);
      setSel(0);
    }
  });

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        {t('sessionPicker.title')}
      </Text>
      <Text>
        {t('sessionPicker.searchPrefix')}
        {query === '' ? (
          <Text dimColor>{t('sessionPicker.searchPlaceholder')}</Text>
        ) : (
          <Text color="yellow">{query}</Text>
        )}
      </Text>
      {renameId !== null ? (
        <Box flexDirection="column">
          <Text>
            {t('sessionPicker.renamePrompt', {
              title: renameTarget !== undefined ? sessionDisplayName(renameTarget) : renameId,
            })}
            <Text color="yellow">{renameDraft}</Text>
          </Text>
          <Text color="gray">{t('sessionPicker.renameHint')}</Text>
        </Box>
      ) : null}
      {filtered.length === 0 && shownSubs.length === 0 ? (
        <Text color="gray">{t('sessionPicker.empty')}</Text>
      ) : (
        page.map((m, i) => {
          const active = pageStart + i === clampedSel;
          const label = sessionDisplayName(m);
          const isCurrent = m.id === currentId;
          return (
            <Text key={m.id} color={active ? 'cyan' : 'white'} inverse={active}>
              {active ? '› ' : '  '}
              {label}
              {isCurrent ? <Text color="green">{` ${t('sessionPicker.current')}`}</Text> : null}
              {'  '}
              <Text color="gray">
                {relativeTime(m.updatedAt)} · {t('sessionPicker.count', { count: m.messageCount })}
              </Text>
            </Text>
          );
        })
      )}
      {shownSubs.length > 0 && (
        <Box flexDirection="column">
          <Text color="gray">{t('sessionPicker.subagentsHeader')}</Text>
          {shownSubs.map((m, i) => {
            const active = filtered.length + i === clampedSel;
            const label = sessionDisplayName(m);
            return (
              <Text key={m.id} color={active ? 'cyan' : 'white'} inverse={active}>
                {active ? '› ' : '  '}
                {label}
                {'  '}
                <Text color="gray">
                  {m.agentType ?? '-'} · {m.status ?? '-'} · {relativeTime(m.updatedAt)} ·{' '}
                  {t('sessionPicker.count', { count: m.messageCount })}
                </Text>
              </Text>
            );
          })}
        </Box>
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
