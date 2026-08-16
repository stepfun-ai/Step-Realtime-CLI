/**
 * pi-tui 前端的主题层：把 chalk 着色函数装配成 pi-tui 各组件要求的 theme 形状。
 *
 * 为什么单独一层：pi-tui 的组件（Markdown / Editor / SelectList）都要求调用方传入
 * 「文本 → 带 ANSI 的文本」的函数集合，而不是像 Ink 那样在 JSX 上写 color 属性。
 * 集中在此处装配，颜色口径才有单一事实源；各 block 直接引用这里的语义色。
 */
import chalk from 'chalk';
import { highlight, supportsLanguage } from 'cli-highlight';
import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui';

/** 语义色：与已删除的 Ink 版用色保持一致，迁移前后观感不跳。 */
export const c = {
  // 用户消息：前缀蓝色加粗 + 正文黄色，与 Ink 版 MessageList 的 user 分支同口径
  // （实测 Ink 是 `› ` blue bold + 正文 color="yellow"；早期这里误记为 cyan 并写了
  // 「与 Ink 一致」的注释，实际 Ink 从来没有青色用户消息）。正文着黄不是装饰：
  // 转录区正文默认白，用户消息不着色就与助手输出糊成一片，翻历史时找不到自己说过什么。
  user: (s: string) => chalk.blue.bold(s),
  userText: chalk.yellow,
  assistant: (s: string) => s,
  thinking: chalk.dim,
  toolName: chalk.cyan,
  toolArg: chalk.dim,
  ok: chalk.green,
  error: chalk.red,
  warn: chalk.yellow,
  note: chalk.gray,
  dim: chalk.gray,
  heading: chalk.bold,
  accent: chalk.magenta,
  bold: chalk.bold,
  // logo 蓝：与 Ink 版 WelcomeBox 的 color="blue" 一致。
  // tab 条选中态：反色加粗（与 Ink 版 ModelPicker 的 inverse+bold 一致）。
  tabActive: (s: string) => chalk.inverse.bold(s),
  logo: chalk.blue,
  /** 权限模式徽章色：与 Ink 版 StatusBar.modeColor 同口径。 */
  mode: (mode: string) => (mode === 'yolo' ? chalk.red : mode === 'auto' ? chalk.yellow : chalk.green),
};

/**
 * markdown 主题。代码块高亮沿用 cli-highlight（Ink 版 Markdown.tsx 同一依赖），
 * 语言不支持时原样返回，不抛错。
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

/** 思考块的 markdown 主题：全体压暗，与正文区分（对应 Ink 版的 dim + italic）。 */
export const thinkingMarkdownTheme: MarkdownTheme = {
  ...markdownTheme,
  heading: (s) => chalk.dim(s),
  code: (s) => chalk.dim(s),
  bold: (s) => chalk.dim(s),
  italic: (s) => chalk.dim(s),
  listBullet: (s) => chalk.dim(s),
  highlightCode: (code) => code.split('\n').map((l) => chalk.dim(l)),
};

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
