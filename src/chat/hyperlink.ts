/**
 * 终端超链接（OSC 8）能力探测与序列生成。
 *
 * 支持 OSC 8 的终端：Windows Terminal、WezTerm、iTerm2、VSCode 内置终端、kitty、foot。
 * 探测逻辑基于 TERM_PROGRAM / COLORTERM 白名单，不知名终端保守返回 false。
 */

const HYPERLINK_TERMINALS = new Set([
  'WezTerm',
  'iTerm.app',
  'vscode',
  'Windows Terminal',
  'kitty',
  'foot',
]);

const HYPERLINK_COLORTERMS = new Set(['truecolor', '24bit']);

/** 当前终端是否支持 OSC 8 超链接。 */
export function supportsHyperlinks(): boolean {
  const termProgram = process.env['TERM_PROGRAM'];
  if (termProgram !== undefined && HYPERLINK_TERMINALS.has(termProgram)) return true;

  const colorterm = process.env['COLORTERM'];
  if (colorterm !== undefined && HYPERLINK_COLORTERMS.has(colorterm)) return true;

  return false;
}

/**
 * 生成 OSC 8 超链接转义序列。
 *
 * 格式：\x1b]8;;url\x07text\x1b]8;;\x07
 * 注意：OSC 8 序列本身不计入显示宽度（终端会吃掉它们），
 * 因此测量逻辑（displayWidth / wrappedRows）应始终使用不含转义序列的纯文本。
 */
export function link(text: string, url: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}
