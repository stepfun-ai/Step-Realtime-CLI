/**
 * ⑥ 弹层路径统一：审批三桥从 overlayHost 收敛到 showOverlay。
 *
 * wiring 断言锁三个点：
 * 1. showPrompt 改用 tui.showOverlay（不再 overlayHost.clear/addChild）
 * 2. overlayHost 已完全移除（无字段、无 addChild、不在 render 列表）
 * 3. 三桥调用方（askApproval/askPlanApproval/提问）仍走 showPrompt
 *
 * 行为零变化靠全量 pnpm test 绿兜底（审批块的 render 已 truncateToWidth 自适应宽度）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(repoRoot, 'src', 'tui-pi', 'PiChat.ts'), 'utf8');

describe('⑥ 弹层路径统一', () => {
  it('showPrompt 改用 tui.showOverlay', () => {
    const body = src.slice(src.indexOf('private showPrompt<T>'), src.indexOf('private showPrompt<T>') + 600);
    expect(body).toContain('this.tui.showOverlay');
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

  it('审批 settle 时 hide overlay（而非 clear host）', () => {
    const body = src.slice(src.indexOf('private showPrompt<T>'), src.indexOf('private showPrompt<T>') + 600);
    expect(body).toContain('handle.hide()');
  });
});
