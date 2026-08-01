import { Box, Text, useInput, usePaste } from 'ink';
import { useRef, useState } from 'react';
import { SLASH_COMMANDS, type SlashCommand } from './commands.js';
import { displayWidth } from './liveBudget.js';
import { initialNavState, navigateHistory } from '../session/inputHistory.js';
import { insertText, normalizePastedText, resolveEditAction } from './promptEdit.js';
import { shouldFoldPaste, type PasteStore } from './pasteStore.js';
import { t } from '../i18n.js';

/** 斜杠菜单可视窗口条数（固定，不随终端高度变）。 */
const MENU_WINDOW = 6;

/**
 * 底部输入框：带边框常驻。敲 `/` 弹出斜杠命令补全下拉。
 * 方向键上/下回溯输入历史（shell 式命令回溯）：斜杠菜单可见时归菜单选择，
 * 否则做历史导航——单行输入框无多行移动冲突，配 bash 风格草稿暂存
 * （Up 翻历史、Down 翻回底部恢复半截草稿）。
 *
 * 斜杠菜单抑制（补全只由「实际输入」触发）：
 * 历史回溯带出的以 / 开头的文本是已提交过的完整命令，不是正在输入的前缀，
 * 此时不弹菜单——否则 ↑ 会被菜单选择劫走，无法继续向上翻历史（实测卡死）。
 * 用户随后任何编辑（敲字符、删除等改字动作）即重新武装菜单；
 * 输入框被清空（提交、Esc）时抑制态复位。
 *
 * 文本编辑为自研组件（text + cursorOffset，光标处字符反色渲染），
 * 不用 ink-text-input：实测（见 promptEdit.ts 注释）Ink 已把 Home/End 的
 * 全部兼容序列解析为 key.home/key.end，但 ink-text-input 只处理左右方向键，
 * 导致 Home/End 无效；自研后补齐 readline 风格编辑键集
 * （Home/Ctrl+A、End/Ctrl+E、Ctrl+←/Alt+B、Ctrl+→/Alt+F、Ctrl+W/U/K）。
 * 按键分发保持线性次序：斜杠菜单 → 队列取回（busy 空输入 ↑）→ 历史导航 → 编辑动作 → 可打印字符。
 * 手敲无法输入换行（Enter = 提交）；粘贴可带入多行（\r\n / \r 归一为 \n，
 * 见 normalizePastedText），多行值按行渲染、行高计入 computePromptRows 预算。
 */
