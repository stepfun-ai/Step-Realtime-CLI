import { Text, useInput, usePaste } from 'ink';
import { useRef } from 'react';
import { insertText, normalizePastedText, resolveEditAction, type PromptEditState } from './promptEdit.js';

/**
 * 统一单行文本编辑字段（除主输入框 PromptInput 外，全仓单行输入一律用本组件——
 * 设计依据与例外清单见 docs/zh/design/unified-text-editor.md）。
 *
 * 收敛的三份历史拷贝：QuestionPrompt.renderOtherInput / ProviderWizard.renderField /
 * FirstRunSetup.EditableInput 的「useInput 编辑分发 + 反色光标渲染」曾是同一逻辑的
 * 三份手写副本；搜索词类输入（ModelPicker/SkillPicker/SessionPicker/ProviderWizard）
 * 此前连光标都没有（只能追加 + 退格删尾），经本组件获得完整编辑键集。
 *
 * 能力边界（单行）：
 * - 编辑键走 promptEdit（←→/Home/End/Ctrl+←→/Ctrl+W/U/K/退格/Delete），可打印字符插光标处；
 * - 单行语义：插入前剥掉所有 \r/\n（粘贴的长 key/URL 折行进字段会毁 TOML 解析，
 *   见 FirstRunSetup 的历史教训）；
 * - Enter/Esc/↑↓/Tab 一律不消费，归父组件（导航/提交/取消语义各场景不同）；
 * - 特殊键冲突（如 SessionPicker 的 Delete 删会话、QuestionPrompt 的 ←→ 切题）由
 *   onInterceptKey 拦截——父组件返回 true 则内置编辑不处理，避免「两个 useInput
 *   都激活时同一按键被处理两次」（Ink 的 input 事件是广播，无 stopPropagation）。
 */

export interface TextEditValue {
  text: string;
  /** code point 索引。 */
  cursor: number;
}

export function TextEditField({
  value,
  onChange,
  placeholder = '',
  isActive = true,
  onInterceptKey,
}: {
  value: TextEditValue;
  onChange: (next: TextEditValue) => void;
  /** 空文本时的灰字占位（反色空格光标独立渲染，不覆盖占位首字符——反色 CJK 全宽字符会让该字无法辨认）。 */
  placeholder?: string;
  /** useInput 激活门控（父组件模态切换用，如 QuestionPrompt 的 otherMode）。 */
  isActive?: boolean;
  /** 按键拦截：返回 true 表示父组件已处理，内置编辑与字符插入跳过。 */
  onInterceptKey?: (input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]) => boolean;
}): React.ReactElement {
  // 单行语义归一：\r\n / \r → \n 后整体剥掉换行（normalizePastedText 只做归一，不够）
  const toSingleLine = (raw: string): string => normalizePastedText(raw).replace(/[\r\n]+/g, '');

  // 最新值镜像 + 乐观更新：同一宏任务拍内连续到达的按键（测试里两次 stdin.write
  // 无间隔、终端极速连打）在 React 批处理 flush 前执行，useInput 闭包里的 value
  // 还是上次的——传值式 onChange 会丢字符（PromptInput 的 selfChangeRef 同款坑，
  // 旧搜索框用函数式 setState 天然免疫才没暴露）。handler 一律从 ref 读、
  // emitChange 后立即写回，后续按键读到的是刚发出的新值。
  const valueRef = useRef(value);
  valueRef.current = value;
  const emitChange = (next: TextEditValue): void => {
    valueRef.current = next;
    onChange(next);
  };

  // bracketed paste：一次性整体插入，不走 useInput 逐字符分支
  usePaste((raw) => {
    if (!isActive) return;
    const cur = valueRef.current;
    emitChange(insertText({ text: cur.text, cursor: cur.cursor }, toSingleLine(raw)));
  });

  useInput(
    (input, key) => {
      // Enter/Esc/↑↓/Tab 透传给父组件（各场景语义不同：提交/取消/导航/切 tab）
      if (key.return || key.escape || key.upArrow || key.downArrow || key.tab) return;
      if (onInterceptKey !== undefined && onInterceptKey(input, key)) return;
      const cur = valueRef.current;
      const editState: PromptEditState = { text: cur.text, cursor: cur.cursor };
      const action = resolveEditAction(input, key);
      if (action) {
        const next = action(editState);
        if (next.text !== cur.text || next.cursor !== cur.cursor) emitChange(next);
        return;
      }
      // 可打印字符：无 ctrl/meta 修饰时插入光标处（粘贴多字符整体插入）
      if (input !== '' && key.ctrl !== true && key.meta !== true) {
        emitChange(insertText(editState, toSingleLine(input)));
      }
    },
    { isActive },
  );

  return <Text>{renderEditableLine(value.text, value.cursor, placeholder)}</Text>;
}

/**
 * 单行文本 + 反色光标渲染（统一三个历史拷贝的版本）：
 * 光标处字符反色，光标在末尾时反色一个占位空格；空文本时反色一个空格作光标、
 * placeholder 整体 dim 完整显示（不反色 placeholder 首字符——反色 CJK 全宽字符
 * 会让该字完全无法辨认，实测「思考中…」首字被反色块吃掉）。
 */
export function renderEditableLine(value: string, cursor: number, placeholder: string): React.ReactNode {
  if (value === '') {
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
  return (
    <>
      {chars.slice(0, at).join('')}
      <Text inverse>{cursorChar}</Text>
      {at < chars.length ? chars.slice(at + 1).join('') : ''}
    </>
  );
}
