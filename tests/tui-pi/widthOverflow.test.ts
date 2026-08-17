/**
 * 宽度溢出回归测试：所有 block 类型的 render 输出不得超过终端宽度。
 *
 * 2026-08-17 第二次崩溃：cron prompt 992 字符作为单行输出，终端只有 67 列。
 * pi-tui 的 doRender 有断言：Rendered line exceeds terminal width → 进程崩溃。
 * 之前已修过 thinking 预览的 spinner 前缀超宽，这次是 cron block 同类型问题。
 */
import { describe, expect, it } from 'vitest';
import { ItemBlock } from '../../src/tui-pi/blocks.js';
import type { DisplayItem } from '../../src/chat/types.js';

function checkNoOverflow(label: string, item: DisplayItem, widths: number[]): void {
  const block = new ItemBlock(item);
  for (const w of widths) {
    const lines = block.render(w);
    for (let i = 0; i < lines.length; i++) {
      // 去掉 ANSI 后测可见宽度
      const vis = lines[i].replace(/\x1b\[[0-9;]*m/g, '').replace(/\]8;;[^\x07]*\x07/g, '').length;
      expect(vis, `${label} width=${w} line ${i} 可见宽度 ${vis} > ${w}`).toBeLessThanOrEqual(w);
    }
  }
}

describe('block 渲染不得超宽', () => {
  const widths = [40, 60, 80];

  it('cron：长 prompt 不超宽', () => {
    const longPrompt = 'cron: 定时检查 AIASys 两条上游 PR 的 CI 状态。'.repeat(20);
    checkNoOverflow('cron', { kind: 'cron', data: { id: '1', cron: '* * * * *', prompt: longPrompt, recurring: true, coalesced: 0 } }, widths);
  });

  it('goalPanel：长 objective 不超宽', () => {
    const longObj = '在 step-code-pi 实验仓完成 Ink → pi-tui 的 TUI 层迁移。'.repeat(10);
    checkNoOverflow('goalPanel', { kind: 'goalPanel', data: { id: '1', objective: longObj } }, widths);
  });

  it('note：长文本不超宽', () => {
    const longText = '这是一段很长的提示文本。'.repeat(20);
    checkNoOverflow('note', { kind: 'note', text: longText }, widths);
  });

  it('assistant：长文本不超宽', () => {
    const longText = '这是一段很长的回复内容。'.repeat(20);
    checkNoOverflow('assistant', { kind: 'assistant', text: longText }, widths);
  });
});
