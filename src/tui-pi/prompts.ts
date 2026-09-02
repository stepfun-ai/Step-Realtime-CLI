/**
 * 审批三桥：工具审批、计划确认、向用户提问。
 *
 * 三者共用 ChoiceBlock 的选项列表交互，各自只提供正文与结果语义。
 */
import { Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { AskUserQuestion, AskUserRequest, QuestionAnswers } from '../tools/askUser.js';
import { t } from '../i18n.js';
import { ChoiceBlock, type Choice } from './ChoiceBlock.js';
import { c, markdownTheme } from './theme.js';
import { renderScrolledInput } from './scrollInput.js';
import { markdownTransform } from '../chat/markdownPrep.js';

/** 预览折叠行数上限。 */
const PREVIEW_LIMIT = 10;

/**
 * 按工具定制的审批标题：存 i18n key 而不是文案。
 *
 * 这一层原来是硬编码中文，于是英文 locale 下审批弹层整块不翻译。审批是要用户做决定的
 * 界面，看不懂等于没提示，所以这里的接线优先级高于其它面板。
 */
const TITLE_KEYS: Record<string, string> = {
  bash: 'approval.title.bash',
  write_file: 'approval.title.write',
  edit_file: 'approval.title.edit',
};

/**
 * bash 危险命令模式表（逐条保守匹配）。命中后在命令上方红标一行警告。
 * warn 存 i18n key：危险警告是安全信息，英文看不懂等于警告失效。
 */
const DANGER_PATTERNS: ReadonlyArray<{ pattern: RegExp; warnKey: string }> = [
  {
    pattern:
      /\brm\s+(?:-{1,2}[\w-]+\s+)*(?:-[\w-]*(?:r[\w-]*f|f[\w-]*r)[\w-]*|--recursive\b[^|;]*--force|--force\b[^|;]*--recursive)/,
    warnKey: 'approval.danger.rmRf',
  },
  { pattern: /\bsudo\b/, warnKey: 'approval.danger.sudo' },
  { pattern: /\b(?:curl|wget)\b[^|;]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, warnKey: 'approval.danger.pipeShell' },
  { pattern: /\bdd\b[^|;]*\bof=\/dev\//, warnKey: 'approval.danger.ddDevice' },
  { pattern: /\bmkfs(?:\.\w+)?\b/, warnKey: 'approval.danger.mkfs' },
  { pattern: /\bchmod\s+(?:-\S+\s+)*777\b/, warnKey: 'approval.danger.chmod777' },
  { pattern: />\s*\/dev\/(?:sd|hd|vd|nvme|mmcblk|disk)/, warnKey: 'approval.danger.rawDevice' },
  { pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&[^}]*\}/, warnKey: 'approval.danger.forkBomb' },
];

