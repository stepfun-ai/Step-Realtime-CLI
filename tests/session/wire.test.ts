import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stored } from '../../src/agent/message.js';
import { SessionStore, workdirKey } from '../../src/session/store.js';

let base: string;
let store: SessionStore;
const cwd = 'C:/some/project';
const TS = '2026-08-01T00:00:00.000Z';

function wirePath(id: string): string {
  return join(base, workdirKey(cwd), `${id}.wire.jsonl`);
}

function fullPath(id: string): string {
  return join(base, workdirKey(cwd), `${id}.full.jsonl`);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stepcode-wire-'));
  store = new SessionStore(base);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('SessionStore 事件日志（appendWire / loadWire）', () => {
  it('首行必为 metadata 事件，随后按序追加', () => {
    const s = store.create(cwd, 'm');
    const m1 = stored({ role: 'user', content: 'a' }, { kind: 'user' });
    store.appendWire(cwd, s.id, [
      { type: 'context.append_message', ts: TS, message: m1 },
      { type: 'permission.set_mode', ts: TS, mode: 'auto' },
    ]);
    const lines = readFileSync(wirePath(s.id), 'utf8').trim().split('\n');
    const first = JSON.parse(lines[0]!) as { type: string; version: number; sessionId: string };
    expect(first.type).toBe('metadata');
    expect(first.version).toBe(1);
    expect(first.sessionId).toBe(s.id);
    const events = store.loadWire(cwd, s.id);
    expect(events.map((e) => e.type)).toEqual([
      'metadata',
      'context.append_message',
      'permission.set_mode',
    ]);
  });

  it('append_message 事件按消息 id 去重（幂等），其余事件类型不去重', () => {
    const s = store.create(cwd, 'm');
    const m1 = stored({ role: 'user', content: 'a' }, { kind: 'user' });
    expect(store.appendWire(cwd, s.id, [{ type: 'context.append_message', ts: TS, message: m1 }])).toBe(1);
    expect(
      store.appendWire(cwd, s.id, [
        { type: 'context.append_message', ts: TS, message: m1 }, // 重复，跳过
        { type: 'turn.prompt', ts: TS },
        { type: 'turn.prompt', ts: TS }, // 非消息事件不去重
      ]),
    ).toBe(2);
    const events = store.loadWire(cwd, s.id);
    expect(events.filter((e) => e.type === 'context.append_message')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'turn.prompt')).toHaveLength(2);
  });

  it('旧格式 full.jsonl 不再折算：loadWire 只读 wire.jsonl', () => {
    const s = store.create(cwd, 'm');
    const legacy = stored({ role: 'user', content: '旧消息' }, { kind: 'user' });
    store.save(s); // 建桶目录
    writeFileSync(fullPath(s.id), `${JSON.stringify(legacy)}\n`, 'utf8');
    const fresh = stored({ role: 'user', content: '新消息' }, { kind: 'user' });
    store.appendWire(cwd, s.id, [{ type: 'context.append_message', ts: TS, message: fresh }]);

    const events = store.loadWire(cwd, s.id);
    expect(events.map((e) => e.type)).toEqual([
      'metadata',
      'context.append_message',
    ]);
    // loadFull 口径一致：full.jsonl 里的旧消息不再出现
    expect(store.loadFull(cwd, s.id).map((m) => m.message.content)).toEqual(['新消息']);
  });

  it('崩溃截断的尾行被容忍（跳过），已解析部分完整返回', () => {
    const s = store.create(cwd, 'm');
    store.appendWire(cwd, s.id, [
      { type: 'context.append_message', ts: TS, message: stored({ role: 'user', content: 'a' }, { kind: 'user' }) },
    ]);
    appendFileSync(wirePath(s.id), '{"type":"permission.set_mode","ts":"2026', 'utf8'); // 截断行
    const events = store.loadWire(cwd, s.id);
    expect(events.map((e) => e.type)).toEqual(['metadata', 'context.append_message']);
  });

  it('appendFull 落到 wire.jsonl（不再写 full.jsonl），loadFull 读回一致', () => {
    const s = store.create(cwd, 'm');
    const m1 = stored({ role: 'user', content: 'a' }, { kind: 'user' });
    expect(store.appendFull(cwd, s.id, [m1])).toBe(1);
    expect(store.appendFull(cwd, s.id, [m1])).toBe(0); // 幂等
    expect(existsSync(fullPath(s.id))).toBe(false);
    expect(existsSync(wirePath(s.id))).toBe(true);
    expect(store.loadFull(cwd, s.id).map((m) => m.id)).toEqual([m1.id]);
  });

  it('delete 连同 wire.jsonl 与任务持久化目录一起清理', () => {
    const s = store.create(cwd, 'm');
    store.save(s);
    store.appendFull(cwd, s.id, [stored({ role: 'user', content: 'a' }, { kind: 'user' })]);
    const tasksDir = store.tasksDirFor(cwd, s.id);
    mkdirSync(join(tasksDir, 'task-1'), { recursive: true });
    writeFileSync(join(tasksDir, 'task-1', 'meta.json'), '{}', 'utf8');
    expect(existsSync(wirePath(s.id))).toBe(true);
    expect(store.delete(cwd, s.id)).toBe(true);
    expect(existsSync(wirePath(s.id))).toBe(false);
    expect(existsSync(tasksDir)).toBe(false);
  });

  it('save 写入检查点游标 wireSeq（覆盖到事件日志第几条）', () => {
    const s = store.create(cwd, 'm');
    s.messages.push(stored({ role: 'user', content: 'a' }, { kind: 'user' }));
    store.appendFull(cwd, s.id, s.messages); // metadata + 1 条消息 = 2 条事件
    store.save(s);
    const raw = JSON.parse(readFileSync(join(base, workdirKey(cwd), `${s.id}.json`), 'utf8')) as {
      wireSeq?: number;
    };
    expect(raw.wireSeq).toBe(2);
  });

  it('无事件日志的会话 save 不写 wireSeq', () => {
    const s = store.create(cwd, 'm');
    store.save(s);
    expect(store.load(cwd, s.id)!.wireSeq).toBeUndefined();
  });
});

