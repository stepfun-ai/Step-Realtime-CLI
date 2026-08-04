import { describe, expect, it } from 'vitest';
import { stored } from '../../src/agent/message.js';
import {
  applyWireEvent,
  closeDanglingToolUse,
  emptyWireReplayState,
  notifyDedupKey,
  notifyDedupKeyFromOrigin,
  parseWireLine,
  repairOrphanToolResults,
  replayWireEvents,
  type WireEvent,
} from '../../src/agent/wirelog.js';

const TS = '2026-08-01T00:00:00.000Z';

describe('replayWireEvents 纯函数重放', () => {
  it('append_message 按序重建消息历史；非消息事件各自落到对应状态字段', () => {
    const events: WireEvent[] = [
      { type: 'metadata', version: 1, sessionId: 's1', createdAt: TS },
      { type: 'context.append_message', ts: TS, message: stored({ role: 'user', content: 'hi' }, 'user') },
      { type: 'turn.prompt', ts: TS },
      { type: 'permission.set_mode', ts: TS, mode: 'yolo' },
      { type: 'plan_mode.set', ts: TS, enabled: true },
      { type: 'think.set', ts: TS, override: 'high' },
      {
        type: 'goal.update',
        ts: TS,
        goal: { objective: '写报告', status: 'active', turnsUsed: 0, tokensUsed: 0, createdAt: 1 },
      },
      { type: 'context.append_message', ts: TS, message: stored({ role: 'assistant', content: 'ok' }, 'assistant') },
    ];
    const state = replayWireEvents(events);
    expect(state.messages).toHaveLength(2);
    expect(state.turnCount).toBe(1);
    expect(state.mode).toBe('yolo');
    expect(state.planMode).toBe(true);
    expect(state.thinkOverride).toBe('high');
    expect(state.goal?.objective).toBe('写报告');
  });

  it('apply_compaction 整体替换已重建的消息历史（日志不截断，内存在该事件处折叠）', () => {
    const old = [1, 2, 3].map((i) => stored({ role: 'user', content: `m${i}` }, 'user'));
    const survivors = [stored({ role: 'user', content: '摘要' }, 'compaction_summary')];
    const events: WireEvent[] = [
      ...old.map((m): WireEvent => ({ type: 'context.append_message', ts: TS, message: m })),
      { type: 'context.apply_compaction', ts: TS, messages: survivors },
      { type: 'context.append_message', ts: TS, message: stored({ role: 'user', content: 'm4' }, 'user') },
    ];
    const state = replayWireEvents(events);
    expect(state.messages.map((m) => m.message.content)).toEqual(['摘要', 'm4']);
  });

  it('goal.update 携带空 goal = 清除；think.set 缺省 override = 清除覆盖', () => {
    const state = emptyWireReplayState();
    applyWireEvent(state, {
      type: 'goal.update',
      ts: TS,
      goal: { objective: 'x', status: 'active', turnsUsed: 0, tokensUsed: 0, createdAt: 1 },
    });
    applyWireEvent(state, { type: 'think.set', ts: TS, override: 'low' });
    applyWireEvent(state, { type: 'goal.update', ts: TS });
    applyWireEvent(state, { type: 'think.set', ts: TS });
    expect(state.goal).toBeUndefined();
    expect(state.thinkOverride).toBeUndefined();
  });

  it('重放无副作用：同一事件序列重放两次结果一致，且不修改输入事件', () => {
    const events: WireEvent[] = [
      { type: 'context.append_message', ts: TS, message: stored({ role: 'user', content: 'a' }, 'user') },
      { type: 'permission.set_mode', ts: TS, mode: 'auto' },
    ];
    const snapshot = JSON.stringify(events);
    const s1 = replayWireEvents(events);
    const s2 = replayWireEvents(events);
    expect(s1.messages.map((m) => m.id)).toEqual(s2.messages.map((m) => m.id));
    expect(s1.mode).toBe(s2.mode);
    expect(JSON.stringify(events)).toBe(snapshot);
  });

  it('已送达集合双通道回填：delivered 事件与 background_task 消息算出相同幂等键', () => {
    const note = stored(
      { role: 'user', content: '<notification/>' },
      { kind: 'background_task', taskId: 'task-1', notificationId: 'task:task-1:completed' },
    );
    const fromMessage = replayWireEvents([{ type: 'context.append_message', ts: TS, message: note }]);
    const fromEvent = replayWireEvents([
      { type: 'background.notify_delivered', ts: TS, taskId: 'task-1', status: 'completed', notificationId: 'task:task-1:completed' },
    ]);
    const key = notifyDedupKey('task-1', 'completed', 'task:task-1:completed');
    expect(fromMessage.deliveredNotifications.has(key)).toBe(true);
    expect(fromEvent.deliveredNotifications.has(key)).toBe(true);
    // 两通道算出的键必须一致，否则去重失效
    expect([...fromMessage.deliveredNotifications]).toEqual([...fromEvent.deliveredNotifications]);
  });

  it('background.task_settle 事件按任务 id 记录终态', () => {
    const state = replayWireEvents([
      {
        type: 'background.task_settle',
        ts: TS,
        task: { id: 'task-1', command: 'npm test', status: 'completed', startedAt: TS, output: '' },
      },
    ]);
    expect(state.settledTasks.get('task-1')?.status).toBe('completed');
  });
});

