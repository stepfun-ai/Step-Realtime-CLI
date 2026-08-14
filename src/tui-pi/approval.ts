/**
 * 内联审批块（M1 最简形态）：工具调用需要确认时挂在编辑器上方，接管键盘焦点。
 *
 * 对齐 Ink 版 ApprovalPrompt 的键位：y 允许一次 · a 本会话都允许 · n / Esc 拒绝。
 * M2 会补上「拒绝时附文字反馈」与计划确认、ask_user 多选三桥的完整形态。
 */
import type { Component } from '@earendil-works/pi-tui';
import { matchesKey, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { summarizeInput } from './blocks.js';
import { c } from './theme.js';

export type ApprovalOutcome =
  | { kind: 'allow' }
  | { kind: 'allow-session' }
  | { kind: 'deny'; feedback?: string };

export class InlineApproval implements Component {
  private readonly toolName: string;
  private readonly input: unknown;
  private readonly done: (outcome: ApprovalOutcome) => void;
  private settled = false;

  constructor(toolName: string, input: unknown, done: (outcome: ApprovalOutcome) => void) {
    this.toolName = toolName;
    this.input = input;
    this.done = done;
  }

  invalidate(): void {
    // 无缓存：审批块生命周期很短，重排成本可忽略
  }

  private settle(outcome: ApprovalOutcome): void {
    if (this.settled) return;
    this.settled = true;
    this.done(outcome);
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'y') || matchesKey(data, 'enter')) return this.settle({ kind: 'allow' });
    if (matchesKey(data, 'a')) return this.settle({ kind: 'allow-session' });
    if (matchesKey(data, 'n') || matchesKey(data, 'escape')) return this.settle({ kind: 'deny' });
  }

  render(width: number): string[] {
    const arg = summarizeInput(this.input);
    const head = `${c.warn('需要确认')} ${c.toolName(this.toolName)}${arg !== '' ? ` ${c.toolArg(arg)}` : ''}`;
    const detail =
      arg === '' && this.input !== null && typeof this.input === 'object'
        ? wrapTextWithAnsi(c.dim(JSON.stringify(this.input).slice(0, 300)), Math.max(1, width - 2)).map((l) => `  ${l}`)
        : [];
    return [head, ...detail, c.dim('  y 允许 · a 本会话都允许 · n/Esc 拒绝'), ''];
  }
}
