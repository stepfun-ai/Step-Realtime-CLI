import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import type { AskUserRequest, QuestionAnswers } from '../tools/askUser.js';
import { t } from '../i18n.js';
import { wrappedRows } from '../chat/liveBudget.js';
import { TextEditField } from './TextEditField.js';

/**
 * 估算提问框渲染行数（供 App 计算动态区高度预算，滚动跳顶修复）。
 * 结构：marginTop 1 + 边框 2 + 题干（折行）+ 选项（逐条折行）+ Other 1 + 提示（折行）。
 * 多题时取各题行数最大值——qIdx 是组件内部状态，换题时 App 不会重算预算，预算必须覆盖最高的一题。
 * termCols 用于精确计算长题干/长选项描述的折行（内宽 = 列数 − 边框 2 − paddingX 2）；
 * 缺省时退化为每逻辑行 1 行的结构估算（测试/非 TTY 场景）。
 */
export function estimateChromeRows(req: AskUserRequest, termCols?: number): number {
  const innerWidth = termCols === undefined ? undefined : termCols - 4;
  const hint = req.questions.length > 1 ? t('question.hintMulti') : t('question.hint');
  let maxBody = 0;
  for (const q of req.questions) {
    const counter = req.questions.length > 1 ? t('question.counter', { index: 1, total: req.questions.length }) : '';
    const header = q.header !== undefined && q.header !== '' ? `[${q.header}] ` : '';
    const multi = q.multi_select === true ? t('question.multiHint') : '';
    let rows = wrappedRows(counter + header + q.question + multi, innerWidth);
    q.options.forEach((opt, i) => {
      const box = q.multi_select === true ? '[✓] ' : '';
      const desc = opt.description !== undefined && opt.description !== '' ? `  — ${opt.description}` : '';
      // 前缀宽 = 光标列 2 + 勾选列 + [n] 列；取选中态前缀（与未选中同宽，✓/空格同宽）
      rows += wrappedRows(`→ ${box}[${i + 1}] ${opt.label}${desc}`, innerWidth);
    });
    rows += 1; // Other 行（otherMode 下 TextInput 短输入仍 1 行）
    rows += wrappedRows(hint, innerWidth);
    if (rows > maxBody) maxBody = rows;
  }
  return 1 + 2 + maxBody;
}

/** 每题的持久交互现场：光标位置、多选勾选集、Other 自由文本草稿与其内部光标。回退/前进切题时原样恢复。 */
interface QuestionSlot {
  cursor: number;
  checked: Set<number>;
  otherText: string;
  /** Other 文本内的编辑光标（code point 索引）；切题保留，与 otherText 一起构成编辑现场。 */
  otherCursor: number;
}

/**
 * 询问用户组件（ask_user 工具的前台交互）。多题逐题问，全答完把 { 问题原文: 答案 } 字典
 * 一次性回传（多选值为数组）。取消（Esc）回传空字典。
 *
 * 题间导航（槽位模型）：
 * - 每题的交互现场（光标/勾选/Other 文本）存进按题索引的 slots，是单一数据源——
 *   ← 回退、→ 前进切题后完整恢复，回退改题不作废其他任何题的答案；
 * - 答完一题自动跳到**第一题未答题**（纯前进流等价于 +1；回退改完则跳过已答题，
 *   不被逼着重走）；全部答完才 onSubmit，因此常规路径不会多一次按键；
 * - Other 编辑态（otherMode）是瞬态：切题即退出编辑态，但文本草稿保留在槽位里。
 *
 * 键盘：←→ 切换题、↑↓ 移动光标（环绕）、数字键 1–9 直选实选项、单选 Enter 选中当前项、
 * 多选空格切换勾选 + Enter 提交本题、光标移到 Other 项 Enter 进入内联自由文本输入、Esc 取消。
 * Other 编辑态：进入后 ↑↓ / ←→切题 退出编辑态回导航（草稿保留在槽位），
 *   可打印字符 / 退格 / Home/End 等编辑键走自研文本编辑（复用 promptEdit，同主输入框），Enter 提交、Esc 取消整框；
 *   编辑态不失活本组件 useInput——按 otherMode 内部分流，避免「进了编辑态就退不出、选不了预设项」。
 * 组件自持 useInput；宿主（App）在提问态让出全部按键给本组件。
 */