describe('notifyDedupKeyFromOrigin', () => {
  it('规范 notificationId（task:<taskId>:<status>）拆出的键与显式三段键一致', () => {
    expect(notifyDedupKeyFromOrigin('task-1', 'task:task-1:failed')).toBe(
      notifyDedupKey('task-1', 'failed', 'task:task-1:failed'),
    );
  });

  it('缺 taskId 时从 notificationId 回取；非规范 id 时 status 落空串但键仍稳定', () => {
    expect(notifyDedupKeyFromOrigin(undefined, 'task:task-9:killed')).toBe(
      notifyDedupKey('task-9', 'killed', 'task:task-9:killed'),
    );
    const odd = notifyDedupKeyFromOrigin('task-1', 'custom-id');
    expect(odd).toBe(notifyDedupKey('task-1', '', 'custom-id'));
    expect(notifyDedupKeyFromOrigin('task-1', 'custom-id')).toBe(odd); // 幂等
  });
});

describe('parseWireLine', () => {
  it('正常行解析为事件；空行/损坏行/崩溃截断尾行返回 null', () => {
    const event: WireEvent = { type: 'permission.set_mode', ts: TS, mode: 'yolo' };
    expect(parseWireLine(JSON.stringify(event))).toEqual(event);
    expect(parseWireLine('')).toBeNull();
    expect(parseWireLine('   ')).toBeNull();
    expect(parseWireLine('{"type":"permission.set_mode","ts":"2026')).toBeNull(); // 截断
    expect(parseWireLine('not json')).toBeNull();
    expect(parseWireLine('42')).toBeNull();
  });
});

describe('closeDanglingToolUse 悬空 tool_use 闭合', () => {
  it('末尾 assistant 带 tool_use：合成 is_error 的 tool_result 闭合，不假装成功', () => {
    const messages = [
      stored({ role: 'user', content: '跑一下' }, 'user'),
      stored(
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '好' },
            { type: 'tool_use', id: 'tu-1', name: 'bash', input: { command: 'ls' } },
          ],
        },
        'assistant',
      ),
    ];
    const result = closeDanglingToolUse(messages);
    expect(result.closed).toBe(true);
    expect(result.closedToolUseIds).toEqual(['tu-1']);
    const closure = result.messages.at(-1)!;
    expect(closure.origin.kind).toBe('tool');
    expect(closure.message.role).toBe('user');
    const blocks = closure.message.content as { type: string; tool_use_id: string; is_error: boolean }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('tool_result');
    expect(blocks[0]!.tool_use_id).toBe('tu-1');
    expect(blocks[0]!.is_error).toBe(true);
    // 原数组不被修改
    expect(messages).toHaveLength(2);
  });

  it('末尾 assistant 有多个 tool_use：全部闭合', () => {
    const messages = [
      stored(
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'a', input: {} },
            { type: 'tool_use', id: 'tu-2', name: 'b', input: {} },
          ],
        },
        'assistant',
      ),
    ];
    const result = closeDanglingToolUse(messages);
    expect(result.closedToolUseIds).toEqual(['tu-1', 'tu-2']);
    expect(result.messages.at(-1)!.message.content).toHaveLength(2);
  });

  it('末尾不是悬空 tool_use（纯文本/已有 tool_result/user 消息/空历史）：不闭合', () => {
    const textTail = [stored({ role: 'assistant', content: 'done' }, 'assistant')];
    expect(closeDanglingToolUse(textTail).closed).toBe(false);
    const userTail = [stored({ role: 'user', content: 'q' }, 'user')];
    expect(closeDanglingToolUse(userTail).closed).toBe(false);
    expect(closeDanglingToolUse([]).closed).toBe(false);
    const noToolUse = [
      stored({ role: 'assistant', content: [{ type: 'text', text: '想完了' }] }, 'assistant'),
    ];
    expect(closeDanglingToolUse(noToolUse).closed).toBe(false);
  });
});

