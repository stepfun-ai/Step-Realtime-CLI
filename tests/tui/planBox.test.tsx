import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { PlanBox, planBoxRows } from '../../src/tui/PlanBox.js';

/**
 * 计划确认框（exit_plan_mode 的审批 UI）。
 *
 * 改造前只有 y/n/Esc 三个键、正文纯文本平铺；本组测试锁住两件事：
 * 1. 交互：↑↓ 选择 + Enter、数字直选、y/n 肌肉记忆、以及新增的「拒绝并说明修订意见」反馈通道；
 * 2. 行数：planBoxRows 不得低估真实渲染行数（低估会让动态帧触线，Ink 走全量清屏清空 scrollback）。
 *
 * 注意：ink 的 useInput 处理按键后要等 React 提交状态，连续按键之间必须 await delay
 * （与 approvalPrompt.test.tsx 同一模式）。少了这步，第二个按键会落在旧状态上。
 */

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const SIMPLE_PLAN = '## 步骤\n\n1. 改造组件\n2. 补充测试';

/** 真实渲染帧的行数。 */
function frameRows(plan: string, width: number): number {
  const { lastFrame } = render(<PlanBox plan={plan} onResolve={() => {}} termWidth={width} />);
  const frame = lastFrame() ?? '';
  return frame === '' ? 0 : frame.replace(/\n$/, '').split('\n').length;
}

describe('PlanBox 渲染', () => {
  it('计划正文按 markdown 渲染（标题不再是裸文本）', () => {
    const { lastFrame } = render(
      <PlanBox plan={'# 大标题\n\n- 项目一\n- 项目二'} onResolve={() => {}} termWidth={80} />,
    );
    const out = lastFrame() ?? '';
    // 列表渲染成 • 标记，证明走了 Markdown 而不是原样输出 '- 项目一'
    expect(out).toContain('•');
    expect(out).toContain('项目一');
  });

  it('表格在框内渲染出边框，不塌成一行', () => {
    const plan = ['| 文件 | 改动 |', '| --- | --- |', '| PlanBox.tsx | 新建 |'].join('\n');
    const { lastFrame } = render(<PlanBox plan={plan} onResolve={() => {}} termWidth={80} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('┌'); // 表格外框
    expect(out).toContain('PlanBox.tsx');
  });

  it('三个选项与快捷键提示都在', () => {
    const { lastFrame } = render(<PlanBox plan={SIMPLE_PLAN} onResolve={() => {}} termWidth={80} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('[1]');
    expect(out).toContain('[2]');
    expect(out).toContain('[3]');
    expect(out).toContain('↑↓');
  });
});

describe('PlanBox 交互', () => {
  it('y 直接批准', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<PlanBox plan={SIMPLE_PLAN} onResolve={onResolve} termWidth={80} />);
    await delay(20);
    stdin.write('y');
    await delay(20);
    expect(onResolve).toHaveBeenCalledWith(true);
  });

  it('n 直接拒绝（无反馈）', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<PlanBox plan={SIMPLE_PLAN} onResolve={onResolve} termWidth={80} />);
    await delay(20);
    stdin.write('n');
    await delay(20);
    expect(onResolve).toHaveBeenCalledWith(false);
  });

  it('Esc 直接拒绝', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<PlanBox plan={SIMPLE_PLAN} onResolve={onResolve} termWidth={80} />);
    await delay(20);
    stdin.write('\x1B');
    await delay(20);
    expect(onResolve).toHaveBeenCalledWith(false);
  });

  it('Enter 提交当前选中项（默认第一项=批准）', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<PlanBox plan={SIMPLE_PLAN} onResolve={onResolve} termWidth={80} />);
    await delay(20);
    stdin.write('\r');
    await delay(20);
    expect(onResolve).toHaveBeenCalledWith(true);
  });

  it('↓ 移到第三项后 Enter = 拒绝', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<PlanBox plan={SIMPLE_PLAN} onResolve={onResolve} termWidth={80} />);
    await delay(20);
    stdin.write('\x1B[B'); // ↓ 到第 2 项
    await delay(20);
    stdin.write('\x1B[B'); // ↓ 到第 3 项
    await delay(20);
    stdin.write('\r');
    await delay(20);
    expect(onResolve).toHaveBeenCalledWith(false);
  });

  it('↑ 从首项回卷到末项（拒绝）', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<PlanBox plan={SIMPLE_PLAN} onResolve={onResolve} termWidth={80} />);
    await delay(20);
    stdin.write('\x1B[A'); // ↑ 回卷到第 3 项
    await delay(20);
    stdin.write('\r');
    await delay(20);
    expect(onResolve).toHaveBeenCalledWith(false);
  });

  it('数字键 3 直选拒绝', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<PlanBox plan={SIMPLE_PLAN} onResolve={onResolve} termWidth={80} />);
    await delay(20);
    stdin.write('3');
    await delay(20);
    expect(onResolve).toHaveBeenCalledWith(false);
  });

  it('选第二项进入反馈输入，不立即提交', async () => {
    const onResolve = vi.fn();
    const { stdin, lastFrame } = render(
      <PlanBox plan={SIMPLE_PLAN} onResolve={onResolve} termWidth={80} />,
    );
    await delay(20);
    stdin.write('2');
    await delay(20);
    expect(onResolve).not.toHaveBeenCalled(); // 关键：先收意见，不马上拒绝
    stdin.write('改用方案B');
    await delay(20);
    expect(lastFrame()).toContain('改用方案B'); // 输入回显
  });

  it('反馈输入后 Enter：带 feedback 拒绝', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<PlanBox plan={SIMPLE_PLAN} onResolve={onResolve} termWidth={80} />);
    await delay(20);
    stdin.write('f'); // f 进反馈模式
    await delay(20);
    stdin.write('步骤2应该先做');
    await delay(20);
    stdin.write('\r');
    await delay(20);
    expect(onResolve).toHaveBeenCalledWith(false, '步骤2应该先做');
  });

  it('反馈为空时按 Enter 等同普通拒绝（feedback 为 undefined 而非空串）', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<PlanBox plan={SIMPLE_PLAN} onResolve={onResolve} termWidth={80} />);
    await delay(20);
    stdin.write('f');
    await delay(20);
    stdin.write('\r');
    await delay(20);
    expect(onResolve).toHaveBeenCalledWith(false, undefined);
  });

  it('反馈模式下退格删字符', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<PlanBox plan={SIMPLE_PLAN} onResolve={onResolve} termWidth={80} />);
    await delay(20);
    stdin.write('f');
    await delay(20);
    stdin.write('abc');
    await delay(20);
    stdin.write('\x7F'); // backspace
    await delay(20);
    stdin.write('\r');
    await delay(20);
    expect(onResolve).toHaveBeenCalledWith(false, 'ab');
  });

  it('反馈模式下按方向键退出输入并移动选中', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<PlanBox plan={SIMPLE_PLAN} onResolve={onResolve} termWidth={80} />);
    await delay(20);
    stdin.write('f');
    await delay(20);
    stdin.write('x');
    await delay(20);
    stdin.write('\x1B[A'); // ↑ 退出反馈模式，从第 2 项回到第 1 项
    await delay(20);
    stdin.write('\r');
    await delay(20);
    // 已退出反馈模式，Enter 提交选中的第 1 项（批准），不带 feedback
    expect(onResolve).toHaveBeenCalledWith(true);
  });

  it('反馈模式下 Esc 仍直接拒绝（不带已输入的文本）', async () => {
    const onResolve = vi.fn();
    const { stdin } = render(<PlanBox plan={SIMPLE_PLAN} onResolve={onResolve} termWidth={80} />);
    await delay(20);
    stdin.write('f');
    await delay(20);
    stdin.write('写了一半');
    await delay(20);
    stdin.write('\x1B');
    await delay(20);
    expect(onResolve).toHaveBeenCalledWith(false);
  });
});