export function dangerWarnings(command: string): string[] {
  return DANGER_PATTERNS.filter(({ pattern }) => pattern.test(command)).map(({ warnKey }) => t(warnKey));
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
    // 行号 padStart(3) + │ 分隔符
    return obj.content.split('\n').map((l, i) => ({ text: `${String(i + 1).padStart(3)} │ ${l}` }));
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
  | { kind: 'allow'; feedback?: string }
  | { kind: 'allow-session' }
  | { kind: 'deny'; feedback?: string };

type ApprovalValue = 'allow' | 'allow-session' | 'allow-feedback' | 'deny' | 'deny-feedback';

/**
 * 工具审批块。五选项：允许一次 / 本会话都允许 / 允许并附言 / 拒绝 / 拒绝并写评论，
 * 对应 y / a / c / n / f 与数字键；Ctrl+E 展开被折叠的预览。
 * 「允许并附言」：批准本次调用的同时给模型带一句话（如「下次先跑测试再改」），
 * 附言由 PiChat 排队为回合后的跟进消息——权限通道只能回 decision，附言走队列。
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
      { label: t('approval.option.allowOnce'), hotkeys: ['y'], value: 'allow' },
      { label: t('approval.option.allowSession'), hotkeys: ['a'], value: 'allow-session' },
      { label: t('approval.option.allowWithFeedback'), hotkeys: ['c'], value: 'allow-feedback', requiresFeedback: true },
      { label: t('approval.option.deny'), hotkeys: ['n'], value: 'deny' },
      { label: t('approval.option.denyWithFeedback'), hotkeys: ['f'], value: 'deny-feedback', requiresFeedback: true },
    ];
    super(choices, requestRender);
    this.toolName = toolName;
    this.input = input;
    this.done = done;
    this.preview = buildPreview(toolName, input);
  }

  protected onChoose(value: ApprovalValue, feedback?: string): void {
    if (value === 'allow' || value === 'allow-feedback') return this.done({ kind: 'allow', feedback });
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
    const base = t('approval.hint.select');
    if (this.preview === null || this.preview.length <= PREVIEW_LIMIT) return base;
    const action = t(this.expanded ? 'approval.hint.collapse' : 'approval.hint.expand');
    return base + t('approval.hint.previewToggle', { action });
  }

  protected renderBody(width: number): string[] {
    const out: string[] = [];
    const titleKey = TITLE_KEYS[this.toolName];
    out.push(c.warn(titleKey !== undefined ? t(titleKey) : t('approval.title', { name: this.toolName })));
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
        out.push(c.dim(t('approval.preview.more', { rest: this.preview.length - PREVIEW_LIMIT })));
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
  private expanded = false;

  constructor(plan: string, requestRender: () => void, done: (outcome: PlanOutcome) => void) {
    super(
      [
        { label: t('plan.option.approve'), hotkeys: ['y'], value: 'approve' },
        { label: t('plan.option.rejectWithFeedback'), hotkeys: ['f'], value: 'reject-feedback', requiresFeedback: true },
        { label: t('plan.option.reject'), hotkeys: ['n'], value: 'reject' },
      ],
      requestRender,
    );
    this.done = done;
    this.markdown = new Markdown(plan, 0, 0, markdownTheme, undefined, { transform: markdownTransform });
  }

  protected onChoose(value: PlanValue, feedback?: string): void {
    this.done({ approved: value === 'approve', feedback });
  }

  protected onCancel(): void {
    this.done({ approved: false });
  }

  protected override onOtherKey(data: string): void {
    if (matchesKey(data, 'ctrl+e')) {
      this.expanded = !this.expanded;
      this.render(0);
    }
  }

  protected override hintLine(): string {
    const base = t('plan.hint');
    const lines = this.markdown.render(10000);
    if (lines.length <= PREVIEW_LIMIT) return base;
    const action = t(this.expanded ? 'approval.hint.collapse' : 'approval.hint.expand');
    return base + t('approval.hint.previewToggle', { action });
  }

  protected renderBody(width: number): string[] {
    const lines = this.markdown.render(Math.max(1, width - 2));
    const shown = this.expanded ? lines : lines.slice(0, PREVIEW_LIMIT);
    const out = [c.accent(t('plan.confirmTitle')), ...shown.map((l) => `  ${l}`)];
    if (!this.expanded && lines.length > PREVIEW_LIMIT) {
      out.push(c.dim(t('approval.preview.more', { rest: lines.length - PREVIEW_LIMIT })));
    } else if (this.expanded && lines.length > PREVIEW_LIMIT) {
      out.push(c.dim(t('approval.preview.collapse', { total: lines.length })));
    }
    return out;
  }
}

// ------------------------------------------------------------------ 向用户提问

/**
 * ask_user 的提问块：多题逐题问，答完一次性回传 { 问题原文: 答案 }。
 * ↑↓ 移动光标（末项之后是自由输入行）· 空格勾选（多选）· Enter 确认/进下一题
 * ← → 上一题/下一题 · Esc 取消（回空字典）。自由输入项由系统追加。
 */
export class QuestionPrompt {
  private readonly req: AskUserRequest;
  private readonly done: (answers: QuestionAnswers) => void;
  private readonly requestRender: () => void;
  private qIdx = 0;
  private settled = false;
  /** 编辑态：光标在 Other 行时按 Enter 进入，↑↓/Esc 退出。与导航态分离，键位不再争用。 */
  private otherMode = false;
  /** 每题的交互现场：光标、勾选集、自由输入草稿与光标位置（切题保留）。 */
  private readonly slots: { cursor: number; checked: Set<number>; other: string; otherCursor: number }[];
  private readonly answers: QuestionAnswers = {};

  constructor(req: AskUserRequest, requestRender: () => void, done: (answers: QuestionAnswers) => void) {
    this.req = req;
    this.done = done;
    this.requestRender = requestRender;
    this.slots = req.questions.map(() => ({ cursor: 0, checked: new Set<number>(), other: '', otherCursor: 0 }));
  }

  invalidate(): void {
    // 无缓存
  }

  private get question(): AskUserQuestion {
    return this.req.questions[this.qIdx]!;
  }

  private get slot(): { cursor: number; checked: Set<number>; other: string; otherCursor: number } {
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

  /** 收下本题答案并推进：跳到第一题未答题（回退改题后跳过已答题），全答完则汇总回传。 */
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
    // 跳过已答题：找任意未答题（非仅 qIdx+1），全答完才 settle。
    // 早前只做 qIdx+1，用户 ← 回退改题后会被逼着重走已答题。
    const next = this.req.questions.findIndex((qq) => this.answers[qq.question] === undefined);
    if (next === -1) {
      this.settle(this.answers);
    } else {
      this.qIdx = next;
      this.requestRender();
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      this.settle({});
      return;
    }

    // ── 编辑态：Other 行按 Enter 进入，↑↓/Esc 退出 ──
    if (this.otherMode) {
      const slot = this.slot;
      if (matchesKey(data, 'enter')) {
        const text = slot.other.trim();
        if (text === '') return; // 空文本不放行
        this.otherMode = false;
        slot.cursor = this.otherIndex;
        this.commitAndAdvance();
        return;
      }
      if (matchesKey(data, 'up')) {
        this.otherMode = false;
        slot.cursor = (slot.cursor - 1 + this.rowCount) % this.rowCount;
        this.requestRender();
        return;
      }
      if (matchesKey(data, 'down')) {
        this.otherMode = false;
        slot.cursor = (slot.cursor + 1) % this.rowCount;
        this.requestRender();
        return;
      }
      // ←→ 多题时切题（退出编辑态），单题时移动文本光标
      if (matchesKey(data, 'left') && this.req.questions.length > 1 && this.qIdx > 0) {
        this.otherMode = false;
        this.qIdx -= 1;
        this.requestRender();
        return;
      }
      if (matchesKey(data, 'right') && this.req.questions.length > 1 && this.qIdx < this.req.questions.length - 1) {
        this.otherMode = false;
        this.qIdx += 1;
        this.requestRender();
        return;
      }
      this.handleOtherTextEdit(data);
      return;
    }

    // ── 导航态 ──
    const q = this.question;
    const slot = this.slot;
    const last = this.otherIndex;

    if (matchesKey(data, 'up')) {
      slot.cursor = (slot.cursor - 1 + this.rowCount) % this.rowCount;
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'down')) {
      slot.cursor = (slot.cursor + 1) % this.rowCount;
      this.requestRender();
      return;
    }
    // 数字键 1-9 直选实选项：单选直选=确认，多选直选=切换勾选
    if (/^[1-9]$/.test(data)) {
      const n = Number(data) - 1;
      const optionCount = q.options.length;
      if (n < optionCount) {
        if (q.multi_select === true) {
          if (slot.checked.has(n)) slot.checked.delete(n);
          else slot.checked.add(n);
          slot.cursor = n;
        } else {
          slot.cursor = n;
          this.commitAndAdvance();
        }
        this.requestRender();
      }
      return;
    }
    // ←→ 切题（导航态下）
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
    if (data === ' ' && q.multi_select === true) {
      if (slot.checked.has(slot.cursor)) slot.checked.delete(slot.cursor);
      else slot.checked.add(slot.cursor);
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'enter')) {
      if (slot.cursor === last) {
        // 在 Other 行上按 Enter → 进入编辑态
        this.otherMode = true;
        this.requestRender();
      } else {
        this.commitAndAdvance();
      }
      return;
    }
  }

  /** 总行数 = 选项数 + 1（Other 行）。 */
  private get rowCount(): number {
    return this.otherIndex + 1;
  }

  /** 编辑态下的文本编辑处理。 */
  private handleOtherTextEdit(data: string): void {
    const slot = this.slot;
    if (matchesKey(data, 'left')) {
      if (slot.otherCursor > 0) { slot.otherCursor -= 1; this.requestRender(); }
      return;
    }
    if (matchesKey(data, 'right')) {
      if (slot.otherCursor < slot.other.length) { slot.otherCursor += 1; this.requestRender(); }
      return;
    }
    if (matchesKey(data, 'home') || matchesKey(data, 'ctrl+a')) {
      slot.otherCursor = 0;
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'end') || matchesKey(data, 'ctrl+e')) {
      slot.otherCursor = slot.other.length;
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'ctrl+w')) {
      const before = slot.other.slice(0, slot.otherCursor);
      const after = slot.other.slice(slot.otherCursor);
      const trimmed = before.replace(/\s*\S*\s*$/, '');
      slot.other = trimmed + after;
      slot.otherCursor = trimmed.length;
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'backspace')) {
      if (slot.otherCursor > 0) {
        slot.other = slot.other.slice(0, slot.otherCursor - 1) + slot.other.slice(slot.otherCursor);
        slot.otherCursor -= 1;
        this.requestRender();
      }
      return;
    }
    if (matchesKey(data, 'delete')) {
      if (slot.otherCursor < slot.other.length) {
        slot.other = slot.other.slice(0, slot.otherCursor) + slot.other.slice(slot.otherCursor + 1);
        this.requestRender();
      }
      return;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32 && !data.startsWith('\x1b')) {
      slot.other = slot.other.slice(0, slot.otherCursor) + data + slot.other.slice(slot.otherCursor);
      slot.otherCursor += 1;
      this.requestRender();
    }
  }

  render(width: number): string[] {
    const q = this.question;
    const slot = this.slot;
    const innerWidth = Math.max(10, width - 4); // 边框 2 + padding 2

    // 组装框内内容行
    const inner: string[] = [];

    // 题干行
    const counter = this.req.questions.length > 1 ? `[${this.qIdx + 1}/${this.req.questions.length}] ` : '';
    const header = q.header !== undefined && q.header !== '' ? `[${q.header}] ` : '';
    const multi = q.multi_select === true ? c.dim(t('question.multiHint')) : '';
    const questionLine = `${c.accent(counter)}${c.dim(header)}${c.bold(q.question)}${multi}`;
    inner.push(...wrapTextWithAnsi(questionLine, innerWidth));

    // 选项行
    q.options.forEach((opt, i) => {
      const on = slot.cursor === i;
      const box = q.multi_select === true ? (slot.checked.has(i) ? c.ok('[✓] ') : c.dim('[ ] ')) : '';
      const desc = opt.description !== undefined && opt.description !== '' ? c.dim(`  — ${opt.description}`) : '';
      const label = on ? c.toolName(opt.label) : opt.label;
      const prefix = on ? c.toolName('❯ ') : '  ';
      inner.push(truncateToWidth(`${prefix}${box}[${i + 1}] ${label}${desc}`, innerWidth));
    });

    // 自由输入行：导航态只显示标签（与 ink 版一致），编辑态显示文本 + ▌ 光标
    const onOther = slot.cursor === this.otherIndex;
    const otherLabel = t('question.other');
    const otherPrefix = onOther ? c.toolName('❯ ') : '  ';
    if (this.otherMode) {
      // 编辑态：横向滚动显示文本 + 反显光标，光标始终在可视区，长文本不被截断成省略号
      const prefix = `${otherPrefix}[${this.otherIndex + 1}] ${c.toolName(otherLabel)} `;
      const prefixWidth = visibleWidth(prefix);
      const textWidth = Math.max(1, innerWidth - prefixWidth);
      let text: string;
      if (slot.other !== '') {
        text = renderScrolledInput(slot.other, slot.otherCursor, textWidth);
      } else {
        // 空输入：反显光标 + 暗色占位符
        text = `\x1b[7m \x1b[27m${c.dim(t('question.otherPlaceholder'))}`;
      }
      inner.push(`${prefix}${text}`);
    } else {
      // 导航态：只显示标签，不显示文本（视觉上区分导航态和编辑态）
      inner.push(truncateToWidth(`${otherPrefix}[${this.otherIndex + 1}] ${onOther ? c.toolName(otherLabel) : otherLabel}`, innerWidth));
    }

    // 空行分隔
    inner.push('');

    // 提示行
    const hintText = this.req.questions.length > 1 ? t('question.hintMulti') : t('question.hint');
    inner.push(c.dim(hintText));

    // 画边框
    const frameWidth = Math.min(innerWidth, Math.max(...inner.map((l) => Math.min(visibleWidth(l), innerWidth))));
    const out: string[] = [];
    out.push(c.accent(`╭${'─'.repeat(frameWidth + 2)}╮`));
    for (const line of inner) {
      const w = visibleWidth(line);
      const padded = w < frameWidth ? line + ' '.repeat(frameWidth - w) : truncateToWidth(line, frameWidth);
      out.push(`${c.accent('│')} ${padded} ${c.accent('│')}`);
    }
    out.push(c.accent(`╰${'─'.repeat(frameWidth + 2)}╯`));
    out.push('');
    return out;
  }
}