export function PromptInput({
  value,
  onChange,
  onSubmit,
  busy,
  history,
  primed = false,
  exitPrimed = false,
  onRecallQueued,
  pasteStore,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  busy: boolean;
  /** 输入历史（时间正序，末尾最新）。 */
  history: string[];
  /** backtrack primed 态：显示「再按 Esc 取回上一条消息编辑」提示（仅空闲时有意义）。 */
  primed?: boolean;
  /** 退出确认 primed 态：显示「再按一次 Ctrl+C 退出」提示（仅空闲时有意义）。 */
  exitPrimed?: boolean;
  /**
   * 候选队列取回（可选）：busy + 输入框为空时按 ↑ 调用，
   * 返回取回的文本（队尾 pop）填入输入框；返回 undefined（队列空）则落回历史导航。
   */
  onRecallQueued?: () => string | undefined;
  /** 超长粘贴折叠登记表（可选）：挂上后超阈值粘贴折叠为占位符，提交时由调用方还原。 */
  pasteStore?: PasteStore;
}): React.ReactElement {
  const [selIdx, setSelIdx] = useState(0);
  // 历史导航游标（不参与渲染，用 ref 避免 useInput 闭包读到陈旧值）。
  const navState = useRef(initialNavState());
  // 斜杠菜单抑制（见头部注释）：历史回溯置位、改字复位、外部清空复位。
  const menuSuppressedRef = useRef(false);
  // 光标位置（code point 索引）。本组件内发起的文本变更在按键处理器里同步设好光标，
  // 并用 ref 记下新文本；外部变更（历史回溯、Tab 补全、提交清空）光标归尾（shell 行为）。
  const [cursor, setCursor] = useState(() => Array.from(value).length);
  const selfChangeRef = useRef<string | null>(null);
  // 光标归尾不用 useEffect：effect 要等 commit 后才跑，期间到达的下一次按键
  // 会读到旧光标（实测全量跑测试时 Up 回溯后立刻敲字符插到了行首）。
  // 改用渲染期间派生状态（React 官方 adjusting-state-when-props-change 模式），
  // setState 在同一次渲染内立即重渲染，光标复位与文本变更同步生效。
  const lastValueRef = useRef(value);
  if (lastValueRef.current !== value) {
    lastValueRef.current = value;
    if (selfChangeRef.current !== value) {
      setCursor(Array.from(value).length);
      // 外部清空（提交、backtrack 预填等）：菜单抑制态一并复位，下次输入正常弹补全
      if (value === '') menuSuppressedRef.current = false;
    }
    selfChangeRef.current = null;
  }

  // 斜杠命令补全：输入以 / 开头且无空格时，过滤匹配命令。
  const matches = matchSlashCommands(value);
  const menuVisible = matches.length > 0 && !menuSuppressedRef.current;

  // 弹层不可见时，↑↓ 做 shell 式输入历史回溯（配 bash 风格草稿暂存）。
  // 例外：busy + 输入框为空时 ↑ 优先取回候选队列入队尾一条编辑（发送从头部消费，
  // 编辑从尾部取回）；取回是程序化回填，同样抑制补全菜单。队列空则落回历史导航。
  useInput(
    (_input, key) => {
      if (menuVisible) return;
      if (key.upArrow && busy && value === '' && onRecallQueued !== undefined) {
        const recalled = onRecallQueued();
        if (recalled !== undefined) {
          menuSuppressedRef.current = true;
          navState.current = initialNavState();
          onChange(recalled);
          return;
        }
      }
      if (key.upArrow || key.downArrow) {
        const res = navigateHistory(history, navState.current, key.upArrow ? -1 : 1, value);
        navState.current = res.state;
        if (res.text !== undefined) {
          // 回溯带出的文本不是「正在输入的前缀」，抑制补全菜单，
          // 让下一次 ↑ 继续翻历史而不是被菜单选择劫走
          menuSuppressedRef.current = true;
          onChange(res.text);
        }
      }
    },
    { isActive: !menuVisible },
  );

  // 弹层可见时按键优先给弹层：↑↓ 选择、Tab 补全、Enter 执行、Esc 关闭
  useInput(
    (_input, key) => {
      if (!menuVisible) return;
      if (key.upArrow) {
        // 到顶/到底回卷（循环选择行为）
        setSelIdx((i) => (i - 1 + matches.length) % matches.length);
      } else if (key.downArrow) {
        setSelIdx((i) => (i + 1) % matches.length);
      } else if (key.tab) {
        const c = matches[Math.min(selIdx, matches.length - 1)];
        if (c !== undefined) onChange(`/${c.name} `);
      } else if (key.escape) {
        onChange('');
      }
    },
    { isActive: menuVisible },
  );

  // 弹层可见时 Enter 直接执行选中命令（不透传给输入框）
  const handleSubmit = (v: string): void => {
    if (menuVisible) {
      const c = matches[Math.min(selIdx, matches.length - 1)];
      if (c !== undefined) {
        onSubmit(`/${c.name}`);
        return;
      }
    }
    onSubmit(v);
  };

  // 粘贴/多字符插入的统一入口：先归一 \r\n / \r → \n（\r 进值后按回车语义渲染，
  // 后续字符会被写到行首）；超阈值（见 shouldFoldPaste）且挂了 pasteStore 时折叠为
  // 占位符，原文进 store，输入框里只驻留短占位符，提交时由调用方还原。
  // 手敲单字符永远不达阈值，走同一函数行为与直接插入一致。
  const insertPastedText = (raw: string): void => {
    const norm = normalizePastedText(raw);
    const folded = pasteStore !== undefined && shouldFoldPaste(norm) ? pasteStore.add(norm).placeholder : norm;
    const next = insertText({ text: value, cursor }, folded);
    setSelIdx(0);
    navState.current = initialNavState();
    menuSuppressedRef.current = false;
    selfChangeRef.current = next.text;
    onChange(next.text);
    setCursor(next.cursor);
  };

  // bracketed paste：终端支持的粘贴作为单个完整字符串到达，一次插入（不逐 chunk 刷屏）。
  // 挂上后 bracketed paste 序列不再进 useInput；不支持 bracketed paste 的终端
  // 粘贴仍以多字符 input 走下方 useInput 分支，同样经 insertPastedText 折叠。
  usePaste((text) => {
    insertPastedText(text);
  });

  // 文本编辑与字符输入（线性 if 链尾部：编辑动作 → 可打印字符）。
  // 菜单可见时也保持激活：敲键过滤菜单、Ctrl+W 等编辑键照常可用；
  // ↑↓/Tab/Esc 归上方菜单处理器，这里不接。实际改字即退出历史浏览态、复位菜单选中，
  // 并解除历史回溯的菜单抑制（补全重新武装）。
  useInput((input, key) => {
    if (key.return) {
      handleSubmit(value);
      return;
    }
    const action = resolveEditAction(input, key);
    if (action) {
      const next = action({ text: value, cursor });
      if (next.text !== value) {
        setSelIdx(0);
        navState.current = initialNavState();
        menuSuppressedRef.current = false;
        selfChangeRef.current = next.text;
        onChange(next.text);
      }
      setCursor(next.cursor);
      return;
    }
    // 可打印字符：无 ctrl/meta 修饰时插入光标处（粘贴的多字符整体插入）
    if (input !== '' && !key.ctrl && !key.meta) {
      insertPastedText(input);
    }
  });

  // 菜单窗口化滚动（居中窗口）：选中项尽量停在窗口中间，
  // 靠近两端时钳制，保证选中项永不滚出可视窗口。
  const menuStart = Math.max(0, Math.min(selIdx - Math.floor(MENU_WINDOW / 2), matches.length - MENU_WINDOW));

  return (
    <Box flexDirection="column">
      {menuVisible ? (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          {matches.slice(menuStart, menuStart + MENU_WINDOW).map((c, i) => {
            const selected = menuStart + i === selIdx;
            return (
              <Text key={c.name} color={selected ? 'cyan' : 'gray'} bold={selected} wrap="truncate">
                {selected ? '› ' : '  '}
                <Text color={selected ? 'cyan' : 'white'}>/{c.name}</Text>
                {'  '}
                <Text color="gray">{t(c.describe)}</Text>
              </Text>
            );
          })}
          {matches.length > MENU_WINDOW ? (
            <Text color="gray">
              {'  '}({selIdx + 1}/{matches.length})
            </Text>
          ) : null}
        </Box>
      ) : null}
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color={busy ? 'yellow' : 'gray'} bold>
          {'› '}
        </Text>
        {/* 包 Box 防 Ink squash（同 MessageList user 条目）：否则多行/长行内容折行时
            '› ' 尾空格被断行点吞掉，续行缩进错位 */}
        <Box flexShrink={1}>
          <Text>{renderEditableText(value, cursor, busy ? t('input.placeholder.busy') : t('input.placeholder.idle'))}</Text>
        </Box>
      </Box>
      {!busy && primed ? <Text color="yellow" wrap="truncate">{t('input.backtrackPrimed')}</Text> : null}
      {!busy && exitPrimed ? <Text color="yellow" wrap="truncate">{t('input.exitPrimed')}</Text> : null}
    </Box>
  );
}

