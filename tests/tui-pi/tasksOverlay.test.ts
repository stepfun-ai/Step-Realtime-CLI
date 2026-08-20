/**
 * `/tasks` 交互弹层：过滤、选择、停止确认、输出预览。
 */
import { describe, expect, it } from 'vitest';
import { TasksOverlay, filterTasks, sortTasks, taskRow } from '../../src/tui-pi/TasksOverlay.js';
import type { BackgroundTask } from '../../src/agent/background/manager.js';

function plain(lines: readonly string[]): string[] {
  // eslint-disable-next-line no-control-regex
  return lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
}

const NOW = Date.parse('2026-08-15T12:00:00Z');
const task = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id: over.id ?? 't1',
  command: over.command ?? 'npm test',
  status: over.status ?? 'running',
  startedAt: over.startedAt ?? '2026-08-15T11:59:30Z',
  output: over.output ?? '',
  ...over,
});

const TAB = '\t';
const ESC = '\x1b';

describe('filterTasks / sortTasks', () => {
  const tasks = [
    task({ id: 'run', status: 'running' }),
    task({ id: 'ok', status: 'completed' }),
    task({ id: 'bad', status: 'failed' }),
    task({ id: 'kill', status: 'killed' }),
  ];

  it('running / failed 精确筛，done 含 completed 与 killed', () => {
    expect(filterTasks(tasks, 'running').map((t) => t.id)).toEqual(['run']);
    expect(filterTasks(tasks, 'failed').map((t) => t.id)).toEqual(['bad']);
    expect(filterTasks(tasks, 'done').map((t) => t.id)).toEqual(['ok', 'kill']);
    expect(filterTasks(tasks, 'all')).toHaveLength(4);
  });

  it('排序：运行中在前，失败次之，同档按启动时间倒序', () => {
    const list = [
      task({ id: 'old-run', status: 'running', startedAt: '2026-08-15T10:00:00Z' }),
      task({ id: 'done', status: 'completed', startedAt: '2026-08-15T11:00:00Z' }),
      task({ id: 'new-run', status: 'running', startedAt: '2026-08-15T11:30:00Z' }),
      task({ id: 'fail', status: 'failed', startedAt: '2026-08-15T09:00:00Z' }),
    ];
    expect(sortTasks(list).map((t) => t.id)).toEqual(['new-run', 'old-run', 'fail', 'done']);
  });
});

describe('taskRow', () => {
  it('运行中带 ● 与用时；失败带 exit code', () => {
    const row = plain([taskRow(task({ status: 'running' }), NOW, false, 80)])[0]!;
    expect(row).toContain('●');
    expect(row).toContain('t1');
    expect(row).toContain('npm test');
    const failed = plain([taskRow(task({ status: 'failed', exitCode: 2, endedAt: '2026-08-15T11:59:50Z' }), NOW, false, 80)])[0]!;
    expect(failed).toContain('✗');
    expect(failed).toContain('exit 2');
  });

  it('选中行有 › 指针；超宽截断', () => {
    expect(plain([taskRow(task(), NOW, true, 80)])[0]!.startsWith('›')).toBe(true);
    const long = taskRow(task({ command: 'x'.repeat(300) }), NOW, false, 40);
    expect(plain([long])[0]!.length).toBeLessThanOrEqual(40);
  });
});

