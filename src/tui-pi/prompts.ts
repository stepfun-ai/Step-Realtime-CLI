/**
 * 审批三桥：工具审批、计划确认、向用户提问。
 *
 * 三者共用 ChoiceBlock 的选项列表交互，各自只提供正文与结果语义。
 * 危险命令模式表、diff/写入预览这些纯逻辑从 Ink 版 ApprovalPrompt.tsx 搬过来
 * （那边带 JSX，不能直接 import；M5 删除 src/tui/ 后这里就是唯一实现）。
 */
import { Markdown, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { AskUserQuestion, AskUserRequest, QuestionAnswers } from '../tools/askUser.js';
import { ChoiceBlock, type Choice } from './ChoiceBlock.js';
import { c, markdownTheme } from './theme.js';

/** 预览折叠行数上限（与 Ink 版 PREVIEW_LIMIT 同口径）。 */
const PREVIEW_LIMIT = 10;

/** 按工具定制的审批标题。 */
const TITLES: Record<string, string> = {
  bash: '允许执行这条命令吗',
  write_file: '允许写入这个文件吗',
  edit_file: '允许修改这个文件吗',
};

/**
 * bash 危险命令模式表（逐条抄自 Ink 版，宁保守勿误报）。
 * 命中后在命令上方红标一行警告。
 */
const DANGER_PATTERNS: ReadonlyArray<{ pattern: RegExp; warn: string }> = [
  {
    pattern:
      /\brm\s+(?:-{1,2}[\w-]+\s+)*(?:-[\w-]*(?:r[\w-]*f|f[\w-]*r)[\w-]*|--recursive\b[^|;]*--force|--force\b[^|;]*--recursive)/,
    warn: '递归强制删除：删掉的内容不进回收站，无法撤销',
  },
  { pattern: /\bsudo\b/, warn: '以 root 权限执行' },
  { pattern: /\b(?:curl|wget)\b[^|;]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, warn: '把远程脚本直接管道给 shell 执行' },
  { pattern: /\bdd\b[^|;]*\bof=\/dev\//, warn: '向块设备写入：会覆盖磁盘数据' },
  { pattern: /\bmkfs(?:\.\w+)?\b/, warn: '格式化文件系统' },
  { pattern: /\bchmod\s+(?:-\S+\s+)*777\b/, warn: '开放全部权限' },
  { pattern: />\s*\/dev\/(?:sd|hd|vd|nvme|mmcblk|disk)/, warn: '重定向写裸设备' },
  { pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&[^}]*\}/, warn: 'fork 炸弹' },
];

export function dangerWarnings(command: string): string[] {
  return DANGER_PATTERNS.filter(({ pattern }) => pattern.test(command)).map(({ warn }) => warn);
}

function bashCommand(name: string, input: unknown): string {
  if (name !== 'bash' || input === null || typeof input !== 'object') return '';
  const v = (input as Record<string, unknown>).command;
  return typeof v === 'string' ? v : '';
}

interface PreviewLine {
  text: string;
  tone?: 'add' | 'del';
}

