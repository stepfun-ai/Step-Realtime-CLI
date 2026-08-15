import { describe, expect, it } from 'vitest';
import type { BackgroundTask } from '../../src/agent/background/manager.js';
import { applyCtrlB, type ForegroundDetachSource } from '../../src/chat/ctrlB.js';

function fakeTask(id: string): BackgroundTask {
  return { id, command: `cmd ${id}`, status: 'running', startedAt: new Date().toISOString(), output: '' };
}

function fakeSource(ids: string[], failIds: string[] = []): ForegroundDetachSource & { detached: string[] } {
  const detached: string[] = [];
  return {
    detached,
    listForeground: () => ids.map(fakeTask),
    detach: (id) => {
      if (failIds.includes(id)) return false;
      detached.push(id);
      return true;
    },
  };
}

describe('applyCtrlB 键位消费规则', () => {
  it('idle：返回 null（放行），不查询也不 detach', () => {
    const src = fakeSource(['t1']);
    expect(applyCtrlB(false, src)).toBeNull();
    expect(src.detached).toEqual([]);
  });

  it('busy 但无前台任务：返回 null（放行），不动作', () => {
    const src = fakeSource([]);
    expect(applyCtrlB(true, src)).toBeNull();
    expect(src.detached).toEqual([]);
  });

  it('busy 且有前台任务：一次 detach 全部，返回数量', () => {
    const src = fakeSource(['t1', 't2']);
    expect(applyCtrlB(true, src)).toBe(2);
    expect(src.detached).toEqual(['t1', 't2']);
  });

  it('部分任务恰已终态（detach 返回 false）：只计成功数', () => {
    const src = fakeSource(['t1', 't2'], ['t2']);
    expect(applyCtrlB(true, src)).toBe(1);
    expect(src.detached).toEqual(['t1']);
  });
});
