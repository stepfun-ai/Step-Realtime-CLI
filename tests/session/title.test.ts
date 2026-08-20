import { describe, expect, it } from 'vitest';
import type { ChatProvider } from '../../src/provider/types.js';
import type { StoredMessage } from '../../src/agent/message.js';
import { canOverwriteTitle, cleanGeneratedTitle, generateSessionTitle } from '../../src/session/title.js';

function userMsg(text: string): StoredMessage {
  return { message: { role: 'user', content: text }, origin: { kind: 'user' } } as StoredMessage;
}
function assistantMsg(text: string): StoredMessage {
  return { message: { role: 'assistant', content: text }, origin: { kind: 'agent' } } as StoredMessage;
}

/** 最小可用的假 provider：stream 返回固定文本 */
function fakeProvider(reply: string): ChatProvider {
  return {
    stream: () => ({
      finalMessage: async () => ({ content: [{ type: 'text', text: reply }] }),
    }),
  } as unknown as ChatProvider;
}
function throwingProvider(): ChatProvider {
  return {
    stream: () => { throw new Error('boom'); },
  } as unknown as ChatProvider;
}

describe('cleanGeneratedTitle', () => {
  it('取首行并去引号与末尾标点', () => {
    expect(cleanGeneratedTitle('"修复输入框抖动"\n多余说明')).toBe('修复输入框抖动');
  });
  it('去掉 think 块', () => {
    expect(cleanGeneratedTitle('<think>想一想</think>会话标题')).toBe('会话标题');
  });
  it('超长截断到 50 字符并加省略号', () => {
    const long = '标'.repeat(60);
    const out = cleanGeneratedTitle(long);
    expect(out).toBeDefined();
    expect(out!.length).toBe(50);
    expect(out!.endsWith('…')).toBe(true);
  });
  it('空输出返回 undefined', () => {
    expect(cleanGeneratedTitle('   \n ')).toBeUndefined();
    expect(cleanGeneratedTitle('<think>只有思考</think>')).toBeUndefined();
  });
});

describe('generateSessionTitle', () => {
  it('正常返回清洗后的标题', async () => {
    const t = await generateSessionTitle(fakeProvider('会话标题生成设计'), [userMsg('帮我做个标题功能'), assistantMsg('好的')]);
    expect(t).toBe('会话标题生成设计');
  });
  it('provider 抛错返回 undefined（静默回退）', async () => {
    const t = await generateSessionTitle(throwingProvider(), [userMsg('hi'), assistantMsg('hello')]);
    expect(t).toBeUndefined();
  });
  it('没有 user 消息时返回 undefined，不发请求', async () => {
    const t = await generateSessionTitle(fakeProvider('x'), [assistantMsg('hello')]);
    expect(t).toBeUndefined();
  });
  it('user 消息无文本内容时返回 undefined', async () => {
    const empty = { message: { role: 'user', content: [] }, origin: { kind: 'user' } } as unknown as StoredMessage;
    const t = await generateSessionTitle(fakeProvider('x'), [empty]);
    expect(t).toBeUndefined();
  });
});

describe('canOverwriteTitle', () => {
  it('title 为空：可以生成', () => {
    expect(canOverwriteTitle({}, '派生标题')).toBe(true);
    expect(canOverwriteTitle({ title: '' }, '派生标题')).toBe(true);
  });
  it('title 等于派生结果：可以覆盖', () => {
    expect(canOverwriteTitle({ title: '派生标题' }, '派生标题')).toBe(true);
  });
  it('title 被外部改过（不等于派生结果）：不动', () => {
    expect(canOverwriteTitle({ title: '别的标题' }, '派生标题')).toBe(false);
  });
  it('用户 rename 过（name 非空）：永不覆盖', () => {
    expect(canOverwriteTitle({ name: '我的会话', title: '派生标题' }, '派生标题')).toBe(false);
    expect(canOverwriteTitle({ name: '我的会话' }, undefined)).toBe(false);
  });
});
