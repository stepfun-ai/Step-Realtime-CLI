/**
 * ⑦ 跨 session 隔离回归：queue/todos/goal/steer 切会话不串台。
 *
 * cron/background/subagent 已有回归用例（见会话泄露修复清单），本份补其余四类。
 * PiChat 不可实例化，用 wiring 断言锁 newSession 与 resumeSession 的清理点——
 * 这两处是切会话的唯一入口，清理点齐全即保证四类不串台。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(repoRoot, 'src', 'tui-pi', 'PiChat.ts'), 'utf8');

/** 取 newSession 方法体（从定义到下一个顶级方法）。 */
function newSessionBody(): string {
  const start = src.indexOf('private newSession(): void');
  // 找方法体结束：下一个 "  private " 或 "  /**" 在更外层缩进
  const after = src.slice(start + 100);
  const end = after.search(/\n  (private |\/\*\*)/);
  return src.slice(start, start + 100 + (end > 0 ? end : 800));
}

/** 取 resumeSession 方法体。 */
function resumeSessionBody(): string {
  const start = src.indexOf('private resumeSession(id: string)');
  const after = src.slice(start + 100);
  const end = after.search(/\n  (private |\/\*\*)/);
  return src.slice(start, start + 100 + (end > 0 ? end : 2500));
}

describe('⑦ newSession 清空四类运行态', () => {
  const body = newSessionBody();
  it('todos 清空', () => expect(body).toContain('this.todos.items = []'));
  it('queue 清空', () => expect(body).toContain('this.queue = []'));
  it('steers 清空', () => expect(body).toContain('this.steers = []'));
  it('goal 重置', () => expect(body).toContain('this.goal.restore(null)'));
  it('notifyPrepared 清空', () => expect(body).toContain('this.notifyPrepared.clear()'));
});

describe('⑦ resumeSession 用目标会话数据替换（不继承源会话）', () => {
  const body = resumeSessionBody();
  it('steers 重置为空数组（源会话的 steer 不倒灌）', () => expect(body).toContain('this.steers = []'));
  it('todos 用目标会话的替换', () => expect(body).toContain('this.todos.items = [...(data.todos'));
  it('queue 用目标会话的替换', () => expect(body).toContain('this.queue = restoredQueue'));
  it('goal 用目标会话的恢复', () => expect(body).toContain('this.goal.restore(data.goal)'));
  it('notifyPrepared 清空', () => expect(body).toContain('this.notifyPrepared.clear()'));
});
