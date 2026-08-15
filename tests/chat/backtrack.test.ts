import { describe, expect, it } from 'vitest';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { computeBacktrack, extractUserText, truncateItemsAtLastUser } from '../../src/chat/backtrack.js';
import type { DisplayItem } from '../../src/chat/types.js';

describe('extractUserText 抽回用户文本', () => {
  it('纯字符串 content 原样返回', () => {
    const msg = stored({ role: 'user', content: '你好' }, { kind: 'user' });
    expect(extractUserText(msg)).toBe('你好');
  });

  it('数组 content 只取文本块、丢弃图片块', () => {
    const msg = stored(
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xxx' } },
        ],
      },
      { kind: 'user' },
    );
    expect(extractUserText(msg)).toBe('看这张图');
  });

  it('无文本块返回空串', () => {
    const msg = stored(
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }] },
      { kind: 'user' },
    );
    expect(extractUserText(msg)).toBe('');
  });
});

describe('computeBacktrack 历史回退', () => {
  it('回滚最后一条 user 及其之后的全部历史，返回 prefill', () => {
    const history: StoredMessage[] = [
      stored({ role: 'user', content: '第一条' }, { kind: 'user' }),
      stored({ role: 'assistant', content: '回复一' }, { kind: 'assistant' }),
      stored({ role: 'user', content: '第二条' }, { kind: 'user' }),
      stored({ role: 'assistant', content: '回复二' }, { kind: 'assistant' }),
    ];
    const res = computeBacktrack(history);
    expect(res).not.toBeNull();
    expect(res!.prefill).toBe('第二条');
    // 截断到最后一条 user 之前：只剩前两条
    expect(res!.history).toHaveLength(2);
    expect(res!.history[0]!.origin.kind).toBe('user');
    expect(res!.history[1]!.origin.kind).toBe('assistant');
  });

  it('只有一条 user 时回退成空历史', () => {
    const history: StoredMessage[] = [stored({ role: 'user', content: '唯一' }, { kind: 'user' })];
    const res = computeBacktrack(history);
    expect(res!.history).toHaveLength(0);
    expect(res!.prefill).toBe('唯一');
  });

  it('无 user 消息返回 null', () => {
    const history: StoredMessage[] = [stored({ role: 'assistant', content: '无主' }, { kind: 'assistant' })];
    expect(computeBacktrack(history)).toBeNull();
    expect(computeBacktrack([])).toBeNull();
  });

  it('不修改传入数组（返回新切片）', () => {
    const history: StoredMessage[] = [
      stored({ role: 'user', content: 'a' }, { kind: 'user' }),
      stored({ role: 'assistant', content: 'b' }, { kind: 'assistant' }),
    ];
    computeBacktrack(history);
    expect(history).toHaveLength(2);
  });
});

describe('truncateItemsAtLastUser 转录区回退', () => {
  it('移除最后一条 user 条目及其之后的所有条目', () => {
    const items: DisplayItem[] = [
      { kind: 'user', text: '第一条' },
      { kind: 'assistant', text: '回复一' },
      { kind: 'user', text: '第二条' },
      { kind: 'assistant', text: '回复二' },
      { kind: 'note', text: '尾注' },
    ];
    const res = truncateItemsAtLastUser(items);
    expect(res).toHaveLength(2);
    expect(res[0]!.kind).toBe('user');
    expect(res[1]!.kind).toBe('assistant');
  });

  it('无 user 条目原样返回', () => {
    const items: DisplayItem[] = [{ kind: 'note', text: '只有 note' }];
    expect(truncateItemsAtLastUser(items)).toHaveLength(1);
  });
});
