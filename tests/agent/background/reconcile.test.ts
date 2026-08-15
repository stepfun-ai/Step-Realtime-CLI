import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackgroundManager, type BackgroundTask, type LostTask } from '../../../src/agent/background/manager.js';
import { notifyDedupKey } from '../../../src/agent/wirelog.js';

let tasksDir: string;

beforeEach(() => {
  tasksDir = mkdtempSync(join(tmpdir(), 'stepcode-tasks-'));
});

afterEach(() => {
  rmSync(tasksDir, { recursive: true, force: true });
});

/** 手工写一份磁盘任务（模拟上一个进程留下的产物）。 */
function writeMeta(id: string, meta: Record<string, unknown>, output = ''): void {
  mkdirSync(join(tasksDir, id), { recursive: true });
  writeFileSync(join(tasksDir, id, 'meta.json'), JSON.stringify(meta), 'utf8');
  if (output !== '') writeFileSync(join(tasksDir, id, 'output.log'), output, 'utf8');
}

function metaOnDisk(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(tasksDir, id, 'meta.json'), 'utf8')) as Record<string, unknown>;
}

const BASE_META = { command: 'npm test', startedAt: '2026-08-01T00:00:00.000Z' };

describe('BackgroundManager 任务落盘（tasksDir）', () => {
  it('async 任务：注册写 running meta，终态写最终 meta + output.log', async () => {
    const m = new BackgroundManager(10, { tasksDir });
    const id = m.startTask('npm test', Promise.resolve({ output: 'all passed', ok: true }));
    // 注册即落 running
    expect(metaOnDisk(id).status).toBe('running');
    await new Promise((r) => setTimeout(r, 10)); // 等 promise 链 settle
    const meta = metaOnDisk(id);
    expect(meta.status).toBe('completed');
    expect(typeof meta.endedAt).toBe('string');
    expect(readFileSync(join(tasksDir, id, 'output.log'), 'utf8')).toBe('all passed');
    // 公开视图带落盘指针与字节数
    const task = m.get(id)!;
    expect(task.outputPath).toBe(join(tasksDir, id, 'output.log'));
    expect(task.outputBytes).toBe(Buffer.byteLength('all passed', 'utf8'));
  });

  it('进程任务：输出流式追加 output.log，meta 带 pid', async () => {
    const shell = process.platform === 'win32' ? 'cmd' : 'sh';
    const args = process.platform === 'win32' ? ['/c', 'echo hello'] : ['-c', 'echo hello'];
    const m = new BackgroundManager(10, { tasksDir });
    const id = m.start('echo hello', shell, args, process.cwd());
    await new Promise((r) => setTimeout(r, 500));
    const meta = metaOnDisk(id);
    expect(meta.status).toBe('completed');
    expect(typeof meta.pid).toBe('number');
    expect(readFileSync(join(tasksDir, id, 'output.log'), 'utf8')).toContain('hello');
  });

  it('task_stop 杀掉的任务：meta 落 suppressNotify（对账不补投）', async () => {
    const m = new BackgroundManager(10, { tasksDir });
    const id = m.startTask('长任务', new Promise(() => {}));
    m.suppressNotification(id);
    m.stop(id);
    await new Promise((r) => setTimeout(r, 10));
    const meta = metaOnDisk(id);
    expect(meta.status).toBe('killed');
    expect(meta.suppressNotify).toBe(true);
  });

  it('未配置 tasksDir：纯内存，不产生任何文件（兼容旧行为）', async () => {
    const m = new BackgroundManager(10);
    m.startTask('x', Promise.resolve({ output: 'o', ok: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(existsSync(tasksDir)).toBe(true); // 只有 mkdtemp 的空目录
    const m2 = new BackgroundManager(10); // 无 tasksDir 的 reconcile 是空操作
    expect(m2.reconcile(new Set())).toEqual({ lost: [], redeliver: [] });
  });
});

describe('BackgroundManager.reconcile 对账', () => {
  it('磁盘 running + pid 已死 → 标记 lost 并列入待通知；meta 更新为 lost', () => {
    writeMeta('task-dead', { ...BASE_META, status: 'running', kind: 'process', pid: 2 ** 22 + 12345 });
    const m = new BackgroundManager(10, { tasksDir });
    const { lost, redeliver } = m.reconcile(new Set());
    expect(lost).toHaveLength(1);
    expect(lost[0]!.id).toBe('task-dead');
    expect(lost[0]!.status).toBe('lost');
    expect(redeliver.map((t) => t.id)).toEqual(['task-dead']);
    expect(metaOnDisk('task-dead').status).toBe('lost');
  });

  it('标记 lost 时同步触发 onLost 回调', () => {
    writeMeta('task-lost-cb', { ...BASE_META, status: 'running', kind: 'process', pid: 2 ** 22 + 99999 });
    const received: LostTask[] = [];
    const m = new BackgroundManager(10, { tasksDir, onLost: (t) => received.push(t) });
    m.reconcile(new Set());
    expect(received).toHaveLength(1);
    expect(received[0]!.id).toBe('task-lost-cb');
    expect(received[0]!.status).toBe('lost');
    expect(received[0]!.command).toBe('npm test');
  });

  it('未配置 onLost 时 reconcile 行为不变（回归）', () => {
    writeMeta('task-no-cb', { ...BASE_META, status: 'running', kind: 'process', pid: 2 ** 22 + 11111 });
    const m = new BackgroundManager(10, { tasksDir });
    const { lost, redeliver } = m.reconcile(new Set());
    expect(lost).toHaveLength(1);
    expect(redeliver.map((t) => t.id)).toEqual(['task-no-cb']);
    expect(metaOnDisk('task-no-cb').status).toBe('lost');
  });

  it('磁盘 running 的 async 任务（无 pid）→ 重启即死，标记 lost', () => {
    writeMeta('task-async', { ...BASE_META, status: 'running', kind: 'subagent' });
    const m = new BackgroundManager(10, { tasksDir });
    expect(m.reconcile(new Set()).lost.map((t) => t.id)).toEqual(['task-async']);
  });

  it('磁盘 running + pid 仍活（当前进程自己）→ 保持 running 不动', () => {
    writeMeta('task-alive', { ...BASE_META, status: 'running', kind: 'process', pid: process.pid });
    const m = new BackgroundManager(10, { tasksDir });
    const { lost, redeliver } = m.reconcile(new Set());
    expect(lost).toEqual([]);
    expect(redeliver).toEqual([]);
    expect(metaOnDisk('task-alive').status).toBe('running');
  });

  it('磁盘终态未送达 → 补投；已送达（幂等键在集合内）→ 跳过', () => {
    writeMeta('task-done', { ...BASE_META, status: 'completed', exitCode: 0 }, 'all passed');
    writeMeta('task-delivered', { ...BASE_META, status: 'failed', exitCode: 1 });
    const delivered = new Set([notifyDedupKey('task-delivered', 'failed', 'task:task-delivered:failed')]);
    const m = new BackgroundManager(10, { tasksDir });
    const { redeliver } = m.reconcile(delivered);
    expect(redeliver.map((t) => t.id)).toEqual(['task-done']);
    // 补投对象带完整输出尾部与落盘指针（通知可指 output-file）
    const t = redeliver[0]!;
    expect(t.output).toBe('all passed');
    expect(t.outputBytes).toBe(Buffer.byteLength('all passed', 'utf8'));
  });

  it('已标记 lost 的任务再次对账：不重复标 lost，未送达仍列入补投（幂等键按 lost 终态算）', () => {
    writeMeta('task-lost', { ...BASE_META, status: 'lost' });
    const m = new BackgroundManager(10, { tasksDir });
    const r1 = m.reconcile(new Set());
    expect(r1.lost).toEqual([]);
    expect(r1.redeliver.map((t) => t.id)).toEqual(['task-lost']);
    // 送达后再次对账不再补投
    const delivered = new Set([notifyDedupKey('task-lost', 'lost', 'task:task-lost:lost')]);
    expect(m.reconcile(delivered).redeliver).toEqual([]);
  });

  it('suppressNotify 的终态任务不补投；内存中的活任务跳过对账', async () => {
    writeMeta('task-suppressed', { ...BASE_META, status: 'killed', suppressNotify: true });
    const m = new BackgroundManager(10, { tasksDir });
    const liveId = m.startTask('活着的', new Promise(() => {}));
    await new Promise((r) => setTimeout(r, 10));
    const { redeliver } = m.reconcile(new Set());
    expect(redeliver).toEqual([]);
    // 内存活任务不被磁盘视角覆盖
    expect(m.get(liveId)!.status).toBe('running');
  });

  it('终态任务对账后登记进内存列表（task_list/task_output 可见），且不重复触发 settle 通道', () => {
    writeMeta('task-done', { ...BASE_META, status: 'completed' }, 'out');
    let settleCalls = 0;
    const m = new BackgroundManager(10, { tasksDir, onSettle: () => settleCalls++ });
    m.reconcile(new Set());
    const listed = m.list().map((t) => t.id);
    expect(listed).toContain('task-done');
    expect(m.get('task-done')!.output).toBe('out');
    expect(settleCalls).toBe(0);
    expect(m.drainSettled()).toEqual([]); // 不进待投递队列，投递走 reconcile 返回值
  });

  it('meta 损坏的目录跳过，不影响其他任务对账', () => {
    mkdirSync(join(tasksDir, 'task-corrupt'), { recursive: true });
    writeFileSync(join(tasksDir, 'task-corrupt', 'meta.json'), '{broken', 'utf8');
    writeMeta('task-done', { ...BASE_META, status: 'completed' });
    const m = new BackgroundManager(10, { tasksDir });
    expect(m.reconcile(new Set()).redeliver.map((t) => t.id)).toEqual(['task-done']);
  });
});

describe('终态任务公开视图', () => {
  it('对账恢复的终态任务保留原字段（命令/退出码/起止时间）', () => {
    writeMeta('task-x', {
      command: 'npm run build',
      status: 'failed',
      exitCode: 3,
      startedAt: '2026-08-01T00:00:00.000Z',
      endedAt: '2026-08-01T00:01:00.000Z',
      kind: 'process',
    });
    const m = new BackgroundManager(10, { tasksDir });
    m.reconcile(new Set());
    const t: BackgroundTask = m.get('task-x')!;
    expect(t.command).toBe('npm run build');
    expect(t.exitCode).toBe(3);
    expect(t.status).toBe('failed');
    expect(t.endedAt).toBe('2026-08-01T00:01:00.000Z');
  });
});

/**
 * 会话切换换绑 tasksDir 的语义验证（对应 PiChat 的 /new、/fork、/resume 换绑路径）。
 *
 * BackgroundManager 的 tasksDir 在构造时绑定，切换会话时通过创建新实例换绑（不复用旧实例）。
 * 本组测试验证：换绑后旧目录的任务不再被新管理器纳入、新任务落到新目录、对账仅扫描当前目录。
 */
describe('BackgroundManager 换绑 tasksDir（/new /fork /resume 路径）', () => {
  it('换绑后：旧目录的任务不在新管理器内存列表中（/fork 语义：旧会话在 fork 前已持久化，新管理器只认新目录）', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'stepcode-sessionA-'));
    const dirB = mkdtempSync(join(tmpdir(), 'stepcode-sessionB-'));
    // 旧会话（dirA）在 fork 前已有一个运行中任务
    const oldMgr = new BackgroundManager(10, { tasksDir: dirA });
    const oldId = oldMgr.startTask('旧会话·编译', Promise.resolve({ output: 'done', ok: true }));
    // 模拟 fork：新管理器绑定 dirB
    const newMgr = new BackgroundManager(10, { tasksDir: dirB });
    expect(newMgr.list()).toHaveLength(0); // 新管理器不感知旧目录
    expect(newMgr.get(oldId)).toBeUndefined(); // 旧任务 id 在新管理器不可见
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it('换绑后：新任务落到新 tasksDir 而非旧目录（/new 与 /fork 共用同一换绑语义）', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'stepcode-sessionA-'));
    const dirB = mkdtempSync(join(tmpdir(), 'stepcode-sessionB-'));
    const oldMgr = new BackgroundManager(10, { tasksDir: dirA });
    const newMgr = new BackgroundManager(10, { tasksDir: dirB });
    const newId = newMgr.startTask('新会话·lint', Promise.resolve({ output: 'ok', ok: true }));
    await new Promise((r) => setTimeout(r, 10));
    // 新任务元数据落在 dirB
    const metaB = JSON.parse(readFileSync(join(dirB, newId, 'meta.json'), 'utf8')) as Record<string, unknown>;
    expect(metaB.status).toBe('completed');
    expect(metaB.command).toBe('新会话·lint');
    // 旧目录没有新任务的落盘
    expect(existsSync(join(dirA, newId))).toBe(false);
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it('换绑后 reconcile 只扫描新 tasksDir，不把旧目录的任务误标 lost（/resume 才走对账，/new /fork 不触发；此处仅验证扫描范围正确）', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'stepcode-sessionA-'));
    const dirB = mkdtempSync(join(tmpdir(), 'stepcode-sessionB-'));
    // 在旧目录遗留一个 running 任务
    mkdirSync(join(dirA, 'orphan-task'), { recursive: true });
    writeFileSync(join(dirA, 'orphan-task', 'meta.json'), JSON.stringify({
      ...BASE_META,
      status: 'running',
      kind: 'process',
      pid: 2 ** 22 + 99999,
    }));
    // 新管理器绑定 dirB，对账不应扫到 dirA 的遗留任务
    const newMgr = new BackgroundManager(10, { tasksDir: dirB });
    const { lost, redeliver } = newMgr.reconcile(new Set());
    expect(lost).toEqual([]);
    expect(redeliver).toEqual([]);
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it('/resume 换绑语义对照：reconcile 会扫描新目录并将旧目录遗留 running 标 lost（与 /new /fork 的「不扫描旧目录」区分）', () => {
    const dirOld = mkdtempSync(join(tmpdir(), 'stepcode-old-'));
    const dirResumed = mkdtempSync(join(tmpdir(), 'stepcode-resumed-'));
    // 遗留 running 任务在即将恢复的会话目录中（resume 路径会扫描到）
    mkdirSync(join(dirResumed, 'dead-task'), { recursive: true });
    writeFileSync(join(dirResumed, 'dead-task', 'meta.json'), JSON.stringify({
      ...BASE_META,
      status: 'running',
      kind: 'process',
      pid: 2 ** 22 + 54321,
    }));
    const mgr = new BackgroundManager(10, { tasksDir: dirResumed });
    const { lost } = mgr.reconcile(new Set());
    expect(lost.map((t) => t.id)).toEqual(['dead-task']);
    rmSync(dirOld, { recursive: true, force: true });
    rmSync(dirResumed, { recursive: true, force: true });
  });
});
