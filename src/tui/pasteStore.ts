/**
 * 超长粘贴折叠登记表 + 占位符还原。
 *
 * 超长粘贴（多行长文或单行长文）不直接进输入框：原文存进 store 并分配自增 id，
 * 输入框光标处只插入一个可见的占位符文本 `[paste #1 +123 lines]`（多行）或
 * `[paste #1 1234 chars]`（单行长文）。输入框里驻留的始终是短占位符，
 * 渲染与击键编辑不再随粘贴体积增长。
 *
 * 占位符是普通文本，用户能直接看到它、像删普通文字一样删掉它（删占位符 = 放弃
 * 这段粘贴）。提交时 expandPasteMarkers 扫描文本，把仍存在的占位符还原为原文，
 * 删掉的或手打的占位符原样留在文本里，不还原。
 *
 * 占位符是固定英文格式的机器标记，不随界面语言变化，便于稳定正则匹配。
 * 作用域为单次会话：/new、/resume、会话切换时 clear()，id 重新从 1 开始。
 */

/** 折叠阈值：超过 10 行折叠。 */
export const PASTE_FOLD_LINE_THRESHOLD = 10;
/** 折叠阈值：超过 1000 字符折叠（单行长文同样命中）。 */
export const PASTE_FOLD_CHAR_THRESHOLD = 1000;

export interface PasteEntry {
  readonly id: number;
  /** 粘贴原文（已归一 \n）。 */
  readonly content: string;
  /** 渲染出的占位符文本，如 `[paste #1 +123 lines]`。 */
  readonly placeholder: string;
}

/** 匹配输入框里的粘贴占位符，捕获 id。计数段用非捕获兼容匹配，容错用户手打的近似格式。 */
const PLACEHOLDER_RE = /\[paste #(\d+) (?:\+\d+ lines|\d+ chars)\]/g;

/** 粘贴文本是否需要折叠为占位符：超 10 行或超 1000 字符。 */
export function shouldFoldPaste(text: string): boolean {
  return text.length > PASTE_FOLD_CHAR_THRESHOLD || text.split('\n').length > PASTE_FOLD_LINE_THRESHOLD;
}

export function formatPlaceholder(id: number, content: string): string {
  const lines = content.split('\n').length;
  if (lines > PASTE_FOLD_LINE_THRESHOLD) return `[paste #${id} +${lines} lines]`;
  return `[paste #${id} ${content.length} chars]`;
}

export class PasteStore {
  private nextId = 1;
  private readonly byId = new Map<number, PasteEntry>();

  add(content: string): PasteEntry {
    const id = this.nextId;
    this.nextId += 1;
    const entry: PasteEntry = { id, content, placeholder: formatPlaceholder(id, content) };
    this.byId.set(id, entry);
    return entry;
  }

  get(id: number): PasteEntry | undefined {
    return this.byId.get(id);
  }

  clear(): void {
    this.byId.clear();
    this.nextId = 1;
  }

  size(): number {
    return this.byId.size;
  }

  /**
   * 提交时把文本里的粘贴占位符还原为原文。
   * 只还原本 store 里仍存在的 id；删剩一半的、手打的、已 clear 的占位符原样保留。
   */
  expandPasteMarkers(text: string): string {
    PLACEHOLDER_RE.lastIndex = 0;
    return text.replace(PLACEHOLDER_RE, (match, idStr: string) => {
      const entry = this.byId.get(Number.parseInt(idStr, 10));
      return entry === undefined ? match : entry.content;
    });
  }
}
