import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stored } from '../../src/agent/message.js';
import { notifyDedupKey } from '../../src/agent/wirelog.js';
import { SessionStore, workdirKey } from '../../src/session/store.js';

let base: string;
let store: SessionStore;
const cwd = 'C:/some/project';
const TS = '2026-08-01T00:00:00.000Z';

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stepcode-resume-'));
  store = new SessionStore(base);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function bucketFiles(): string[] {
  return readdirSync(join(base, workdirKey(cwd)), { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

describe('SessionStore.resume 检查点 + 尾段重放', () => {
  it('快照之后追加的尾段消息在 resume 时重放回 messages', () => {
    const s = store.create(cwd, 'm');
    const m1 = stored({ role: 'user', content: '第一条' }, { kind: 'user' });
    s.messages.push(m1);
    store.appendFull(cwd, s.id, [m1]);
    store.save(s); // 检查点覆盖到 metadata+m1
    // 模拟崩溃窗口：又一条消息进了事件日志，但没来得及 save
    const m2 = stored({ role: 'assistant', content: '第二条' }, { kind: 'assistant' });
    store.appendFull(cwd, s.id, [m2]);

    const result = store.resume(cwd, s.id)!;
    expect(result.replayedEvents).toBe(1);
    expect(result.session.messages.map((m) => m.message.content)).toEqual(['第一条', '第二条']);
    // 游标推进到日志末尾，下一次 save 的检查点覆盖全部
    expect(result.session.wireSeq).toBe(3);
  });

  it('尾段非消息事件（权限/plan/think/goal）重放到会话状态', () => {
    const s = store.create(cwd, 'm');
    store.appendFull(cwd, s.id, []);
    store.save(s);
    store.appendWire(cwd, s.id, [
      { type: 'permission.set_mode', ts: TS, mode: 'yolo' },
      { type: 'plan_mode.set', ts: TS, enabled: true },
      { type: 'think.set', ts: TS, override: 'off' },
      {
        type: 'goal.update',
        ts: TS,
        goal: { objective: 'x', status: 'active', turnsUsed: 1, tokensUsed: 10, createdAt: 1 },
      },
    ]);
    const result = store.resume(cwd, s.id)!;
    expect(result.session.mode).toBe('yolo');
    expect(result.session.planMode).toBe(true);
    expect(result.session.thinkOverride).toBe('off');
    expect(result.session.goal?.objective).toBe('x');
  });

  it('末尾悬空 tool_use 在 resume 时合成错误 tool_result 闭合', () => {
    const s = store.create(cwd, 'm');
    const dangling = stored(
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-1', name: 'bash', input: {} }],
      },
      { kind: 'assistant' },
    );
    s.messages.push(dangling);
    store.appendFull(cwd, s.id, [dangling]);
    store.save(s);

    const result = store.resume(cwd, s.id)!;
    expect(result.closedDanglingToolUse).toBe(true);
    expect(result.closedToolUseIds).toEqual(['tu-1']);
    const last = result.session.messages.at(-1)!;
    expect(last.origin.kind).toBe('tool');
    const blocks = last.message.content as { type: string; is_error: boolean }[];
    expect(blocks[0]!.type).toBe('tool_result');
    expect(blocks[0]!.is_error).toBe(true);
  });

  it('restore 无副作用契约：resume 不写盘、不产生新文件、重复调用结果一致', () => {
    const s = store.create(cwd, 'm');
    const m1 = stored({ role: 'user', content: 'a' }, { kind: 'user' });
    s.messages.push(m1);
    store.appendFull(cwd, s.id, [m1]);
    store.save(s);
    store.appendWire(cwd, s.id, [
      { type: 'context.append_message', ts: TS, message: stored({ role: 'assistant', content: 'b' }, { kind: 'assistant' }) },
      { type: 'permission.set_mode', ts: TS, mode: 'auto' },
    ]);

    const before = bucketFiles().map((name) => ({
      name,
      content: readFileSync(join(base, workdirKey(cwd), name), 'utf8'),
    }));

    const r1 = store.resume(cwd, s.id)!;
    const r2 = store.resume(cwd, s.id)!;

    const after = bucketFiles().map((name) => ({
      name,
      content: readFileSync(join(base, workdirKey(cwd), name), 'utf8'),
    }));
    expect(after).toEqual(before); // 文件名与内容零变化：无新事件、无快照改写
    expect(r2.session.messages.map((m) => m.id)).toEqual(r1.session.messages.map((m) => m.id));
    expect(r2.replayedEvents).toBe(r1.replayedEvents);
    expect([...r2.deliveredNotifications]).toEqual([...r1.deliveredNotifications]);
  });

  it('旧快照（无 wireSeq）：忽略快照 messages，从空基底全量重放事件日志', () => {
    const s = store.create(cwd, 'm');
    const m1 = stored({ role: 'user', content: '旧第一条' }, { kind: 'user' });
    const m2 = stored({ role: 'assistant', content: '旧第二条' }, { kind: 'assistant' });
    s.messages.push(m1, m2);
    store.save(s); // 无事件日志 → 快照无 wireSeq，不可作检查点
    // 事件日志里只有崩溃窗口后的一条（不含快照里的 m1/m2）
    const m3 = stored({ role: 'assistant', content: '崩溃前最后一条' }, { kind: 'assistant' });
    store.appendWire(cwd, s.id, [{ type: 'context.append_message', ts: TS, message: m3 }]);

    const result = store.resume(cwd, s.id)!;
    // 破坏性语义：旧快照 messages 不保留，事件才是事实源
    expect(result.session.messages.map((m) => m.message.content)).toEqual(['崩溃前最后一条']);
  });

  it('已送达集合：delivered 事件与历史中的 background_task 通知消息都会回填', () => {
    const s = store.create(cwd, 'm');
    const note = stored(
      { role: 'user', content: '<notification/>' },
      { kind: 'background_task', taskId: 'task-1', notificationId: 'task:task-1:completed' },
    );
    s.messages.push(note);
    store.appendFull(cwd, s.id, [note]);
    store.save(s);
    store.appendWire(cwd, s.id, [
      {
        type: 'background.notify_delivered',
        ts: TS,
        taskId: 'task-2',
        status: 'failed',
        notificationId: 'task:task-2:failed',
      },
    ]);

    const result = store.resume(cwd, s.id)!;
    expect(result.deliveredNotifications.has(notifyDedupKey('task-1', 'completed', 'task:task-1:completed'))).toBe(true);
    expect(result.deliveredNotifications.has(notifyDedupKey('task-2', 'failed', 'task:task-2:failed'))).toBe(true);
  });

  it('无快照但有事件日志：从空基底全量重放', () => {
    const s = store.create(cwd, 'm');
    const m1 = stored({ role: 'user', content: '只有日志' }, { kind: 'user' });
    store.appendWire(cwd, s.id, [
      { type: 'context.append_message', ts: TS, message: m1 },
      { type: 'permission.set_mode', ts: TS, mode: 'auto' },
    ]);
    const result = store.resume(cwd, s.id)!;
    expect(result.session.id).toBe(s.id);
    expect(result.session.messages).toHaveLength(1);
    expect(result.session.mode).toBe('auto');
  });

  it('待发队列：快照后的 queue.update 事件在 resume 时重放（覆盖「排完队直接退出」）', () => {
    const s = store.create(cwd, 'm');
    const m1 = stored({ role: 'user', content: '开始干活' }, { kind: 'user' });
    s.messages.push(m1);
    store.appendFull(cwd, s.id, [m1]);
    store.save(s); // 检查点：此刻队列为空
    // 回合进行中用户排了两条队。persist 集中在回合边界，此刻只有 wire 事件落了盘——
    // 这正是「排完队直接 Ctrl+C」的现场，只写快照的实现在这里会丢数据。
    store.appendWire(cwd, s.id, [{ type: 'queue.update', ts: TS, queue: ['第一条排队'] }]);
    store.appendWire(cwd, s.id, [{ type: 'queue.update', ts: TS, queue: ['第一条排队', '第二条排队'] }]);

    const r = store.resume(cwd, s.id)!;
    expect(r.session.queue).toEqual(['第一条排队', '第二条排队']);
  });

  it('待发队列：清空事件（缺省字段与空数组）都归一为 undefined', () => {
    const s = store.create(cwd, 'm');
    const m1 = stored({ role: 'user', content: 'x' }, { kind: 'user' });
    s.messages.push(m1);
    store.appendFull(cwd, s.id, [m1]);
    store.save(s);
    // 必须先在尾段里设值再清空。只放一条清空事件的话，重放态的 queue 初态本就是
    // undefined，「清空生效」与「清空被忽略」结果一样，断言测的是初态不是清空逻辑
    // （实测：把 reducer 改成忽略清空事件，那样写的断言照样全绿）。
    store.appendWire(cwd, s.id, [
      { type: 'queue.update', ts: TS, queue: ['先排一条'] },
      { type: 'queue.update', ts: TS },
    ]);
    expect(store.resume(cwd, s.id)!.session.queue).toBeUndefined();

    // 空数组走另一条分支，同样归一为 undefined（不留空数组噪音）
    const s2 = store.create(cwd, 'm');
    const m2 = stored({ role: 'user', content: 'y' }, { kind: 'user' });
    s2.messages.push(m2);
    store.appendFull(cwd, s2.id, [m2]);
    store.save(s2);
    store.appendWire(cwd, s2.id, [
      { type: 'queue.update', ts: TS, queue: ['另一条'] },
      { type: 'queue.update', ts: TS, queue: [] },
    ]);
    expect(store.resume(cwd, s2.id)!.session.queue).toBeUndefined();
  });

  it('待发队列：尾段无 queue.update 时保留快照原值（区分「未变更」与「已清空」）', () => {
    const s = store.create(cwd, 'm');
    s.queue = ['快照里的排队'];
    const m1 = stored({ role: 'user', content: 'x' }, { kind: 'user' });
    s.messages.push(m1);
    store.appendFull(cwd, s.id, [m1]);
    store.save(s);
    // 尾段只有无关事件：队列没被动过，不能因此判成清空
    store.appendWire(cwd, s.id, [{ type: 'permission.set_mode', ts: TS, mode: 'auto' }]);
    expect(store.resume(cwd, s.id)!.session.queue).toEqual(['快照里的排队']);
  });

  it('无快照且无日志：返回 null', () => {
    expect(store.resume(cwd, 'nope')).toBeNull();
  });
});
