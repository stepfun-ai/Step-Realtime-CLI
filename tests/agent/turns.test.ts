import { describe, expect, it } from 'vitest';
import type { MessageOriginKind, StoredMessage } from '../../src/agent/message.js';
import { countTurns, sliceRecentTurns } from '../../src/agent/turns.js';

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

/** 构造 N 个「真人输入 + 助手回复 + 工具结果」的完整轮次。 */
function buildTurns(n: number): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(msg('user', 'user', `问题 ${i}`, `u${i}`));
    out.push(msg('assistant', 'assistant', `回复 ${i}`, `a${i}`));
    out.push(msg('user', 'tool', `工具结果 ${i}`, `t${i}`));
  }
  return out;
}

describe('countTurns', () => {
  it('空历史返回 0', () => {
    expect(countTurns([])).toBe(0);
  });

  it('按真人 user 消息计数，tool 结果不算新一轮', () => {
    // 5 轮，每轮 3 条（user + assistant + tool），共 15 条，但只有 5 个真人 user
    expect(countTurns(buildTurns(5))).toBe(5);
  });

  it('首个 user 之前的前导消息归为第 1 轮', () => {
    const messages: StoredMessage[] = [
      msg('user', 'tool', '孤立工具结果', 't0'),
      msg('assistant', 'assistant', '压缩摘要残留', 'a0'),
    ];
    expect(countTurns(messages)).toBe(1);
  });
});

describe('sliceRecentTurns', () => {
  it('keepTurns >= 总轮数时返回全量，无折叠', () => {
    const messages = buildTurns(3);
    const r = sliceRecentTurns(messages, 10);
    expect(r.messages.length).toBe(9);
    expect(r.totalTurns).toBe(3);
    expect(r.foldedTurns).toBe(0);
  });

  it('keepTurns <= 0 返回全量', () => {
    const messages = buildTurns(3);
    const r = sliceRecentTurns(messages, 0);
    expect(r.foldedTurns).toBe(0);
    expect(r.messages.length).toBe(9);
  });

  it('只保留最近 N 轮，折叠更早的轮次', () => {
    // 5 轮，保留最近 2 轮 → 折叠 3 轮，保留 2×3=6 条，且从第 4 轮的 user 起
    const r = sliceRecentTurns(buildTurns(5), 2);
    expect(r.totalTurns).toBe(5);
    expect(r.foldedTurns).toBe(3);
    expect(r.messages.length).toBe(6);
    expect(r.messages[0]!.id).toBe('u4'); // 保留的第一条是第 4 轮的真人输入
    expect(r.messages.at(-1)!.id).toBe('t5');
  });
});