describe('TasksOverlay 交互', () => {
  function mk(tasks: BackgroundTask[]): {
    overlay: TasksOverlay;
    stopped: string[];
    opened: string[];
    closed: number[];
  } {
    const stopped: string[] = [];
    const opened: string[] = [];
    const closed: number[] = [];
    const overlay = new TasksOverlay({
      getTasks: () => tasks,
      stopTask: (id) => {
        stopped.push(id);
        return true;
      },
      openOutput: (t) => opened.push(t.id),
      requestRender: () => {},
      onClose: () => closed.push(1),
      now: () => NOW,
    });
    return { overlay, stopped, opened, closed };
  }

  const three = [
    task({ id: 'run1', status: 'running' }),
    task({ id: 'done1', status: 'completed', endedAt: '2026-08-15T11:59:50Z' }),
    task({ id: 'fail1', status: 'failed', exitCode: 1, endedAt: '2026-08-15T11:59:55Z' }),
  ];

  it('标题给过滤档与计数，列表逐条，底栏给键位', () => {
    const { overlay } = mk(three);
    const lines = plain(overlay.render(80));
    expect(lines[0]).toContain('后台任务 · 全部（3/3）');
    expect(lines.join('\n')).toContain('run1');
    expect(lines[lines.length - 1]).toContain('s 终止');
  });

  it('Tab 循环过滤：全部→运行中→已完成→失败→全部', () => {
    const { overlay } = mk(three);
    const label = (): string => plain(overlay.render(80))[0]!;
    expect(label()).toContain('全部');
    overlay.handleInput(TAB);
    expect(label()).toContain('运行中（1/3）');
    overlay.handleInput(TAB);
    expect(label()).toContain('已完成（1/3）');
    overlay.handleInput(TAB);
    expect(label()).toContain('失败（1/3）');
    overlay.handleInput(TAB);
    expect(label()).toContain('全部');
  });

  it('↓/j 移动选中，o/Enter 打开选中任务输出', () => {
    const { overlay, opened } = mk(three);
    overlay.handleInput('j');
    overlay.handleInput('o');
    expect(opened).toEqual(['fail1']); // 排序后第二条是 fail1
  });

  it('s 停止要二次确认：y 执行，n 取消', () => {
    const { overlay, stopped } = mk(three);
    overlay.handleInput('s');
    expect(plain(overlay.render(80)).join('\n')).toContain('终止任务 run1？[y/N]');
    overlay.handleInput('n');
    expect(stopped).toEqual([]);
    overlay.handleInput('s');
    overlay.handleInput('y');
    expect(stopped).toEqual(['run1']);
  });

  it('确认态下其它键位一律不生效（防手滑连按）', () => {
    const { overlay, stopped, closed } = mk(three);
    overlay.handleInput('s');
    overlay.handleInput('j');
    overlay.handleInput(TAB);
    overlay.handleInput('q');
    expect(closed).toEqual([]);
    expect(stopped).toEqual([]);
    expect(plain(overlay.render(80)).join('\n')).toContain('[y/N]');
  });

  it('已终态任务按 s 不进确认（只有运行中能停）', () => {
    const { overlay } = mk([task({ id: 'done1', status: 'completed' })]);
    overlay.handleInput('s');
    expect(plain(overlay.render(80)).join('\n')).not.toContain('[y/N]');
  });

  it('输出预览取尾部若干行；无输出给占位', () => {
    const { overlay } = mk([task({ id: 'o1', output: Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n') })]);
    const text = plain(overlay.render(80)).join('\n');
    expect(text).toContain('── 输出（o1）──');
    expect(text).toContain('line19');
    expect(text).not.toContain('line0\n');

    const { overlay: empty } = mk([task({ id: 'e1', output: '' })]);
    expect(plain(empty.render(80)).join('\n')).toContain('（暂无输出）');
  });

  it('空列表给对应文案；Esc/q 关闭', () => {
    const { overlay, closed } = mk([]);
    expect(plain(overlay.render(80)).join('\n')).toContain('当前没有后台任务');
    overlay.handleInput(ESC);
    expect(closed).toEqual([1]);
    const { overlay: o2, closed: c2 } = mk([]);
    o2.handleInput('q');
    expect(c2).toEqual([1]);
  });

  it('过滤后空列表提示带档位名', () => {
    const { overlay } = mk([task({ id: 'run1', status: 'running' })]);
    overlay.handleInput(TAB); // 运行中
    overlay.handleInput(TAB); // 已完成 → 空
    expect(plain(overlay.render(80)).join('\n')).toContain('没有已完成的任务');
  });

  it('选中任务展示详情栏：id / 状态 / 命令 / 时长 / 退出码', () => {
    const { overlay } = mk([
      task({ id: 'fail1', status: 'failed', exitCode: 1, endedAt: '2026-08-15T11:59:55Z' }),
    ]);
    const text = plain(overlay.render(80)).join('\n');
    expect(text).toContain('fail1');
    expect(text).toContain('失败'); // 状态
    expect(text).toContain('npm test'); // 命令
    expect(text).toContain('退出码');
    expect(text).toContain('1'); // exitCode
    expect(text).toContain('时长');
  });

  it('运行中任务详情栏显示「已运行 X」，终态显示「耗时 X」', () => {
    const running = mk([task({ id: 'run1', status: 'running', startedAt: '2026-08-15T11:59:00Z' })]);
    const runText = plain(running.overlay.render(80)).join('\n');
    expect(runText).toContain('已运行');

    const done = mk([task({ id: 'done1', status: 'completed', startedAt: '2026-08-15T11:59:00Z', endedAt: '2026-08-15T11:59:50Z' })]);
    const doneText = plain(done.overlay.render(80)).join('\n');
    expect(doneText).toContain('耗时');
  });

  it('有 agentType 的任务详情栏显示子类型', () => {
    const { overlay } = mk([
      task({ id: 'sub1', status: 'running', agentType: 'explore' }),
    ]);
    const text = plain(overlay.render(80)).join('\n');
    expect(text).toContain('子类型');
    expect(text).toContain('explore');
  });
});
