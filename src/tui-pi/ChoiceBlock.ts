/**
 * 弹层交互块：选项列表 + 可选反馈输入的通用形态，审批三桥都用它。
 *
 * Ink 版三个组件（ApprovalPrompt / PlanBox / QuestionPrompt）各自实现了一遍
 * 「↑↓ 选择 + Enter 确认 + 数字直选 + Esc 取消 + 可选内联反馈输入」，三份状态机高度重复。
 * 命令式重写时没有 hooks 的约束，把这套交互抽成一个基类反而更自然，三桥只提供
 * 「正文怎么渲染」和「选项选完做什么」。
 *
 * 键位与 Ink 版逐项对齐（跨工具共享的终端肌肉记忆优先于创新，见迁移设计的「可比」目标）。
 */
import type { Component } from '@earendil-works/pi-tui';
import { matchesKey, parseKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { c } from './theme.js';
import { t } from '../i18n.js';
import { renderScrolledInput } from './scrollInput.js';

export interface Choice<T> {
  label: string;
  /** 直选键（如 'y' / 'a' / 'n' / 'f'）；数字键按序号自动支持。 */
  hotkeys?: readonly string[];
  /** 选中后先进反馈输入模式，再随反馈一起提交。 */
  requiresFeedback?: boolean;
  value: T;
}

/**
 * 选项列表基类。子类实现 renderBody 提供正文，onChoose 收结果。
 * Esc 走 onCancel（三桥语义都是「取消 = 拒绝/放弃」，但具体回什么由子类定）。
 */
export abstract class ChoiceBlock<T> implements Component {
  protected selected = 0;
  protected feedbackMode = false;
  protected feedbackText = '';
  private settled = false;
  protected readonly choices: readonly Choice<T>[];
  private readonly requestRender: () => void;

  constructor(choices: readonly Choice<T>[], requestRender: () => void) {
    this.choices = choices;
    this.requestRender = requestRender;
  }

  invalidate(): void {
    // 弹层生命周期短，不做缓存
  }

  /** 正文区（题干、命令预览、计划 markdown 等）。 */
  protected abstract renderBody(width: number): string[];
  /** 选定某项（可能带反馈文本）时调用。 */
  protected abstract onChoose(value: T, feedback?: string): void;
  /** Esc 取消。 */
  protected abstract onCancel(): void;
  /** 底部提示行。 */
  protected hintLine(): string {
    return t('choice.hint');
  }

  protected settle(fn: () => void): void {
    if (this.settled) return;
    this.settled = true;
    fn();
  }

  protected submit(choice: Choice<T>): void {
    if (choice.requiresFeedback === true && !this.feedbackMode) {
      this.feedbackMode = true;
      this.selected = this.choices.indexOf(choice);
      this.requestRender();
      return;
    }
    const fb = this.feedbackText.trim();
    this.settle(() => this.onChoose(choice.value, fb === '' ? undefined : fb));
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      this.settle(() => this.onCancel());
      return;
    }
    if (this.feedbackMode) {
      if (matchesKey(data, 'enter')) {
        const choice = this.choices[this.selected];
        if (choice !== undefined) {
          const fb = this.feedbackText.trim();
          this.settle(() => this.onChoose(choice.value, fb === '' ? undefined : fb));
        }
        return;
      }
      if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
        // 与 Ink 版一致：方向键退出反馈模式并移动选中
        this.feedbackMode = false;
        this.move(matchesKey(data, 'up') ? -1 : 1);
        return;
      }
      if (matchesKey(data, 'backspace') || matchesKey(data, 'delete')) {
        this.feedbackText = [...this.feedbackText].slice(0, -1).join('');
        this.requestRender();
        return;
      }
      const printable = this.printable(data);
      if (printable !== undefined) {
        this.feedbackText += printable;
        this.requestRender();
      }
      return;
    }
    if (matchesKey(data, 'up')) return this.move(-1);
    if (matchesKey(data, 'down')) return this.move(1);
    if (matchesKey(data, 'enter')) {
      const choice = this.choices[this.selected];
      if (choice !== undefined) this.submit(choice);
      return;
    }
    // 数字直选
    const digit = Number(data);
    if (Number.isInteger(digit) && digit >= 1 && digit <= this.choices.length) {
      this.submit(this.choices[digit - 1]!);
      return;
    }
    // 字母直选
    for (const choice of this.choices) {
      for (const key of choice.hotkeys ?? []) {
        if (matchesKey(data, key as Parameters<typeof matchesKey>[1])) {
          this.submit(choice);
          return;
        }
      }
    }
    this.onOtherKey?.(data);
  }

  /** 子类可拦额外按键（如 Ctrl+E 展开预览、空格勾选）。 */
  protected onOtherKey?(data: string): void;

  protected move(delta: number): void {
    this.selected = (this.selected + delta + this.choices.length) % this.choices.length;
    this.requestRender();
  }

  /** 从按键数据里取可打印字符（过滤控制键与转义序列）。 */
  protected printable(data: string): string | undefined {
    if (data.length === 0) return undefined;
    const id = parseKey(data);
    if (id !== undefined && id.length > 1) return undefined;
    if (data.length === 1 && data.charCodeAt(0) < 32) return undefined;
    if (data.startsWith('\x1b')) return undefined;
    return data;
  }

  protected renderChoices(width: number): string[] {
    return this.choices.map((choice, i) => {
      const on = i === this.selected;
      const prefix = on ? c.toolName('▶ ') : '  ';
      if (on && this.feedbackMode) {
        // 反馈输入：横向滚动，光标（在末尾）始终在可视区，长文本不被截断成省略号
        const fbPrefix = `${prefix}${i + 1}. ${choice.label}: `;
        const prefixWidth = visibleWidth(fbPrefix);
        const textWidth = Math.max(1, width - prefixWidth);
        let text: string;
        if (this.feedbackText !== '') {
          text = renderScrolledInput(this.feedbackText, this.feedbackText.length, textWidth);
        } else {
          text = `\x1b[7m \x1b[27m${c.dim(t('choice.feedbackPlaceholder'))}`;
        }
        return `${fbPrefix}${text}`;
      }
      const label = on ? c.toolName(choice.label) : choice.label;
      return truncateToWidth(`${prefix}${i + 1}. ${label}`, width);
    });
  }

  render(width: number): string[] {
    // 出口统一截断每一行：renderBody 的标题/警告等行子类未必逐行截断，漏一行就会在窄终端
    // 撑超宽度、触发 pi-tui doRender 断言崩溃（ask_user/审批/计划弹层反复 width 崩溃的残留病根）。
    // 参照成熟实现的同一做法：render 出口对全部行 truncateToWidth。renderChoices 自身已截断，
    // 二次截断幂等无害。
    return [...this.renderBody(width), ...this.renderChoices(width), c.dim(this.hintLine()), ''].map((l) =>
      truncateToWidth(l, width),
    );
  }
}
