import { describe, expect, it } from 'vitest';
import { BackgroundManager } from '../../src/agent/background/manager.js';
import { taskListTool, taskOutputTool, taskStopTool } from '../../src/tools/task.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('BackgroundManager', () => {
  it('启动后台任务立即返回 id，完成后状态为 completed', async () => {
    const mgr = new BackgroundManager();
    const id = mgr.start('echo hi', process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/c', 'echo hi'] : ['-c', 'echo hi'], process.cwd());
    expect(id).toBeTruthy();
    expect(mgr.get(id)?.status).toBe('running');
    await sleep(400);
    expect(mgr.get(id)?.status).toBe('completed');
  });

  it('list 返回所有任务', async () => {
    const mgr = new BackgroundManager();
    mgr.start('a', process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/c', 'echo a'] : ['-c', 'echo a'], process.cwd());
    await sleep(300);
    expect(mgr.list().length).toBeGreaterThanOrEqual(1);
  });

  it('stop 终止运行中任务', async () => {
    const mgr = new BackgroundManager();
    const id = mgr.start(
      'sleep',
      process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      process.platform === 'win32' ? ['/c', 'ping -n 10 127.0.0.1 >nul'] : ['-c', 'sleep 5'],
      process.cwd(),
    );
    expect(mgr.stop(id)).toBe(true);
    expect(mgr.get(id)?.status).toBe('killed');
  });
});

describe('task 工具', () => {
  it('task_list 无后台管理器时报不支持', async () => {
    const r = await taskListTool.execute({}, { cwd: process.cwd() });
    expect(r.content).toContain('不支持');
  });

  it('task_output / task_stop 查询与终止', async () => {
    const mgr = new BackgroundManager();
    const id = mgr.start('echo hello', process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/c', 'echo hello'] : ['-c', 'echo hello'], process.cwd());
    await sleep(400);
    const out = await taskOutputTool.execute({ task_id: id }, { cwd: process.cwd(), background: mgr });
    expect(out.content).toContain('hello');
    const stop = await taskStopTool.execute({ task_id: id }, { cwd: process.cwd(), background: mgr });
    expect(stop.isError).toBe(true); // 已完成的任务无法再终止
  });
});
