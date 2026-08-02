import { describe, expect, it } from 'vitest';
import type { BackgroundTask, LostTask } from '../../src/agent/background/manager.js';
import {
  buildSettleMessage,
  decideNotifyRoute,
  formatSettleNotification,
  notificationIdFor,
} from '../../src/agent/background/notify.js';

function makeTask(over: Partial<BackgroundTask>): BackgroundTask {
  return {
    id: 't123',
    command: 'npm test',
    status: 'completed',
    startedAt: '2026-07-23T00:00:00.000Z',
    output: '',
    ...over,
  };
}

describe('formatSettleNotification XML 信封', () => {
  it('信封结构：id/category/type/source_kind/source_id 属性齐全', () => {
    const text = formatSettleNotification(makeTask({}));
    const open = text.split('\n')[0]!;
    expect(open).toContain('<notification id="task:t123:completed"');
    expect(open).toContain('category="task"');
    expect(open).toContain('type="task.completed"');
    expect(open).toContain('source_kind="background_task"');
    expect(open).toContain('source_id="t123"');
    expect(text.trimEnd().endsWith('</notification>')).toBe(true);
  });

  it('正文：状态 + 命令 + 无需轮询声明；完成带退出码', () => {
    const text = formatSettleNotification(makeTask({ exitCode: 0 }));
    expect(text).toContain('状态：已完成（退出码 0）');
    expect(text).toContain('命令：npm test');
    expect(text).toContain('无需用 task_list 轮询');
  });

  it('失败带退出码；被终止与失联各有专属文案', () => {
    expect(formatSettleNotification(makeTask({ status: 'failed', exitCode: 2 }))).toContain('状态：失败（退出码 2）');
    expect(formatSettleNotification(makeTask({ status: 'killed' }))).toContain('已被终止');
    const lost: LostTask = { ...makeTask({}), status: 'lost' };
    const text = formatSettleNotification(lost);
    expect(text).toContain('type="task.lost"');
    expect(text).toContain('已失联');
  });

  it('落盘任务给 <output-file> 指针（路径 + 字节数），不内嵌输出', () => {
    const text = formatSettleNotification(
      makeTask({ outputPath: '/tmp/x/tasks/t123/output.log', outputBytes: 12345, output: 'tail…' }),
    );
    expect(text).toContain('<output-file path="/tmp/x/tasks/t123/output.log" bytes="12345">');
    expect(text).toContain('task_output');
    expect(text).not.toContain('tail…');
  });

  it('未落盘任务退化为尾部兜底预览；无输出标注（无输出）', () => {
    const out = `head-${'x'.repeat(3000)}-tail`;
    const text = formatSettleNotification(makeTask({ output: out }));
    expect(text).toContain('-tail');
    expect(text).not.toContain('head-');
    expect(formatSettleNotification(makeTask({ output: '' }))).toContain('（无输出）');
  });

  it('命令里的 XML 特殊字符被转义，不破坏信封结构', () => {
    const text = formatSettleNotification(makeTask({ command: 'echo "<a&b>"' }));
    expect(text).toContain('命令：echo &quot;&lt;a&amp;b&gt;&quot;');
    expect(text.trimEnd().endsWith('</notification>')).toBe(true);
  });

  it('agent_id 仅在有来源 agent 时输出', () => {
    expect(formatSettleNotification(makeTask({}))).not.toContain('agent_id=');
    expect(formatSettleNotification(makeTask({ agentId: 'agent-9' }))).toContain('agent_id="agent-9"');
  });
});

describe('buildSettleMessage 结构化 origin', () => {
  it('origin 落 background_task 判别对象，携带 taskId/notificationId/startsPromptTurn', () => {
    const msg = buildSettleMessage(makeTask({}), { startsPromptTurn: true });
    expect(msg.message.role).toBe('user');
    expect(typeof msg.message.content).toBe('string');
    expect(msg.origin).toEqual({
      kind: 'background_task',
      taskId: 't123',
      notificationId: 'task:t123:completed',
      agentId: undefined,
      startsPromptTurn: true,
    });
  });

  it('notificationIdFor 幂等：同任务同终态恒定，异终态不同', () => {
    expect(notificationIdFor(makeTask({}))).toBe('task:t123:completed');
    expect(notificationIdFor(makeTask({}))).toBe(notificationIdFor(makeTask({})));
    expect(notificationIdFor(makeTask({ status: 'failed' }))).not.toBe(notificationIdFor(makeTask({})));
  });
});

describe('decideNotifyRoute', () => {
  it('busy 时入队（留给回合边界 flush），空闲时直接提交', () => {
    expect(decideNotifyRoute(true)).toBe('enqueue');
    expect(decideNotifyRoute(false)).toBe('submit');
  });
});