/**
 * 斜杠命令补全匹配：输入以 / 开头且无空格时，
 * 1. 前缀匹配（startsWith）优先；
 * 2. 短查询（≤3 字符）降级到子序列匹配（字符按顺序出现即可，不需连续），
 *    覆盖 cp→compact、se→sessions 这类缩写。
 * 结果按「前缀命中 > 子序列命中」排序，同层按注册序。
 */
/**
 * 子序列匹配：query 的字符按顺序出现在 str 中即可，不需连续。
 * 额外约束：每个匹配字符在 str 中的位置不得超过 len(query) * 2，
 * 防止长跨度误匹配（如 /re 命中 provider 的 r→e 跨度 5）。
 */
function isSubsequence(query: string, str: string): boolean {
  if (query.length === 0) return true;
  const limit = query.length * 2;
  let qi = 0;
  for (let i = 0; i < str.length && qi < query.length; i++) {
    if (str[i] === query[qi] && i <= limit) qi++;
  }
  return qi === query.length;
}

export function matchSlashCommands(value: string): SlashCommand[] {
  const query = value.startsWith('/') && !/\s/.test(value) ? value.slice(1).toLowerCase() : null;
  if (query === null) return [];
  const q = query.toLowerCase();
  // 仅 2 字符查询启用子序列回退（覆盖 cp→compact 这类缩写）；≥3 字符前缀匹配已足够精确
  const isAbbrev = q.length === 2;
  const scored = SLASH_COMMANDS.map((c) => {
    const name = c.name.toLowerCase();
    const aliases = (c.aliases ?? []).map((a) => a.toLowerCase());
    const allStrings = [name, ...aliases];
    const prefixHit = allStrings.some((s) => s.startsWith(q));
    const seqHit = isAbbrev && allStrings.some((s) => isSubsequence(q, s));
    const rank = prefixHit ? 0 : seqHit ? 1 : 2;
    return { cmd: c, rank };
  })
    .filter(({ rank }) => rank < 2)
    .sort((a, b) => a.rank - b.rank)
    .map(({ cmd }) => cmd);
  return scored;
}