export function QuestionPrompt({
  req,
  onSubmit,
  onCancel,
}: {
  req: AskUserRequest;
  onSubmit: (answers: QuestionAnswers) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [qIdx, setQIdx] = useState(0);
  // 按题索引的持久现场（光标/勾选/Other 文本），回退切题时原样恢复
  const [slots, setSlots] = useState<QuestionSlot[]>(() =>
    req.questions.map(() => ({ cursor: 0, checked: new Set<number>(), otherText: '', otherCursor: 0 })),
  );
  // Other 编辑态是瞬态：切题即退出编辑态（草稿留在槽位里）
  const [otherMode, setOtherMode] = useState(false);
  // 已答问题累积（key 为问题原文）；用 ref 避免逐题推进时读到陈旧闭包。
  const answers = useRef<QuestionAnswers>({});

  const q = req.questions[qIdx]!;
  const slot = slots[qIdx]!;
  const optionCount = q.options.length;
  const otherIdx = optionCount; // Other 项排在真实选项之后
  const rowCount = optionCount + 1; // 含 Other

  const patchSlot = (i: number, patch: Partial<QuestionSlot>): void => {
    setSlots((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  };

  /** 切换题（回退/前进/跳未答）：退出 Other 编辑态，现场由槽位自动恢复。 */
  const goto = (idx: number): void => {
    setOtherMode(false);
    setQIdx(idx);
  };

  // 记录本题答案并推进：跳到第一题未答题（回退改题后跳过已答题），全答完汇总回传。
  const advance = (answer: string | string[]): void => {
    answers.current[q.question] = answer;
    const next = req.questions.findIndex((qq) => answers.current[qq.question] === undefined);
    if (next === -1) {
      onSubmit(answers.current);
    } else {
      goto(next);
    }
  };

  const submitOther = (): void => {
    // 自由输入项：直接以用户输入文本作为答案（多选也退化为单值）。空文本忽略（不提交不退出）。
    const text = slot.otherText.trim();
    if (text === '') return;
    advance(text);
  };

  /** 进入 Other 编辑态：光标钉在 Other 项，文本编辑光标落到草稿末尾。 */
  const enterOther = (): void => {
    patchSlot(qIdx, { cursor: otherIdx, otherCursor: Array.from(slot.otherText).length });
    setOtherMode(true);
  };

  /** 退出 Other 编辑态回导航（草稿保留在槽位），并把光标移到指定项。 */
  const exitOtherTo = (cursor: number): void => {
    setOtherMode(false);
    patchSlot(qIdx, { cursor });
  };

  // Other 编辑态的按键处理：↑↓/←→切题 退出编辑态，Enter 提交、Esc 取消整框，
  // 其余交给自研文本编辑（复用 promptEdit，同主输入框，彻底弃用 ink-text-input）。
  useInput(
    (_input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.return) {
        submitOther();
        return;
      }
      // ↑↓ 退出编辑态并移动光标（草稿保留）；↑ 落到 Other 上一项，↓ 环绕回首项
      if (key.upArrow) {
        exitOtherTo((otherIdx - 1 + rowCount) % rowCount);
        return;
      }
      if (key.downArrow) {
        exitOtherTo((otherIdx + 1) % rowCount);
        return;
      }
      // 文本编辑（含裸 ←→ 单题场景、Home/End、退格、删词、可打印字符）归 TextEditField；
      // ←→ 多题切题经 onInterceptKey 在编辑器侧拦截（Ink 事件广播，此处拦截会双重处理）
    },
    { isActive: otherMode },
  );

  // 导航态按键：otherMode 下失活（改由上方编辑态处理器接管）。
  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      // 题间导航：← 回退上一题、→ 前进下一题（不环绕；跳过未答题由 advance 的提交闸兜底）
      if (key.leftArrow) {
        if (qIdx > 0) goto(qIdx - 1);
        return;
      }
      if (key.rightArrow) {
        if (qIdx + 1 < req.questions.length) goto(qIdx + 1);
        return;
      }
      if (key.upArrow) {
        patchSlot(qIdx, { cursor: (slot.cursor - 1 + rowCount) % rowCount });
        return;
      }
      if (key.downArrow) {
        patchSlot(qIdx, { cursor: (slot.cursor + 1) % rowCount });
        return;
      }
      // 数字键 1–9 直选「实选项」（不含 Other，Other 只能靠光标移到再 Enter）
      if (/^[1-9]$/.test(input)) {
        const n = Number(input) - 1;
        if (n < optionCount) {
          if (q.multi_select === true) {
            const next = new Set(slot.checked);
            if (next.has(n)) next.delete(n);
            else next.add(n);
            patchSlot(qIdx, { checked: next, cursor: n });
          } else {
            patchSlot(qIdx, { cursor: n });
            advance(q.options[n]!.label);
          }
        }
        return;
      }
      // 多选：空格切换当前光标项（Other 项不参与勾选）
      if (input === ' ' && q.multi_select === true && slot.cursor < optionCount) {
        const next = new Set(slot.checked);
        if (next.has(slot.cursor)) next.delete(slot.cursor);
        else next.add(slot.cursor);
        patchSlot(qIdx, { checked: next });
        return;
      }
      if (key.return) {
        if (slot.cursor === otherIdx) {
          enterOther();
          return;
        }
        if (q.multi_select === true) {
          const labels = q.options.filter((_, i) => slot.checked.has(i)).map((o) => o.label);
          advance(labels);
        } else {
          advance(q.options[slot.cursor]!.label);
        }
      }
    },
    { isActive: !otherMode },
  );

  const hint = req.questions.length > 1 ? t('question.hintMulti') : t('question.hint');
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text>
        {req.questions.length > 1 ? (
          <Text color="gray">{t('question.counter', { index: qIdx + 1, total: req.questions.length })}</Text>
        ) : null}
        {q.header !== undefined && q.header !== '' ? <Text color="magenta">{`[${q.header}] `}</Text> : null}
        <Text color="cyan" bold>
          {q.question}
        </Text>
        {q.multi_select === true ? <Text color="gray">{t('question.multiHint')}</Text> : null}
      </Text>
      {q.options.map((opt, i) => {
        const selected = i === slot.cursor && !otherMode;
        const box = q.multi_select === true ? (slot.checked.has(i) ? '[✓] ' : '[ ] ') : '';
        return (
          <Text key={i} color={selected ? 'cyan' : 'white'} bold={selected}>
            {selected ? '→ ' : '  '}
            {box}
            {`[${i + 1}] ${opt.label}`}
            {opt.description !== undefined && opt.description !== '' ? (
              <Text color="gray">{`  — ${opt.description}`}</Text>
            ) : null}
          </Text>
        );
      })}
      {otherMode ? (
        <Box>
          <Text color={slot.cursor === otherIdx ? 'cyan' : 'white'} bold>
            {'→ '}
            {`[${otherIdx + 1}] `}
          </Text>
          <Box flexShrink={1}>
            <TextEditField
              value={{ text: slot.otherText, cursor: slot.otherCursor }}
              onChange={(v) => patchSlot(qIdx, { otherText: v.text, otherCursor: v.cursor })}
              placeholder={t('question.otherPlaceholder')}
              isActive={otherMode}
              onInterceptKey={(_input, key) => {
                // ←→ 多题时退出编辑态并切题（草稿保留）；单题时不拦截，归编辑器做光标移动
                if (req.questions.length <= 1) return false;
                if (key.leftArrow) {
                  setOtherMode(false);
                  if (qIdx > 0) goto(qIdx - 1);
                  return true;
                }
                if (key.rightArrow) {
                  setOtherMode(false);
                  if (qIdx + 1 < req.questions.length) goto(qIdx + 1);
                  return true;
                }
                return false;
              }}
            />
          </Box>
        </Box>
      ) : (
        <Text color={slot.cursor === otherIdx ? 'cyan' : 'white'} bold={slot.cursor === otherIdx}>
          {slot.cursor === otherIdx ? '→ ' : '  '}
          {`[${otherIdx + 1}] ${t('question.other')}`}
        </Text>
      )}
      <Text color="gray">{hint}</Text>
    </Box>
  );
}