describe('repairOrphanToolResults 孤儿 tool_result 降级', () => {
  const assistantToolUse = stored(
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '读一下' },
        { type: 'tool_use', id: 'tu-1', name: 'read_file', input: { path: 'a.ts' } },
      ],
    },
    'assistant',
  );
  const toolResult = (id: string, text = '文件内容') =>
    stored({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }, 'tool');
  const assistantText = stored({ role: 'assistant', content: [{ type: 'text', text: '读完了' }] }, 'assistant');

  it('有效配对不动：tool_result 紧跟含匹配 tool_use 的 assistant', () => {
    const messages = [assistantToolUse, toolResult('tu-1'), assistantText];
    const result = repairOrphanToolResults(messages);
    expect(result.repaired).toBe(false);
    expect(result.repairedToolUseIds).toEqual([]);
    expect(result.messages[1]!.message.content).toEqual(messages[1]!.message.content);
  });

  it('连续的纯 tool_result user 组同属一组应答：全部视为有效配对', () => {
    const multiUse = stored(
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'a', input: {} },
          { type: 'tool_use', id: 'tu-2', name: 'b', input: {} },
        ],
      },
      'assistant',
    );
    const messages = [multiUse, toolResult('tu-1'), toolResult('tu-2'), assistantText];
    const result = repairOrphanToolResults(messages);
    expect(result.repaired).toBe(false);
  });

  it('孤儿 tool_result（前序是 assistant 纯文本）降级为 text，内容完整保留', () => {
    // 存量尾部重复的同构序列：assistant(tool_use) → result → assistant(text) → result(孤儿)
    const messages = [assistantToolUse, toolResult('tu-1'), assistantText, toolResult('tu-1'), assistantText];
    const result = repairOrphanToolResults(messages);
    expect(result.repaired).toBe(true);
    expect(result.repairedToolUseIds).toEqual(['tu-1']);
    // 第一条 result 是有效配对，保持 tool_result 类型
    const kept = result.messages[1]!.message.content as { type: string }[];
    expect(kept[0]!.type).toBe('tool_result');
    // 孤儿那条变成 text 块，原文与 id 都留在文本里
    const demoted = result.messages[3]!.message.content as { type: string; text: string }[];
    expect(demoted[0]!.type).toBe('text');
    expect(demoted[0]!.text).toContain('文件内容');
    expect(demoted[0]!.text).toContain('tu-1');
    // 原数组不被修改
    expect((messages[3]!.message.content as { type: string }[])[0]!.type).toBe('tool_result');
  });

  it('混合内容消息里的孤儿块单独降级，同消息内的文本块保留', () => {
    const mixed = stored(
      {
        role: 'user',
        content: [
          { type: 'text', text: '补充说明' },
          { type: 'tool_result', tool_use_id: 'tu-9', content: '旧结果' },
        ],
      },
      'tool',
    );
    const messages = [assistantText, mixed];
    const result = repairOrphanToolResults(messages);
    expect(result.repairedToolUseIds).toEqual(['tu-9']);
    const blocks = result.messages[1]!.message.content as { type: string; text?: string }[];
    expect(blocks.map((b) => b.type)).toEqual(['text', 'text']);
    expect(blocks[0]!.text).toBe('补充说明');
    expect(blocks[1]!.text).toContain('旧结果');
  });

  it('无 tool_result 的历史原样返回', () => {
    const messages = [stored({ role: 'user', content: 'q' }, 'user'), assistantText];
    const result = repairOrphanToolResults(messages);
    expect(result.repaired).toBe(false);
    expect(result.messages).toEqual(messages);
  });
});
