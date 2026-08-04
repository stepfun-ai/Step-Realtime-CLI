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
    const m1 = stored({ role: 'user', content: '第一条' }, 'user');
    s.messages.push(m1);
    store.appendFull(cwd, s.id, [m1]);
    store.save(s); // 检查点覆盖到 metadata+m1
    // 模拟崩溃窗口：又一条消息进了事件日志，但没来得及 save
    const m2 = stored({ role: 'assistant', content: '第二条' }, 'assistant');
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
      'assistant',
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
    const m1 = stored({ role: 'user', content: 'a' }, 'user');
    s.messages.push(m1);
    store.appendFull(cwd, s.id, [m1]);
    store.save(s);
    store.appendWire(cwd, s.id, [
      { type: 'context.append_message', ts: TS, message: stored({ role: 'assistant', content: 'b' }, 'assistant') },
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

  it('旧快照（无 wireSeq）+ 旧格式 full.jsonl：按消息 id 去重的兼容路径，不重复消息', () => {
    const s = store.create(cwd, 'm');
    const m1 = stored({ role: 'user', content: '旧第一条' }, 'user');
    const m2 = stored({ role: 'assistant', content: '旧第二条' }, 'assistant');
    s.messages.push(m1, m2);
    store.save(s);
    // 手工造旧格式日志：m1、m2（已在快照）+ m3（崩溃窗口没进快照）
    const m3 = stored({ role: 'assistant', content: '崩溃前最后一条' }, 'assistant');
    const lines = [m1, m2, m3].map((m) => JSON.stringify(m)).join('\n') + '\n';
    writeFileSync(join(base, workdirKey(cwd), `${s.id}.full.jsonl`), lines, 'utf8');

    const result = store.resume(cwd, s.id)!;
    expect(result.session.messages.map((m) => m.message.content)).toEqual([
      '旧第一条',
      '旧第二条',
      '崩溃前最后一条',
    ]);
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
    const m1 = stored({ role: 'user', content: '只有日志' }, 'user');
    store.appendWire(cwd, s.id, [
      { type: 'context.append_message', ts: TS, message: m1 },
      { type: 'permission.set_mode', ts: TS, mode: 'auto' },
    ]);
    const result = store.resume(cwd, s.id)!;
    expect(result.session.id).toBe(s.id);
    expect(result.session.messages).toHaveLength(1);
    expect(result.session.mode).toBe('auto');
  });

  it('无快照且无日志：返回 null', () => {
    expect(store.resume(cwd, 'nope')).toBeNull();
  });

  it('存量快照 wireSeq 落后于 messages（旧 persist 顺序）：尾段已在快照中的消息不重复追加', () => {
    // 复刻旧版本 persist 的写盘顺序（先 save 后 appendFull）制造游标落后的存量数据：
    // 快照含 3 条消息，wireSeq 却只覆盖到第 1 条的事件位置。
    const s = store.create(cwd, 'm');
    const m1 = stored({ role: 'user', content: '第一条' }, 'user');
    s.messages = [m1];
    store.save(s); // 日志尚不存在，wireSeq 缺省
    store.appendFull(cwd, s.id, [m1]); // metadata + m1 = 2 个事件
    const m2 = stored({ role: 'assistant', content: '第二条' }, 'assistant');
    const m3 = stored({ role: 'user', content: '第三条' }, 'user');
    s.messages = [m1, m2, m3];
    store.save(s); // wireSeq=2，快照 messages 已含 m2/m3 → 游标落后 2 条
    store.appendFull(cwd, s.id, [m1, m2, m3]); // m2/m3 的事件此刻才进日志

    const result = store.resume(cwd, s.id)!;
    // 尾段 2 个 append_message 都已在快照中，必须被按 id 滤掉
    expect(result.session.messages.map((m) => m.message.content)).toEqual([
      '第一条',
      '第二条',
      '第三条',
    ]);
    const ids = result.session.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('存量快照已含尾部重复（孤儿 tool_result）：resume 时降级为 text，有效配对不动', () => {
    const s = store.create(cwd, 'm');
    const a1 = stored(
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-1', name: 'read_file', input: { path: 'a.ts' } }],
      },
      'assistant',
    );
    const result = (text: string) =>
      stored({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: text }] }, 'tool');
    const a2 = stored({ role: 'assistant', content: [{ type: 'text', text: '读完了' }] }, 'assistant');
    // 快照已含重复对（旧版本 resume 制造、又经 save 落盘的存量数据）
    s.messages = [a1, result('内容'), a2, result('内容'), a2];
    store.appendWire(cwd, s.id, [{ type: 'permission.set_mode', ts: TS, mode: 'auto' }]);
    store.save(s); // wireSeq 覆盖全部事件，尾段为空

    const r = store.resume(cwd, s.id)!;
    expect(r.repairedOrphanToolResults).toBe(true);
    expect(r.repairedOrphanToolUseIds).toEqual(['tu-1']);
    const blocks = (i: number) => r.session.messages[i]!.message.content as { type: string }[];
    expect(blocks(1)[0]!.type).toBe('tool_result'); // 有效配对不动
    expect(blocks(3)[0]!.type).toBe('text'); // 孤儿降级
  });
});