describe('listWireSessionIds（以事件日志为事实源列举）', () => {
  it('列出有事件日志的会话 id，升序', () => {
    const a = store.create(cwd, 'm');
    const b = store.create(cwd, 'm');
    store.appendWire(cwd, a.id, [{ type: 'permission.set_mode', ts: TS, mode: 'auto' }]);
    store.appendWire(cwd, b.id, [{ type: 'permission.set_mode', ts: TS, mode: 'auto' }]);
    const ids = store.listWireSessionIds(cwd);
    expect(ids).toHaveLength(2);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids)).toEqual(new Set([a.id, b.id]));
  });

  it('有事件日志但无 .json 快照的会话也要列出（list 会漏掉它们）', () => {
    // 复现真实场景：写完事件日志、还没走到 save 就崩溃/被强杀。
    // 实测某工作目录下 79 个事件日志里有 7 个处于此状态，其中一个含 3 条 model.usage。
    const s = store.create(cwd, 'm');
    store.appendWire(cwd, s.id, [{ type: 'permission.set_mode', ts: TS, mode: 'auto' }]);
    rmSync(join(base, workdirKey(cwd), `${s.id}.json`), { force: true });

    expect(store.list(cwd).some((m) => m.id === s.id)).toBe(false);
    expect(store.listWireSessionIds(cwd)).toContain(s.id);
  });

  it('只认 .wire.jsonl：同一会话的快照与事件日志不重复计数', () => {
    const s = store.create(cwd, 'm');
    store.appendFull(cwd, s.id, [stored({ role: 'user', content: 'a' }, { kind: 'user' })]);
    store.save(s);
    // 该仓的 appendFull 已改为落进 wire.jsonl，不再写 full.jsonl（见上方同名用例）
    expect(existsSync(fullPath(s.id))).toBe(false);
    expect(existsSync(join(base, workdirKey(cwd), `${s.id}.json`))).toBe(true);
    // 快照 + 事件日志两个文件并存，但只应算一个会话
    expect(store.listWireSessionIds(cwd).filter((id) => id === s.id)).toHaveLength(1);
  });

  it('工作目录不存在时返回空数组', () => {
    expect(store.listWireSessionIds('D:/never/existed')).toEqual([]);
  });
});
