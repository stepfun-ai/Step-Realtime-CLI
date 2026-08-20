/**
 * pi-tui 前端的主题层：把 chalk 着色函数装配成 pi-tui 各组件要求的 theme 形状。
 * 集中装配，颜色口径才有单一事实源；各 block 直接引用这里的语义色。
 */
import chalk from 'chalk';
import { highlight, supportsLanguage } from 'cli-highlight';
import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui';

/** 语义色。 */
export const c = {
  // 用户消息：前缀蓝色加粗 + 正文黄色 + 整行深灰背景（SGR 48;5;236），背景覆盖整行
  user: (s: string) => chalk.blue.bold(s),
  userText: chalk.yellow,
  userBg: chalk.bgAnsi256(236),
  assistant: (s: string) => s,
  thinking: chalk.dim,
  toolName: chalk.cyan,
  // 工具参数用 gray（SGR 90）而非 dim（SGR 2）：dim 的降亮由终端决定，不少配色下暗到读不出
  toolArg: chalk.gray,
  // skill 工具参数用黄色：技能激活会改变后续行为，比读写路径更需要一眼认出激活了哪个
  toolArgSkill: chalk.yellow,
  ok: chalk.green,
  error: chalk.red,
  warn: chalk.yellow,
  note: chalk.gray,
  dim: chalk.gray,
  heading: chalk.bold,
  accent: chalk.magenta,
  bold: chalk.bold,
  logo: chalk.blue,
  // tab 条选中态：反色加粗
  tabActive: (s: string) => chalk.inverse.bold(s),
  /** 权限模式徽章色。 */
  mode: (mode: string) => (mode === 'yolo' ? chalk.red : mode === 'auto' ? chalk.yellow : chalk.green),
};

/**
 * markdown 主题。代码块高亮沿用 cli-highlight，语言不支持时原样返回。
 */
export const markdownTheme: MarkdownTheme = {
  heading: (s) => chalk.bold.cyan(s),
  link: (s) => chalk.cyan.underline(s),
  linkUrl: (s) => chalk.dim(s),
  code: (s) => chalk.yellow(s),
  codeBlock: (s) => s,
  codeBlockBorder: (s) => chalk.gray(s),
  quote: (s) => chalk.dim(s),
  quoteBorder: (s) => chalk.gray(s),
  hr: (s) => chalk.gray(s),
  listBullet: (s) => chalk.cyan(s),
  bold: (s) => chalk.bold(s),
  italic: (s) => chalk.italic(s),
  strikethrough: (s) => chalk.strikethrough(s),
  underline: (s) => chalk.underline(s),
  highlightCode: (code, lang) => {
    if (lang === undefined || lang === '' || !supportsLanguage(lang)) return code.split('\n');
    try {
      return highlight(code, { language: lang, ignoreIllegals: true }).split('\n');
    } catch {
      return code.split('\n');
    }
  },
};

/**
 * 思考块的 markdown 主题。保证全灰的是 dimAll（普通段落不经 theme 函数），
 * 这里只让 highlightCode 直接返回纯文本，省掉「上色再被剥掉」的白做功。
 */
export const thinkingMarkdownTheme: MarkdownTheme = {
  ...markdownTheme,
  heading: (s) => chalk.dim(s),
  code: (s) => chalk.dim(s),
  bold: (s) => chalk.dim(s),
  italic: (s) => chalk.dim(s),
  /** 列表 bullet 去掉：thinking 只留纯灰色文字，不需要装饰符号 */
  listBullet: () => '',
  highlightCode: (code) => code.split('\n').map((l) => chalk.dim(l)),
};

/**
 * 把渲染好的行统一压灰：先剥掉全部 SGR，再整行套 dim。
 * 普通段落不经 theme 函数、Markdown 原样输出为默认白，逐项配主题治不了，只能整行剥色再压灰。
 * 只剥 SGR（\x1b[...m），不动 OSC 8 超链接序列。
 */
export function dimAll(lines: readonly string[]): string[] {
  return lines.map((l) => {
    const stripped = l.replace(/\x1b\[[0-9;]*m/g, '');
    return stripped === '' ? '' : chalk.dim(stripped);
  });
}

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (s) => chalk.cyan(s),
  selectedText: (s) => chalk.cyan.bold(s),
  description: (s) => chalk.gray(s),
  scrollInfo: (s) => chalk.gray(s),
  noMatch: (s) => chalk.gray(s),
};

export const editorTheme: EditorTheme = {
  borderColor: (s) => chalk.gray(s),
  selectList: selectListTheme,
};