/** edit_file 的 old/new 逐行对照；write_file 的待写内容。 */
export function buildPreview(name: string, input: unknown): PreviewLine[] | null {
  if (input === null || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (name === 'edit_file' && typeof obj.old_string === 'string' && typeof obj.new_string === 'string') {
    const out: PreviewLine[] = [];
    for (const l of obj.old_string.split('\n')) out.push({ text: `- ${l}`, tone: 'del' });
    for (const l of obj.new_string.split('\n')) out.push({ text: `+ ${l}`, tone: 'add' });
    return out;
  }
  if (name === 'write_file' && typeof obj.content === 'string') {
    return obj.content.split('\n').map((l) => ({ text: l }));
  }
  return null;
}

function argSummary(input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  for (const key of ['command', 'path', 'pattern']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v.length > 120 ? `${v.slice(0, 120)}…` : v;
  }
  return '';
}

// ------------------------------------------------------------------ 工具审批

export type ApprovalOutcome =
  | { kind: 'allow' }
  | { kind: 'allow-session' }
  | { kind: 'deny'; feedback?: string };

type ApprovalValue = 'allow' | 'allow-session' | 'deny' | 'deny-feedback';

/**
 * 工具审批块。四选项与 Ink 版一致：允许一次 / 本会话都允许 / 拒绝 / 拒绝并写评论，
 * 对应 y / a / n / f 与数字 1-4；Ctrl+E 展开被折叠的预览。
 */
export class InlineApproval extends ChoiceBlock<ApprovalValue> {
  private readonly toolName: string;
  private readonly input: unknown;
  private readonly done: (outcome: ApprovalOutcome) => void;
  private expanded = false;
  private readonly preview: PreviewLine[] | null;

  constructor(
    toolName: string,
    input: unknown,
    requestRender: () => void,
    done: (outcome: ApprovalOutcome) => void,
  ) {
    const choices: Choice<ApprovalValue>[] = [
      { label: '允许一次', hotkeys: ['y'], value: 'allow' },
      { label: '本会话都允许', hotkeys: ['a'], value: 'allow-session' },
      { label: '拒绝', hotkeys: ['n'], value: 'deny' },
      { label: '拒绝并说明原因', hotkeys: ['f'], value: 'deny-feedback', requiresFeedback: true },
    ];
    super(choices, requestRender);
    this.toolName = toolName;
    this.input = input;
    this.done = done;
    this.preview = buildPreview(toolName, input);
  }

  protected onChoose(value: ApprovalValue, feedback?: string): void {
    if (value === 'allow') return this.done({ kind: 'allow' });
    if (value === 'allow-session') return this.done({ kind: 'allow-session' });
    this.done({ kind: 'deny', feedback });
  }

  protected onCancel(): void {
    this.done({ kind: 'deny' });
  }

  protected override onOtherKey(data: string): void {
    if (matchesKey(data, 'ctrl+e') && this.preview !== null && this.preview.length > PREVIEW_LIMIT) {
      this.expanded = !this.expanded;
      this.render(0);
    }
  }

  protected override hintLine(): string {
    const base = '↑↓ 选择 · Enter 确认 · y/a/n/f 直选 · Esc 拒绝';
    return this.preview !== null && this.preview.length > PREVIEW_LIMIT
      ? `${base} · Ctrl+E ${this.expanded ? '收起' : '展开'}预览`
      : base;
  }

  protected renderBody(width: number): string[] {
    const out: string[] = [];
    out.push(c.warn(TITLES[this.toolName] ?? `允许调用 ${this.toolName} 吗`));
    for (const warn of dangerWarnings(bashCommand(this.toolName, this.input))) {
      out.push(c.error(`  ⚠ ${warn}`));
    }
    const arg = argSummary(this.input);
    if (arg !== '') {
      for (const line of wrapTextWithAnsi(c.toolArg(arg), Math.max(1, width - 2))) out.push(`  ${line}`);
    }
    if (this.preview !== null && this.preview.length > 0) {
      const shown = this.expanded ? this.preview : this.preview.slice(0, PREVIEW_LIMIT);
      for (const line of shown) {
        const colored = line.tone === 'add' ? c.ok(line.text) : line.tone === 'del' ? c.error(line.text) : c.dim(line.text);
        out.push(`  ${truncateToWidth(colored, Math.max(1, width - 2))}`);
      }
      if (!this.expanded && this.preview.length > PREVIEW_LIMIT) {
        out.push(c.dim(`  ↳ 还有 ${this.preview.length - PREVIEW_LIMIT} 行（Ctrl+E 展开）`));
      }
    }
    return out;
  }
}

// ------------------------------------------------------------------ 计划确认

export type PlanOutcome = { approved: boolean; feedback?: string };

type PlanValue = 'approve' | 'reject-feedback' | 'reject';

/** exit_plan_mode 的确认块：正文走 markdown（计划几乎总是 markdown）。 */
export class PlanApproval extends ChoiceBlock<PlanValue> {
  private readonly done: (outcome: PlanOutcome) => void;
  private readonly markdown: Markdown;

  constructor(plan: string, requestRender: () => void, done: (outcome: PlanOutcome) => void) {
    super(
      [
        { label: '按这个计划执行', hotkeys: ['y'], value: 'approve' },
        { label: '拒绝并说明如何修订', hotkeys: ['f'], value: 'reject-feedback', requiresFeedback: true },
        { label: '拒绝', hotkeys: ['n'], value: 'reject' },
      ],
      requestRender,
    );
    this.done = done;
    this.markdown = new Markdown(plan, 0, 0, markdownTheme);
  }

  protected onChoose(value: PlanValue, feedback?: string): void {
    this.done({ approved: value === 'approve', feedback });
  }

  protected onCancel(): void {
    this.done({ approved: false });
  }

  protected override hintLine(): string {
    return '↑↓ 选择 · Enter 确认 · y/f/n 直选 · Esc 拒绝';
  }

  protected renderBody(width: number): string[] {
    return [c.accent('计划已就绪，确认后退出计划模式并开始执行'), ...this.markdown.render(Math.max(1, width - 2)).map((l) => `  ${l}`)];
  }
}

// ------------------------------------------------------------------ 向用户提问

/**
 * ask_user 的提问块：多题逐题问，答完一次性回传 { 问题原文: 答案 }。
 * 与 Ink 版 QuestionPrompt 语义一致：
 *   ↑↓ 移动光标（末项之后是自由输入行）· 空格勾选（多选）· Enter 确认本题/进下一题
 *   ← → 上一题/下一题 · Esc 取消（回空字典）
 * 自由输入项由系统追加，不要求模型自带 Other。
 */
export class QuestionPrompt {
  private readonly req: AskUserRequest;
  private readonly done: (answers: QuestionAnswers) => void;
  private readonly requestRender: () => void;
  private qIdx = 0;
  private settled = false;
  /** 每题的交互现场：光标、勾选集、自由输入草稿（切题保留）。 */
  private readonly slots: { cursor: number; checked: Set<number>; other: string }[];
  private readonly answers: QuestionAnswers = {};

  constructor(req: AskUserRequest, requestRender: () => void, done: (answers: QuestionAnswers) => void) {
    this.req = req;
    this.done = done;
    this.requestRender = requestRender;
    this.slots = req.questions.map(() => ({ cursor: 0, checked: new Set<number>(), other: '' }));
  }

  invalidate(): void {
    // 无缓存
  }

  private get question(): AskUserQuestion {
    return this.req.questions[this.qIdx]!;
  }

  private get slot(): { cursor: number; checked: Set<number>; other: string } {
    return this.slots[this.qIdx]!;
  }

  /** 自由输入行的光标位置 = 选项数（排在最后一项之后）。 */
  private get otherIndex(): number {
    return this.question.options.length;
  }

  private settle(answers: QuestionAnswers): void {
    if (this.settled) return;
    this.settled = true;
    this.done(answers);
  }

  /** 收下本题答案；最后一题则整体回传。 */
  private commitAndAdvance(): void {
    const q = this.question;
    const slot = this.slot;
    if (slot.cursor === this.otherIndex) {
      const text = slot.other.trim();
      if (text === '') return; // 自由输入为空时不放行，避免记下空答案
      this.answers[q.question] = q.multi_select === true ? [text] : text;
    } else if (q.multi_select === true) {
      const picked = [...slot.checked].sort((a, b) => a - b).map((i) => q.options[i]!.label);
      const withOther = slot.other.trim() !== '' ? [...picked, slot.other.trim()] : picked;
      if (withOther.length === 0) return; // 多选未勾任何项时不放行
      this.answers[q.question] = withOther;
    } else {
      this.answers[q.question] = q.options[slot.cursor]!.label;
    }
    if (this.qIdx === this.req.questions.length - 1) {
      this.settle(this.answers);
      return;
    }
    this.qIdx += 1;
    this.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      this.settle({});
      return;
    }
    const q = this.question;
    const slot = this.slot;
    const last = this.otherIndex; // 含自由输入行
    if (matchesKey(data, 'up')) {
      slot.cursor = (slot.cursor - 1 + last + 1) % (last + 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'down')) {
      slot.cursor = (slot.cursor + 1) % (last + 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'left') && this.qIdx > 0) {
      this.qIdx -= 1;
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'right') && this.qIdx < this.req.questions.length - 1) {
      this.qIdx += 1;
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'enter')) {
      this.commitAndAdvance();
      return;
    }
    // 自由输入行：字符进草稿
    if (slot.cursor === last) {
      if (matchesKey(data, 'backspace') || matchesKey(data, 'delete')) {
        slot.other = [...slot.other].slice(0, -1).join('');
        this.requestRender();
        return;
      }
      if (data.length === 1 && data.charCodeAt(0) >= 32 && !data.startsWith('\x1b')) {
        slot.other += data;
        this.requestRender();
        return;
      }
      return;
    }
    if (data === ' ' && q.multi_select === true) {
      if (slot.checked.has(slot.cursor)) slot.checked.delete(slot.cursor);
      else slot.checked.add(slot.cursor);
      this.requestRender();
      return;
    }
    const digit = Number(data);
    if (Number.isInteger(digit) && digit >= 1 && digit <= q.options.length) {
      slot.cursor = digit - 1;
      if (q.multi_select === true) {
        if (slot.checked.has(slot.cursor)) slot.checked.delete(slot.cursor);
        else slot.checked.add(slot.cursor);
        this.requestRender();
      } else {
        this.commitAndAdvance();
      }
    }
  }

  render(width: number): string[] {
    const q = this.question;
    const slot = this.slot;
    const out: string[] = [];
    const counter = this.req.questions.length > 1 ? `[${this.qIdx + 1}/${this.req.questions.length}] ` : '';
    const header = q.header !== undefined && q.header !== '' ? `[${q.header}] ` : '';
    const multi = q.multi_select === true ? c.dim('（空格多选）') : '';
    out.push(...wrapTextWithAnsi(`${c.accent(counter)}${c.dim(header)}${q.question}${multi}`, Math.max(1, width)));
    q.options.forEach((opt, i) => {
      const on = slot.cursor === i;
      const box = q.multi_select === true ? (slot.checked.has(i) ? '[✓] ' : '[ ] ') : '';
      const desc = opt.description !== undefined && opt.description !== '' ? c.dim(`  — ${opt.description}`) : '';
      const label = on ? c.toolName(opt.label) : opt.label;
      out.push(truncateToWidth(`${on ? c.toolName('→ ') : '  '}${box}[${i + 1}] ${label}${desc}`, width));
    });
    const onOther = slot.cursor === this.otherIndex;
    const otherText = slot.other === '' ? c.dim('自己写一个答案') : slot.other;
    out.push(truncateToWidth(`${onOther ? c.toolName('→ ') : '  '}${otherText}${onOther ? '▌' : ''}`, width));
    out.push(
      c.dim(
        this.req.questions.length > 1
          ? '↑↓ 移动 · Enter 确认 · ←→ 切题 · Esc 取消'
          : '↑↓ 移动 · Enter 确认 · Esc 取消',
      ),
    );
    out.push('');
    return out;
  }
}
