import { describe, expect, it, vi, beforeEach } from 'vitest';

// 把 shellResolve 的 resolveShell mock 成 family='none'（模拟无任何可用 shell 的 Windows）。
// 单独文件隔离，避免污染 bash.test.ts 里依赖真实 shell 的集成用例。
vi.mock('../../src/tools/shellResolve.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/shellResolve.js')>();
  return {
    ...actual,
    resolveShell: () => ({ cmd: '', args: (c: string) => [c], family: 'none' as const }),
  };
});

import { bashTool } from '../../src/tools/bash.js';
import { BackgroundManager } from '../../src/agent/background/manager.js';

describe('family=none：无可用 shell 时明确报错（不回退 cmd.exe）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('前台执行：返回 isError 且引导装 Git Bash / 设 STEP_SHELL_PATH', async () => {
    const r = await bashTool.execute({ command: 'echo hi' }, { cwd: process.cwd() });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Git for Windows');
    expect(r.content).toContain('STEP_SHELL_PATH');
  });

  it('后台执行：同样报错，不真正 spawn 空命令', async () => {
    const mgr = new BackgroundManager();
    const r = await bashTool.execute(
      { command: 'echo hi', run_in_background: true },
      { cwd: process.cwd(), background: mgr },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Git for Windows');
    // 未入册任何后台任务
    expect(mgr.list()).toHaveLength(0);
  });
});
