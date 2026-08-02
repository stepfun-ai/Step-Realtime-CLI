import { describe, expect, it } from 'vitest';
import {
  normalizeMessage,
  normalizeOrigin,
  stored,
  type MessageOrigin,
  type StoredMessage,
} from '../../src/agent/message.js';

describe('normalizeOrigin', () => {
  it('旧字符串形态归一化为 { kind } 对象', () => {
    expect(normalizeOrigin('user')).toEqual({ kind: 'user' });
    expect(normalizeOrigin('injection')).toEqual({ kind: 'injection' });
    expect(normalizeOrigin('compaction_summary')).toEqual({ kind: 'compaction_summary' });
  });

  it('对象形态直通（同引用，含载荷字段）', () => {
    const origin: MessageOrigin = { kind: 'background_task', taskId: 't1', startsPromptTurn: true };
    expect(normalizeOrigin(origin)).toBe(origin);
  });
});

describe('normalizeMessage', () => {
  it('字符串 origin 的消息换成对象形态副本（原对象不动）', () => {
    // 模拟旧盘上读出的字符串 origin 消息
    const legacy = {
      message: { role: 'user', content: 'hi' },
      origin: 'user',
      id: 'm1',
      ts: '2026-08-01T00:00:00.000Z',
    } as unknown as StoredMessage;
    const normalized = normalizeMessage(legacy);
    expect(normalized.origin).toEqual({ kind: 'user' });
    expect(normalized.id).toBe('m1');
    // 换副本，不原地改
    expect(legacy.origin as unknown).toBe('user');
  });

  it('对象 origin 的消息原样返回（同引用）', () => {
    const m = stored({ role: 'user', content: 'hi' }, 'user');
    expect(normalizeMessage(m)).toBe(m);
  });
});

describe('stored 的 origin 落形', () => {
  it('传便捷字符串也一律写对象形态', () => {
    const m = stored({ role: 'assistant', content: 'a' }, 'assistant');
    expect(m.origin).toEqual({ kind: 'assistant' });
  });

  it('传对象时保留全部载荷字段', () => {
    const origin: MessageOrigin = {
      kind: 'background_task',
      taskId: 'task-1',
      notificationId: 'n-1',
      agentId: 'agent-1',
      startsPromptTurn: false,
    };
    const m = stored({ role: 'user', content: 'done' }, origin);
    expect(m.origin).toEqual(origin);
  });

  it('startsPromptTurn 缺省即「中途注入」语义，不强制填写', () => {
    const m = stored({ role: 'user', content: 'x' }, { kind: 'injection' });
    expect(m.origin.startsPromptTurn).toBeUndefined();
  });
});
