import { Box, Text } from 'ink';
import { t } from '../i18n.js';
import { LiveViewport } from './LiveViewport.js';
import { Markdown } from './Markdown.js';
import { ToolCall } from './ToolCall.js';
import { GoalPanel } from './GoalPanel.js';
import { CronCard } from './CronCard.js';
import type { DisplayItem } from './types.js';

/** thinking 定稿块最多展示的行数，超出折叠为「…（共 N 行）」（不做交互式展开器）。 */
export const THINKING_MAX_LINES = 5;
/** 流式期状态行思考预览的尾部行数。 */
export const THINKING_PREVIEW_LINES = 3;

/**
 * 流式期思考预览（挂在动态区状态行位置，不进历史区）：
 * 「思考中…」+ 尾部数行暗色滚动预览；思考完成后由 App 落成 kind:'thinking' 定稿条目。
 * text 为空即「思考在途但模型不吐可见思考」（只吐 signature 的无痕思考）：只出标题行，
 * 让忙碌态可区分「模型在想」与「卡住了」。
 */
export function ThinkingPreview({ text, maxLines = THINKING_PREVIEW_LINES }: { text: string; maxLines?: number }): React.ReactElement {
  // maxLines 由 App 的 chrome 降级预算给出（可能小于默认值）；保底 1 行避免 slice(-0) 全量返回
  const tail = text === '' ? [] : text.split('\n').slice(-Math.max(maxLines, 1));
  return (
    <Box flexDirection="column">
      <Text color="gray" wrap="truncate">{t('thinking.streaming')}</Text>
      {tail.map((line, i) => (
        // 逐行 key 用下标即可：预览整体随流式增量重渲，无复用诉求；
        // wrap=truncate：长行截断不折行，高度预算按行数精确成立
        <Text key={i} color="gray" wrap="truncate">
          {line}
        </Text>
      ))}
    </Box>
  );
}

/**
 * 计算已「定稿」的前缀长度：items[0, n) 可挂进 ink <Static>（append-only，不再重渲），
 * items[n, len) 留在动态区。判定必须保守（宁少勿多），一旦进 Static 就不会再更新。
 *
 * 规则（仅 busy 时才可能有未完条目；非 busy 时回合已结束，全部定稿——
 * 包括 abort 残留的 status === 'running' 工具，此后不会再有任何事件更新它）：
 * - 仅**有效末尾**的 assistant 仍可能流式增长：text 事件只往末尾 assistant 追加，
 *   UI 侧提示（非 boundary 的 note，如队列回执）透明——assistant 后只跟这类提示时
 *   它仍未闭合，流式正文会越过提示续接（见 appendStreamText）；
 *   除透明提示外，其后一旦出现任何条目，新文本会另开 assistant 条目，旧条物理上不可能再增长。
 *   busy 期间以 transient（关高亮）渲染，形态未定，留动态区。
 *   非末尾的 assistant 即时定稿——长正文流完进入工具执行期后不再被窗口化压整轮，
 *   「已隐藏 N 行」随定稿释放，全文立即进 scrollback。
 * - busy 时 status === 'running' 的 tool 条目还会被 tool_end 更新；
 *   workflow 面板的所有推进（onWorkflowStep / wf- 子 agent 事件）都经 activeWorkflowRef
 *   门控，tool_end 时该引用同步出栈，因此 status 离开 running 后面板即冻结，可安全定稿。
 */
export function countSettledItems(items: DisplayItem[], busy: boolean): number {
  if (!busy) return items.length;
  let settled = items.length;
  // 有效末尾：UI 侧提示（非 boundary 的 note）透明——assistant 后只跟这类提示时
  // 它仍可能流式增长（流式正文会越过提示续接，见 appendStreamText）
  let tail = items.length - 1;
  while (tail >= 0) {
    const it = items[tail]!;
    if (it.kind === 'note' && it.boundary !== true) tail -= 1;
    else break;
  }
  if (tail >= 0 && items[tail]!.kind === 'assistant') {
    settled = tail;
  }
  // 运行中的工具（含 workflow 面板运行中）：后续还有 tool_end / 步骤事件更新
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.kind === 'tool' && it.status === 'running') {
      settled = Math.min(settled, i);
    }
  }
  return settled;
}

/**
 * 流式正文追加（applyEvent 的 text 事件）：末尾是 assistant 则续写；末尾是 UI 侧提示
 * （非 boundary 的 note，如「已加入发送队列」回执、busy 中即时执行的斜杠命令输出）
 * 则越过连续的提示续接上一条 assistant——提示是 UI 侧插入，不构成消息边界，
 * 一条流式消息不应被劈成两截显示（提示保持在其后，位置不动）。
 * 其余情况（boundary note、工具、thinking 等在尾）另开新 assistant 条目。
 */