export interface PromptRowOptions {
  busy: boolean;
  /** backtrack primed 提示行（仅空闲时显示）。 */
  primed?: boolean;
  /** 退出确认 primed 提示行（仅空闲时显示）。 */
  exitPrimed?: boolean;
  /** 终端列数（未知时调用方给保守默认 80）。 */
  columns: number;
}

/**
 * 输入区实际占用行数（动态区高度预算用，与上方渲染结构一一对应）：
 * 斜杠菜单（边框 2 + 窗口 ≤MENU_WINDOW 条 + 页码行 ≤1）
 * + 输入框（边框 2 + 内容按终端宽度折行，长粘贴/窄终端不再漏算）
 * + primed 提示 ≤1。菜单条目与提示行均 wrap=truncate 单行截断。
 * 注：忙碌态的 spinner/状态词/tip 由独立的 WorkingStatus 块承担（不在本组件内），其高度由 App 单独计入预算。
 * 注：历史回溯抑制菜单期间（menuSuppressed，App 不可知）此处仍把菜单行计入——
 * chrome 高估只压缩动态区视口，是滚动预算的安全方向，且回溯浏览是瞬态。
 */
export function computePromptRows(value: string, opts: PromptRowOptions): number {
  const matches = matchSlashCommands(value);
  const menuRows =
    matches.length > 0 ? 2 + Math.min(matches.length, MENU_WINDOW) + (matches.length > MENU_WINDOW ? 1 : 0) : 0;
  // 输入框内容区可用宽度：边框 2 + 内边距 2 + 前缀（› + 空格）2
  const contentWidth = Math.max(opts.columns - 6, 1);
  // 粘贴可带入 \n（多行输入框）：逐段折行求和，不能把 \n 当普通字符只算一行——
  // 低估行高会顶破动态帧预算（滚动拽回 bug 的同类洞）
  const inputLines = value
    .split('\n')
    .reduce((rows, seg) => rows + Math.max(1, Math.ceil(displayWidth(seg) / contentWidth)), 0);
  // primed 提示行仅空闲时显示（busy 态无 primed）
  const tipRows =
    (!opts.busy && (opts.primed ?? false) ? 1 : 0) +
    (!opts.busy && (opts.exitPrimed ?? false) ? 1 : 0);
  return menuRows + inputLines + 2 + tipRows;
}

/**
 * 单行文本 + 光标渲染：光标处字符反色（沿用 ink-text-input 的做法），
 * 光标在末尾时反色一个占位空格；空文本时反色一个空格作光标、placeholder 整体 dim 完整显示。
 */
function renderEditableText(value: string, cursor: number, placeholder: string): React.ReactNode {
  if (value === '') {
    // 光标反色独立空格、不覆盖 placeholder 首字符：反色 CJK 全宽字符会让该字完全无法辨认
    // （实测「思考中…」首字被反色块吃掉，显示成「▮考中…」像是花屏）。
    return (
      <>
        <Text inverse>{' '}</Text>
        <Text dimColor>{placeholder}</Text>
      </>
    );
  }
  const chars = Array.from(value);
  const at = Math.max(0, Math.min(cursor, chars.length));
  const cursorChar = at < chars.length ? (chars[at] as string) : ' ';
  // 光标落在换行符上时反色空格占位（换行本身照常渲染），避免反色 \n 吃掉行尾
  const onNewline = cursorChar === '\n';
  return (
    <>
      {chars.slice(0, at).join('')}
      <Text inverse>{onNewline ? ' ' : cursorChar}</Text>
      {onNewline ? '\n' : ''}
      {at < chars.length ? chars.slice(at + 1).join('') : ''}
    </>
  );
}