describe('planBoxRows 行数预算', () => {
  it('不低估真实渲染行数（简单计划）', () => {
    for (const w of [40, 60, 80, 120]) {
      expect(planBoxRows(SIMPLE_PLAN, w)).toBeGreaterThanOrEqual(frameRows(SIMPLE_PLAN, w));
    }
  });

  it('不低估真实渲染行数（含表格——最容易低估的场景）', () => {
    const plan = [
      '## 影响文件',
      '',
      '| 文件 | 改动 | 备注 |',
      '| --- | --- | --- |',
      '| PlanBox.tsx | 新建 | 含交互 |',
      '| App.tsx | 改三处 | 渲染/估算/按键 |',
    ].join('\n');
    for (const w of [50, 80, 100]) {
      expect(planBoxRows(plan, w)).toBeGreaterThanOrEqual(frameRows(plan, w));
    }
  });

  it('不低估真实渲染行数（含代码块与长段落）', () => {
    const plan = ['# 计划', '', '说明文字'.repeat(30), '', '```ts', 'const a = 1;', '```'].join('\n');
    for (const w of [40, 80]) {
      expect(planBoxRows(plan, w)).toBeGreaterThanOrEqual(frameRows(plan, w));
    }
  });

  it('反馈模式不改变行数（选项行原地变输入行）', async () => {
    const before = frameRows(SIMPLE_PLAN, 80);
    const { stdin, lastFrame } = render(
      <PlanBox plan={SIMPLE_PLAN} onResolve={() => {}} termWidth={80} />,
    );
    await delay(20);
    stdin.write('f');
    await delay(20);
    const after = (lastFrame() ?? '').replace(/\n$/, '').split('\n').length;
    expect(after).toBe(before);
    expect(planBoxRows(SIMPLE_PLAN, 80)).toBeGreaterThanOrEqual(after);
  });
});
