import { sliceByColumn, visibleWidth } from '@earendil-works/pi-tui';

/**
 * 单行输入的可视区渲染：长文本横向滚动，光标始终留在可视区内，
 * 避免被 truncateToWidth 从末尾截断成省略号（ask_user 的 Other 输入与审批反馈附言同病灶）。
 *
 * 光标用反显（reverse video）叠在当前字符上，与 pi-tui 的 Input 组件风格一致。
 * 占位符由调用方处理——空文本时传空串即可，调用方自行拼反显光标 + 暗色占位符。
 *
 * 光标按 code-unit 定位，与 QuestionPrompt / ChoiceBlock 现有编辑逻辑一致（均用字符串 slice）。
 *
 * @param value    完整文本
 * @param cursor   光标在 value 中的 code-unit 位置
 * @param maxWidth 可用宽度（列数）
 * @returns 带反显光标的可见文本，宽度不超过 maxWidth
 */
export function renderScrolledInput(value: string, cursor: number, maxWidth: number): string {
  const width = Math.max(1, Math.floor(maxWidth));
  const cur = Math.max(0, Math.min(cursor, value.length));
  const totalWidth = visibleWidth(value);
  const rev = (ch: string): string => `\x1b[7m${ch || ' '}\x1b[27m`;

  let visibleText: string;
  let cursorDisplay: number;
  if (totalWidth < width) {
    // 全部放得下
    visibleText = value;
    cursorDisplay = cur;
  } else {
    // 横向滚动：按光标列算可见窗口，把光标保持在可视区（与 pi-tui Input.render 同算法）
    const cursorCol = visibleWidth(value.slice(0, cur));
    const scrollWidth = Math.max(1, width - 1); // 留 1 列给光标（末尾光标占 1 列）
    const halfWidth = Math.floor(scrollWidth / 2);
    let startCol = 0;
    if (cursorCol > halfWidth) {
      startCol =
        cursorCol > totalWidth - halfWidth
          ? Math.max(0, totalWidth - scrollWidth)
          : Math.max(0, cursorCol - halfWidth);
    }
    visibleText = sliceByColumn(value, startCol, scrollWidth, true);
    const beforeCursor = sliceByColumn(value, startCol, Math.max(0, cursorCol - startCol), true);
    cursorDisplay = beforeCursor.length;
  }

  // 在光标处插入反显字符（code-unit 对齐，与编辑逻辑一致）
  const atCursor = cursorDisplay < visibleText.length ? visibleText.slice(cursorDisplay, cursorDisplay + 1) : ' ';
  return visibleText.slice(0, cursorDisplay) + rev(atCursor) + visibleText.slice(cursorDisplay + 1);
}
