import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { BackgroundTask } from '../../src/agent/background/manager.js';
import { TasksViewer, type TasksViewerSource } from '../../src/tui/TasksViewer.js';

const delay = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 去掉 ANSI 颜色/反白码，便于对纯文本内容断言。 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function makeTask(over: Partial<BackgroundTask>): BackgroundTask {
  return {
    id: 't1',
    command: 'echo hi',
    status: 'running',
    startedAt: new Date().toISOString(),
    output: '',
    ...over,
  };
}

/** 可控数据源：tasks 可变，stop/suppressNotification 是 spy。 */
function makeSource(initial: BackgroundTask[]): TasksViewerSource & { tasks: BackgroundTask[] } {
  const state = {
    tasks: initial,
    list() {
      return state.tasks;
    },
    stop: vi.fn(() => true),
    suppressNotification: vi.fn(),
  };
  return state;
}

const renderViewer = (source: TasksViewerSource, onClose: () => void = () => {}, maxRows?: number) =>
  render(React.createElement(TasksViewer, { background: source, maxRows, onClose }));

describe('TasksViewer 空态与列表', () => {
  it('无任务：空态提示 + 底栏键位说明', async () => {
    const { lastFrame } = renderViewer(makeSource([]));
    await delay();
    const plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('暂无后台任务');
    expect(plain).toContain('Esc 关闭');
  });

  it('任务行：id · 状态 · label · 时长；选中任务的 tail 预览只留最后 8 行', async () => {
    const output = Array.from({ length: 10 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`).join('\n');
    const source = makeSource([
      makeTask({ id: 'ta', command: 'workflow·调研', output }),
      makeTask({ id: 'tb', command: '子agent·翻译', status: 'completed', output: 'done', endedAt: new Date().toISOString() }),
    ]);
    const { lastFrame } = renderViewer(source);
    await delay();
    const plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('ta');
    expect(plain).toContain('workflow·调研');
    expect(plain).toContain('运行中');
    expect(plain).toContain('tb');
    expect(plain).toContain('已完成');
    // tail 预览：选中第一行（ta），10 行输出只显示尾部 8 行
    expect(plain).toContain('输出预览（ta）');
    expect(plain).toContain('L03');
    expect(plain).toContain('L10');
    expect(plain).not.toContain('L01');
    expect(plain).not.toContain('L02');
  });

  it('↓/j 选择下一条，tail 预览跟着切换', async () => {
    const source = makeSource([
      makeTask({ id: 'ta', command: 'first', output: 'OUT-A' }),
      makeTask({ id: 'tb', command: 'second', output: 'OUT-B' }),
    ]);
    const { stdin, lastFrame } = renderViewer(source);
    await delay();
    expect(stripAnsi(lastFrame() ?? '')).toContain('输出预览（ta）');
    expect(stripAnsi(lastFrame() ?? '')).toContain('OUT-A');
    stdin.write('\x1b[B');
    await delay();
    let plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('输出预览（tb）');
    expect(plain).toContain('OUT-B');
    // k 回到第一条
    stdin.write('k');
    await delay();
    plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('输出预览（ta）');
    // j 再下一条
    stdin.write('j');
    await delay();
    expect(stripAnsi(lastFrame() ?? '')).toContain('输出预览（tb）');
  });

  it('r 手动刷新：新任务立即出现在列表里', async () => {
    const source = makeSource([makeTask({ id: 'ta', command: 'old' })]);
    const { stdin, lastFrame } = renderViewer(source);
    await delay();
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('fresh');
    source.tasks = [...source.tasks, makeTask({ id: 'tb', command: 'fresh' })];
    stdin.write('r');
    await delay();
    expect(stripAnsi(lastFrame() ?? '')).toContain('fresh');
  });

  it('Esc 触发 onClose', async () => {
    const onClose = vi.fn();
    const { stdin } = renderViewer(makeSource([makeTask({})]), onClose);
    await delay();
    stdin.write('\x1b');
    await delay();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('q 触发 onClose', async () => {
    const onClose = vi.fn();
    const { stdin } = renderViewer(makeSource([makeTask({})]), onClose);
    await delay();
    stdin.write('q');
    await delay();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('TasksViewer 过滤器循环（Tab）', () => {
  const fourTasks = (): BackgroundTask[] => [
    makeTask({ id: 'ta', command: 'cmd-run', status: 'running' }),
    makeTask({ id: 'tb', command: 'cmd-done', status: 'completed', endedAt: new Date().toISOString() }),
    makeTask({ id: 'tc', command: 'cmd-fail', status: 'failed', endedAt: new Date().toISOString() }),
    makeTask({ id: 'td', command: 'cmd-kill', status: 'killed', endedAt: new Date().toISOString() }),
  ];

  it('ALL → 运行中 → 已完成 → 失败/终止 → ALL，每态列表内容正确', async () => {
    const { stdin, lastFrame } = renderViewer(makeSource(fourTasks()));
    await delay();
    // ALL：四条都在
    let plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('filter=ALL');
    for (const cmd of ['cmd-run', 'cmd-done', 'cmd-fail', 'cmd-kill']) expect(plain).toContain(cmd);

    stdin.write('\t');
    await delay();
    plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('filter=运行中');
    expect(plain).toContain('cmd-run');
    expect(plain).not.toContain('cmd-done');
    expect(plain).not.toContain('cmd-fail');

    stdin.write('\t');
    await delay();
    plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('filter=已完成');
    expect(plain).toContain('cmd-done');
    expect(plain).not.toContain('cmd-run');

    stdin.write('\t');
    await delay();
    plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('filter=失败/终止');
    expect(plain).toContain('cmd-fail');
    expect(plain).toContain('cmd-kill');
    expect(plain).not.toContain('cmd-run');
    expect(plain).not.toContain('cmd-done');

    stdin.write('\t');
    await delay();
    plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('filter=ALL');
    expect(plain).toContain('cmd-done');
  });

  it('标题行计数基于过滤前全量，Tab 切换不抖动', async () => {
    const { stdin, lastFrame } = renderViewer(makeSource(fourTasks()));
    await delay();
    const expectCounts = (plain: string): void => {
      expect(plain).toContain('1 运行中');
      expect(plain).toContain('1 已完成');
      expect(plain).toContain('2 失败/终止');
      expect(plain).toContain('共 4 个');
    };
    expectCounts(stripAnsi(lastFrame() ?? ''));
    stdin.write('\t');
    await delay();
    expectCounts(stripAnsi(lastFrame() ?? ''));
    stdin.write('\t');
    await delay();
    expectCounts(stripAnsi(lastFrame() ?? ''));
  });
});

describe('TasksViewer 三栏布局（maxRows 窗口化）', () => {
  it('标题计数 + Detail 字段 + 预览尾部切片', async () => {
    const output = Array.from({ length: 12 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`).join('\n');
    const source = makeSource([
      makeTask({ id: 'ta', command: '调研任务', kind: 'subagent', agentType: 'explore', output }),
      makeTask({ id: 'tb', command: 'done-one', status: 'completed', endedAt: new Date().toISOString(), exitCode: 0 }),
    ]);
    const { lastFrame } = renderViewer(source, () => {}, 24);
    await delay();
    const plain = stripAnsi(lastFrame() ?? '');
    // 标题行
    expect(plain).toContain('filter=ALL');
    expect(plain).toContain('1 运行中');
    expect(plain).toContain('1 已完成');
    expect(plain).toContain('共 2 个');
    // Detail：选中的 ta（subagent/explore）
    expect(plain).toContain('任务 ID');
    expect(plain).toContain('状态');
    expect(plain).toContain('类别');
    expect(plain).toContain('子agent');
    expect(plain).toContain('Agent 类型');
    expect(plain).toContain('explore');
    expect(plain).toContain('已运行');
    expect(plain).toContain('描述');
    // 预览：body=21，预览内高 = 21-10-2=9，减标题行后尾部预算 8 行，12 行输出只留 L05-L12
    expect(plain).toContain('输出预览（ta）');
    expect(plain).toContain('L12');
    expect(plain).toContain('L05');
    expect(plain).not.toContain('L04');
    expect(plain).not.toContain('L01');
  });

  it('终态任务 Detail：结束相对时间 + 退出码', async () => {
    const source = makeSource([
      makeTask({ id: 'ta', command: 'proc-one', kind: 'process', status: 'failed', endedAt: new Date().toISOString(), exitCode: 2 }),
    ]);
    const { lastFrame } = renderViewer(source, () => {}, 24);
    await delay();
    const plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('进程');
    expect(plain).toContain('前结束');
    expect(plain).toContain('退出码');
    expect(plain).toContain('2');
  });

  it('窄终端（<60 列）退化为单列堆叠：详情栏消失，列表与输出预览仍在', async () => {
    const source = makeSource([makeTask({ id: 'ta', command: 'echo hi', output: 'out-line' })]);
    const inst = renderViewer(source, () => {}, 24);
    await delay();
    // 测试环境 stdout.columns 固定 100：先是三栏（有详情栏）
    expect(stripAnsi(inst.lastFrame() ?? '')).toContain('详情');
    // 覆盖实例的 columns getter 模拟 50 列窄终端，重渲染后应退化单列
    Object.defineProperty(inst.stdout, 'columns', { get: () => 50, configurable: true });
    inst.rerender(React.createElement(TasksViewer, { background: source, maxRows: 24, onClose: () => {} }));
    await delay();
    const plain = stripAnsi(inst.lastFrame() ?? '');
    expect(plain).not.toContain('详情');
    expect(plain).toContain('ta');
    expect(plain).toContain('输出预览（ta）');
    expect(plain).toContain('out-line');
  });
});

describe('TasksViewer settle 自动刷新', () => {
  it('面板打开期间任务转终态：1s 轮询后列表状态自动更新，无需按 r', async () => {
    const source = makeSource([makeTask({ id: 'ta', command: 'will-settle', status: 'running' })]);
    const { lastFrame } = renderViewer(source);
    await delay();
    expect(stripAnsi(lastFrame() ?? '')).toContain('运行中');
    // 模拟任务在后台 settle（manager 侧行为，面板无感知）
    source.tasks = [makeTask({ id: 'ta', command: 'will-settle', status: 'completed', endedAt: new Date().toISOString() })];
    // 等过一个轮询周期（1s）
    await delay(1300);
    const plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('已完成');
    expect(plain).not.toContain('cmd-placeholder');
  }, 5000);
});

describe('TasksViewer 完整输出模式（Enter/o）', () => {
  it('Enter 看全文（含 tail 预览里被截掉的早行），Esc 返回列表', async () => {
    const output = Array.from({ length: 10 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`).join('\n');
    const source = makeSource([makeTask({ id: 'ta', command: 'long-out', output })]);
    const { stdin, lastFrame } = renderViewer(source);
    await delay();
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('L01');
    stdin.write('\r');
    await delay();
    let plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('任务输出 ta · long-out');
    expect(plain).toContain('L01');
    expect(plain).toContain('L10');
    expect(plain).toContain('Esc/q 返回列表');
    stdin.write('\x1b');
    await delay();
    plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('输出预览（ta）');
    expect(plain).not.toContain('L01');
  });

  it('o 同样进入完整输出模式', async () => {
    const source = makeSource([makeTask({ id: 'ta', command: 'long-out', output: 'BODY' })]);
    const { stdin, lastFrame } = renderViewer(source);
    await delay();
    stdin.write('o');
    await delay();
    expect(stripAnsi(lastFrame() ?? '')).toContain('任务输出 ta · long-out');
  });
});

describe('TasksViewer 排序（运行中优先 / 同级启动时间倒序）', () => {
  const now = new Date().toISOString();
  const earlier = new Date(Date.now() - 60_000).toISOString(); // 60 秒前
  const oldest = new Date(Date.now() - 120_000).toISOString(); // 120 秒前

  const mixedTasks = (): BackgroundTask[] => [
    makeTask({ id: 'completed-old', command: 'z-completed', status: 'completed', startedAt: oldest, endedAt: now }),
    makeTask({ id: 'running-new', command: 'a-running', status: 'running', startedAt: now }),
    makeTask({ id: 'failed-mid', command: 'y-failed', status: 'failed', startedAt: earlier, endedAt: now }),
    makeTask({ id: 'running-old', command: 'b-running-old', status: 'running', startedAt: earlier }),
    makeTask({ id: 'completed-new', command: 'x-completed', status: 'completed', startedAt: now, endedAt: now }),
    makeTask({ id: 'killed-mid', command: 'w-killed', status: 'killed', startedAt: earlier, endedAt: now }),
  ];

  it('ALL 过滤：running 排最前，failed/killed 次之，completed 最后；同级启动时间倒序', async () => {
    const { lastFrame } = renderViewer(makeSource(mixedTasks()));
    await delay();
    const plain = stripAnsi(lastFrame() ?? '');
    // 顺序断言：running (a-running-new → b-running-old) → failed/killed (y-failed → w-killed) → completed (z-completed-old → x-completed-new)
    const idxA = plain.indexOf('a-running');
    const idxB = plain.indexOf('b-running-old');
    const idxY = plain.indexOf('y-failed');
    const idxW = plain.indexOf('w-killed');
    const idxZ = plain.indexOf('z-completed');
    const idxX = plain.indexOf('x-completed');
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxY).toBeGreaterThanOrEqual(0);
    // running 在前
    expect(idxA).toBeLessThan(idxY);
    expect(idxB).toBeLessThan(idxY);
    // failed/killed 在 completed 前
    expect(idxY).toBeLessThan(idxZ);
    expect(idxW).toBeLessThan(idxZ);
    // 同级 running：新的在前
    expect(idxA).toBeLessThan(idxB);
    // 同级 completed：新的在前
    expect(idxX).toBeLessThan(idxZ);
  });

  it('运行中过滤仍保持启动时间倒序', async () => {
    const source = makeSource(mixedTasks());
    const { stdin: s, lastFrame: lf } = renderViewer(source);
    await delay();
    s.write('\t');
    await delay();
    const plain = stripAnsi(lf() ?? '');
    expect(plain).toContain('filter=运行中');
    const idxA = plain.indexOf('a-running');
    const idxB = plain.indexOf('b-running-old');
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeLessThan(idxB); // 新的 running 在前
  });
});

describe('TasksViewer 停止确认', () => {
  it('终态任务按 s：提示已是终态，不调 stop', async () => {
    const source = makeSource([
      makeTask({ id: 'ta', status: 'completed', endedAt: new Date().toISOString() }),
    ]);
    const { stdin, lastFrame } = renderViewer(source);
    await delay();
    stdin.write('s');
    await delay();
    expect(stripAnsi(lastFrame() ?? '')).toContain('已是终态');
    expect(source.stop).not.toHaveBeenCalled();
  });

  it('运行中任务：s → y 确认，suppressNotification + stop 都按选中 id 调用', async () => {
    const source = makeSource([makeTask({ id: 'ta' })]);
    const { stdin, lastFrame } = renderViewer(source);
    await delay();
    stdin.write('s');
    await delay();
    expect(stripAnsi(lastFrame() ?? '')).toContain('确认停止 ta');
    stdin.write('y');
    await delay();
    expect(source.suppressNotification).toHaveBeenCalledWith('ta');
    expect(source.stop).toHaveBeenCalledWith('ta');
    expect(stripAnsi(lastFrame() ?? '')).toContain('已停止 ta');
  });

  it('运行中任务：s → n 取消，不调 stop', async () => {
    const source = makeSource([makeTask({ id: 'ta' })]);
    const { stdin, lastFrame } = renderViewer(source);
    await delay();
    stdin.write('s');
    await delay();
    stdin.write('n');
    await delay();
    expect(source.stop).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('确认停止');
  });

  it('确认态下 Esc 只取消确认、不关闭查看器', async () => {
    const onClose = vi.fn();
    const source = makeSource([makeTask({ id: 'ta' })]);
    const { stdin } = renderViewer(source, onClose);
    await delay();
    stdin.write('s');
    await delay();
    stdin.write('\x1b');
    await delay();
    expect(onClose).not.toHaveBeenCalled();
    expect(source.stop).not.toHaveBeenCalled();
  });
});
