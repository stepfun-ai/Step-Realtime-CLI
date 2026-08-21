/**
 * ⑥ 弹层路径：审批三桥的落位方式。
 *
 * 历史：overlayHost（常驻 Container）→ showOverlay 居中浮层 → 现版 inputSlot 内联替换。
 * 现版把交互块挂进 inputSlot 替换 editor（editor replacement），出现在对话底部、
 * 状态栏之上，不遮挡历史消息；居中浮层会盖住两侧消息历史，已弃用。
 *
 * wiring 断言锁三个点：
 * 1. showPrompt 内联挂载到 inputSlot（不再 showOverlay 浮层、不再 overlayHost）
 * 2. overlayHost 已完全移除（无字段、无 addChild、不在 render 列表）
 * 3. 三桥调用方（askApproval/askPlanApproval/提问）仍走 showPrompt
 *
 * 行为零变化靠全量 test 绿兜底（审批块的 render 已 truncateToWidth 自适应宽度）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(repoRoot, 'src', 'tui-pi', 'PiChat.ts'), 'utf8');

const showPromptBody = (): string =>
  src.slice(src.indexOf('private showPrompt<T>'), src.indexOf('private showPrompt<T>') + 800);

describe('⑥ 弹层路径（内联替换 editor）', () => {
  it('showPrompt 内联挂载到 inputSlot（不再 showOverlay 浮层）', () => {
    const body = showPromptBody();
    expect(body).toContain('this.inputSlot.addChild(block)');
    expect(body).toContain('this.tui.setFocus(block)');
    expect(body).not.toContain('showOverlay');
    expect(body).not.toContain('overlayHost');
  });

  it('overlayHost 字段已移除', () => {
    expect(src).not.toContain('overlayHost = new Container()');
  });

  it('overlayHost 不再 addChild 到 TUI', () => {
    expect(src).not.toContain('this.tui.addChild(this.overlayHost)');
  });

  it('overlayHost 不在 render 列表（rootComponents）', () => {
    const root = src.slice(src.indexOf('rootComponents'), src.indexOf('rootComponents') + 200);
    expect(root).not.toContain('overlayHost');
  });

  it('三桥仍走 showPrompt（入口未断）', () => {
    expect(src).toContain('this.showPrompt<ApprovalOutcome>');
    expect(src).toContain('this.showPrompt<PlanOutcome>');
  });

  it('审批 settle 时恢复 editor（inputSlot 换回，而非 hide overlay）', () => {
    const body = showPromptBody();
    expect(body).toContain('this.inputSlot.addChild(this.editor)');
    expect(body).toContain('this.tui.setFocus(this.editor)');
    expect(body).not.toContain('handle.hide()');
  });
});