export function appendStreamText(items: DisplayItem[], text: string): DisplayItem[] {
  const next = [...items];
  const last = next[next.length - 1];
  if (last !== undefined && last.kind === 'assistant') {
    next[next.length - 1] = { ...last, text: last.text + text };
    return next;
  }
  let i = next.length - 1;
  while (i >= 0) {
    const it = next[i]!;
    if (it.kind === 'note' && it.boundary !== true) i -= 1;
    else break;
  }
  if (i >= 0 && i < next.length - 1 && next[i]!.kind === 'assistant') {
    const a = next[i] as Extract<DisplayItem, { kind: 'assistant' }>;
    next[i] = { ...a, text: a.text + text };
    return next;
  }
  next.push({ kind: 'assistant', text });
  return next;
}

/**
 * 渲染单条会话条目。Static 区（定稿历史）与动态区（在途尾部）共用这个组件，
 * 保证条目定稿前后渲染输出逐像素一致。key 由调用方挂在根节点上。
 */
export function MessageItem({
  item,
  expanded,
  transient = false,
  termWidth,
}: {
  item: DisplayItem;
  expanded: boolean;
  /** 流式中的最后一条 assistant 用 transient（关语法高亮，避免闪烁）；完成后上高亮。 */
  transient?: boolean;
  termWidth?: number;
}): React.ReactElement {
  switch (item.kind) {
    case 'user':
      // 正文必须包一层 Box 防 Ink squash：两个 Text 兄弟会被合并成一个文本块统一折行，
      // '› ' 尾空格落在断行点时被吞、续行只剩 1 空格（实测：长行/多行输入排版错位）。
      // 包 Box 后正文在自己的 Yoga 盒子里折行，续行稳定保持 2 列悬挂缩进。
      return (
        <Box marginTop={1}>
          <Text color="blue" bold>
            {'› '}
          </Text>
          <Box flexShrink={1}>
            <Text color="yellow">{item.text}</Text>
          </Box>
        </Box>
      );
    case 'assistant':
      return (
        <Box marginTop={1}>
          <Markdown text={item.text} transient={transient} width={termWidth} />
        </Box>
      );
    case 'thinking': {
      // 思考定稿块：暗色斜体，折叠态最多前 5 行、超出折叠为「…（共 N 行）」；
      // expanded（Ctrl+O 查看器）铺全文，与工具输出的 expanded 语义对齐
      const lines = item.text.split('\n');
      const shown = expanded ? lines : lines.slice(0, THINKING_MAX_LINES);
      return (
        <Box marginTop={1} flexDirection="column">
          {shown.map((line, i) => (
            <Text key={i} color="gray" italic>
              {line}
            </Text>
          ))}
          {!expanded && lines.length > THINKING_MAX_LINES ? (
            <Text color="gray" italic>
              {t('thinking.folded', { count: lines.length })}
            </Text>
          ) : null}
        </Box>
      );
    }
    case 'tool':
      return (
        <Box marginTop={1}>
          <ToolCall item={item} expanded={expanded} />
        </Box>
      );
    case 'note':
      return (
        <Box marginTop={1}>
          <Text color="gray">· {item.text}</Text>
        </Box>
      );
    case 'error':
      return (
        <Box marginTop={1}>
          <Text color="red">⚠ {item.text}</Text>
        </Box>
      );
    case 'goalPanel':
      return <GoalPanel data={item.data} />;
    case 'cron':
      return <CronCard data={item.data} />;
  }
}

/** 渲染会话记录（调用方传入的是动态区尾部切片）。工具输出在动态区恒折叠，完整输出走 Ctrl+O 全屏查看器（ExpandViewer）；busy 时最后一条 assistant 用 transient（关高亮）。
 * maxRows 为动态区高度预算（滚动跳顶修复）：传入时经 LiveViewport 做尾部锚定窗口化（行级截尾 + 隐藏行数指示），undefined 时原样渲染。 */
export function MessageList({
  items,
  busy = false,
  maxRows,
  termWidth,
}: {
  items: DisplayItem[];
  busy?: boolean;
  /** 动态区高度预算行数；undefined = 不窗口化（非 TTY / 测试环境）。 */
  maxRows?: number;
  termWidth?: number;
}): React.ReactElement {
  const lastAssistantIdx = (() => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i]!.kind === 'assistant') return i;
    return -1;
  })();
  const body = items.map((item, i) => (
    <MessageItem key={i} item={item} expanded={false} transient={busy && i === lastAssistantIdx} termWidth={termWidth} />
  ));
  if (maxRows === undefined) {
    return <Box flexDirection="column">{body}</Box>;
  }
  return <LiveViewport maxRows={maxRows}>{body}</LiveViewport>;
}
