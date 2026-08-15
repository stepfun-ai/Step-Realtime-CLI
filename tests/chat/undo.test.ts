import { describe, expect, it } from 'vitest';
import type { MessageOriginKind, StoredMessage } from '../../src/agent/message.js';
import type { DisplayItem } from '../../src/chat/types.js';
import {
  clearUndoSnapshots,
  computeUndo,
  popUndoSnapshots,
  pushUndoSnapshot,
  truncateItemsAtTurns,
  type UndoSnapshot,
} from '../../src/chat/undo.js';

function msg(
  role: 'user' | 'assistant',
  origin: MessageOriginKind,
  text: string,
  id: string,
): StoredMessage {
  return {
    message: { role, content: text },
    origin: { kind: origin },
    id,
    ts: new Date().toISOString(),
  };
}

/** 构造 N 个「真人输入 + 助手回复 + 工具结果」的完整轮次（对齐 tests/agent/turns.test.ts）。 */
function buildTurns(n: number): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(msg('user', 'user', `问题 ${i}`, `u${i}`));
    out.push(msg('assistant', 'assistant', `回复 ${i}`, `a${i}`));
    out.push(msg('user', 'tool', `工具结果 ${i}`, `t${i}`));
  }
  return out;
}

function snap(historyLen: number, title = 'task'): UndoSnapshot {
  return { historyLen, todos: [{ title, status: 'pending' }], planMode: false, prePlanMode: null };
}

describe('computeUndo N 轮截断', () => {
  it('撤销最近 2 轮：截到倒数第 2 个 user 之前', () => {
    const res = computeUndo(buildTurns(5), 2);
    expect(res).not.toBeNull();
    expect(res!.removedTurns).toBe(2);
    // 5 轮 × 3 条 = 15 条，截掉 2 轮 × 3 条 = 剩 9 条（前 3 轮）
    expect(res!.history).toHaveLength(9);
    expect(res!.history[0]!.id).toBe('u1');
    expect(res!.history.at(-1)!.id).toBe('t3');
  });

  it('撤销 1 轮：切点在轮起点，残留的 tool_result 与其 tool_use 配对不被切开', () => {
    const res = computeUndo(buildTurns(2), 1);
    expect(res!.removedTurns).toBe(1);
    expect(res!.history).toHaveLength(3);
    expect(res!.history.map((m) => m.id)).toEqual(['u1', 'a1', 't1']);
  });

  it('n 超过可撤销轮数：撤到最早可撤销轮，removedTurns 记实际数', () => {
    const res = computeUndo(buildTurns(3), 10);
    expect(res!.removedTurns).toBe(3);
    expect(res!.history).toHaveLength(0);
  });

  it('含 compaction_summary/user_verbatim 前缀：n 超界也不越过压缩产物', () => {
    const history: StoredMessage[] = [
      msg('user', 'user_verbatim', '压缩前原话', 'uv1'),
      msg('user', 'compaction_summary', '摘要', 'cs1'),
      ...buildTurns(2),
    ];
    const res = computeUndo(history, 99);
    expect(res!.removedTurns).toBe(2);
    expect(res!.history).toHaveLength(2);
    expect(res!.history[0]!.origin.kind).toBe('user_verbatim');
    expect(res!.history[1]!.origin.kind).toBe('compaction_summary');
  });

  it('压缩产物不算轮起点：undo 1 轮只撤压缩后的最近一轮', () => {
    const history: StoredMessage[] = [
      msg('user', 'user_verbatim', '压缩前原话', 'uv1'),
      msg('user', 'compaction_summary', '摘要', 'cs1'),
      ...buildTurns(2),
    ];
    const res = computeUndo(history, 1);
    expect(res!.removedTurns).toBe(1);
    // 剩 2 条前缀 + 第 1 轮 3 条
    expect(res!.history).toHaveLength(5);
    expect(res!.history.at(-1)!.id).toBe('t1');
  });

  it('无可撤销的轮返回 null（空历史 / 无 user 消息 / 非法 n）', () => {
    expect(computeUndo([], 1)).toBeNull();
    expect(computeUndo([msg('assistant', 'assistant', '无主', 'a0')], 1)).toBeNull();
    expect(computeUndo([msg('user', 'user_verbatim', '原话', 'uv0')], 1)).toBeNull();
    expect(computeUndo(buildTurns(1), 0)).toBeNull();
    expect(computeUndo(buildTurns(1), -1)).toBeNull();
    expect(computeUndo(buildTurns(1), 1.5)).toBeNull();
  });

  it('不修改传入数组（返回新切片）', () => {
    const history = buildTurns(3);
    computeUndo(history, 1);
    expect(history).toHaveLength(9);
  });
});

describe('truncateItemsAtTurns 转录区回退', () => {
  const items: DisplayItem[] = [
    { kind: 'user', text: '第一条' },
    { kind: 'assistant', text: '回复一' },
    { kind: 'user', text: '第二条' },
    { kind: 'assistant', text: '回复二' },
    { kind: 'user', text: '第三条' },
    { kind: 'assistant', text: '回复三' },
  ];

  it('移除最后第 N 条 user 条目及其之后的所有条目', () => {
    const res = truncateItemsAtTurns(items, 2);
    expect(res).toHaveLength(2);
    expect(res.map((i) => i.kind)).toEqual(['user', 'assistant']);
  });

  it('N 超 user 条目数时截到最早一条之前', () => {
    expect(truncateItemsAtTurns(items, 99)).toHaveLength(0);
  });

  it('无 user 条目或 n < 1 时原样返回', () => {
    const notes: DisplayItem[] = [{ kind: 'note', text: '只有 note' }];
    expect(truncateItemsAtTurns(notes, 2)).toHaveLength(1);
    expect(truncateItemsAtTurns(items, 0)).toHaveLength(6);
  });
});

describe('undo 快照栈 压/弹/清', () => {
  it('弹 2 份返回最深（最早）那份，栈剩 1 份', () => {
    const stack: UndoSnapshot[] = [snap(0, 't0'), snap(3, 't1'), snap(6, 't2')];
    const target = popUndoSnapshots(stack, 2);
    expect(target!.historyLen).toBe(3); // 被撤销最早那轮之前的边界
    expect(stack).toHaveLength(1);
    expect(stack[0]!.historyLen).toBe(0);
  });

  it('弹得比栈深：全弹，返回栈底那份', () => {
    const stack: UndoSnapshot[] = [snap(0), snap(3)];
    const target = popUndoSnapshots(stack, 10);
    expect(target!.historyLen).toBe(0);
    expect(stack).toHaveLength(0);
  });

  it('空栈或非法 count 返回 undefined', () => {
    expect(popUndoSnapshots([], 1)).toBeUndefined();
    const stack: UndoSnapshot[] = [snap(0)];
    expect(popUndoSnapshots(stack, 0)).toBeUndefined();
    expect(stack).toHaveLength(1);
  });

  it('push 追加到栈顶；clear 清空（new/resume/fork/compact 清栈时机）', () => {
    const stack: UndoSnapshot[] = [];
    pushUndoSnapshot(stack, snap(0));
    pushUndoSnapshot(stack, snap(3));
    expect(stack).toHaveLength(2);
    clearUndoSnapshots(stack);
    expect(stack).toHaveLength(0);
  });
});
