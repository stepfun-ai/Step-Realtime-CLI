/**
 * 输入补全：把既有的补全引擎接到 pi-tui Editor 的 AutocompleteProvider 接口上。
 *
 * 为什么不用 pi-tui 自带的 `CombinedAutocompleteProvider`：
 * 它自己扫盘做文件补全（fd 或内建遍历），而本项目的 `@` 补全用的是 `scanFileIndex`
 * 的索引（排除 node_modules/dist 与点目录、有条数上限）。换成它的扫描等于悄悄改了
 * 补全范围，可能把 node_modules 里的路径提上来。命令名匹配同理：既有语义是「前缀
 * 优先 + 两字符查询才启用子序列回退」，有测试钉住，模糊匹配会改变命中集。
 *
 * 所以这里只做适配层：候选仍由 `computeCompletions` 算，UI 与键位交给 Editor。
 */
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from '@earendil-works/pi-tui';
import { t } from '../i18n.js';
import { computeCompletions, type CompletionContext, type CompletionItem } from '../chat/completions.js';

/** 光标所在行取到光标处的文本：补全只看当前行的左半部分。 */
function currentToken(lines: string[], cursorLine: number, cursorCol: number): string {
  const line = lines[cursorLine] ?? '';
  return line.slice(0, cursorCol);
}

/**
 * `CompletionItem` → pi-tui 的 `AutocompleteItem`。
 *
 * label 与 description 是给人看的，value 必须是「替换掉当前 token 后的完整文本」：
 * applyCompletion 直接用它整段替换，不做二次拼接。
 */
function toAutocompleteItem(item: CompletionItem): AutocompleteItem {
  return {
    value: item.insertText,
    label: item.display,
    // command 类的 description 是 i18n key（cmd.*），这里查表；参数类已经是成品文本
    description:
      item.description === undefined ? undefined : item.kind === 'command' ? t(item.description) : item.description,
  };
}

export class ChatAutocompleteProvider implements AutocompleteProvider {
  /** `/` 与 `@` 在 token 边界触发（Editor 据此决定何时主动拉候选）。 */
  readonly triggerCharacters = ['/', '@'];

  /** 补全上下文是可变的：文件索引后台扫完才有值，模型别名表随 /model 不变但插件 id 可能晚到。 */
  private ctx: CompletionContext;

  constructor(ctx: CompletionContext) {
    this.ctx = ctx;
  }

  /** 后台扫描完成后回填文件索引（扫描前 @ 补全为空，属预期降级）。 */
  setFiles(files: readonly string[]): void {
    this.ctx = { ...this.ctx, files };
  }

  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): Promise<AutocompleteSuggestions | null> {
    const token = currentToken(lines, cursorLine, cursorCol);
    // 只在行首的 / 或 @ 上触发：句子中间出现的斜杠（路径、日期）不该弹命令菜单
    if (!token.startsWith('/') && !token.startsWith('@')) return Promise.resolve(null);
    const items = computeCompletions(token, this.ctx);
    if (items.length === 0) return Promise.resolve(null);
    return Promise.resolve({ items: items.map(toAutocompleteItem), prefix: token });
  }

  /** 选中候选：用 value 整段替换光标前的 token（value 已含尾随空格）。 */
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const next = [...lines];
    const line = next[cursorLine] ?? '';
    const head = line.slice(0, Math.max(0, cursorCol - prefix.length));
    const tail = line.slice(cursorCol);
    next[cursorLine] = head + item.value + tail;
    return { lines: next, cursorLine, cursorCol: (head + item.value).length };
  }
}
