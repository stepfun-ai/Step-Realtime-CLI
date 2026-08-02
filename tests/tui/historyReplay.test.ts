import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import type { MessageOriginKind, StoredMessage } from '../../src/agent/message.js';
import { historyToDisplayItems } from '../../src/tui/historyReplay.js';

function m(
  message: Anthropic.MessageParam,
  origin: MessageOriginKind,
  id: string,
): StoredMessage {
  return { message, origin: { kind: origin }, id, ts: new Date().toISOString() };
}

describe('historyToDisplayItems', () => {
  it('纯文本 user / assistant 转成对应条目', () => {
    const messages: StoredMessage[] = [
      m({ role: 'user', content: '你好' }, 'user', 'u1'),
      m({ role: 'assistant', content: '你好，有什么可以帮你' }, 'assistant', 'a1'),
    ];
    const { items } = historyToDisplayItems(messages);
    expect(items).toEqual([
      { kind: 'user', text: '你好' },
      { kind: 'assistant', text: '你好，有什么可以帮你' },
    ]);
  });

  it('assistant 的 text + tool_use 保持原始顺序，tool_result 回填状态与结果', () => {
    const messages: StoredMessage[] = [
      m({ role: 'user', content: '读一下 a.txt' }, 'user', 'u1'),
      m(
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '我来读取' },
            { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } },
          ],
        },
        'assistant',
        'a1',
      ),
      m(
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '文件内容' }],
        },
        'tool',
        't1',
      ),
    ];
    const { items } = historyToDisplayItems(messages);
    expect(items[0]).toEqual({ kind: 'user', text: '读一下 a.txt' });
    // 文字先于 tool（原始顺序）
    expect(items[1]).toEqual({ kind: 'assistant', text: '我来读取' });
    expect(items[2]).toMatchObject({
      kind: 'tool',
      id: 'call_1',
      name: 'read_file',
      status: 'ok',
      result: '文件内容',
    });
  });

  it('tool_result is_error=true 时 tool 状态为 error', () => {
    const messages: StoredMessage[] = [
      m({ role: 'user', content: 'x' }, 'user', 'u1'),
      m(
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: {} }],
        },
        'assistant',
        'a1',
      ),
      m(
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'c1', content: '出错了', is_error: true }],
        },
        'tool',
        't1',
      ),
    ];
    const { items } = historyToDisplayItems(messages);
    const tool = items.find((i) => i.kind === 'tool');
    expect(tool).toMatchObject({ status: 'error', result: '出错了' });
  });

  it('thinking 块单独成条', () => {
    const messages: StoredMessage[] = [
      m({ role: 'user', content: 'x' }, 'user', 'u1'),
      m(
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '让我想想', signature: '' },
            { type: 'text', text: '答案是 42' },
          ],
        },
        'assistant',
        'a1',
      ),
    ];
    const { items } = historyToDisplayItems(messages);
    expect(items).toContainEqual({ kind: 'thinking', text: '让我想想' });
    expect(items).toContainEqual({ kind: 'assistant', text: '答案是 42' });
  });

  it('injection 类消息被跳过', () => {
    const messages: StoredMessage[] = [
      m({ role: 'user', content: '真实输入' }, 'user', 'u1'),
      m({ role: 'user', content: '<system-reminder>内部注入</system-reminder>' }, 'injection', 'inj1'),
    ];
    const { items } = historyToDisplayItems(messages);
    expect(items).toEqual([{ kind: 'user', text: '真实输入' }]);
  });

  it('图片块转成 [图片] 占位', () => {
    const messages: StoredMessage[] = [
      m(
        {
          role: 'user',
          content: [
            { type: 'text', text: '看这张图' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'stepref:abc' },
            },
          ],
        },
        'user',
        'u1',
      ),
    ];
    const { items } = historyToDisplayItems(messages);
    expect(items).toContainEqual({ kind: 'user', text: '看这张图' });
    expect(items).toContainEqual({ kind: 'user', text: '[图片]' });
  });

  it('超出 keepTurns 时折叠更早轮次', () => {
    const messages: StoredMessage[] = [];
    for (let i = 1; i <= 5; i++) {
      messages.push(m({ role: 'user', content: `q${i}` }, 'user', `u${i}`));
      messages.push(m({ role: 'assistant', content: `a${i}` }, 'assistant', `a${i}`));
    }
    const { items, totalTurns, foldedTurns } = historyToDisplayItems(messages, 2);
    expect(totalTurns).toBe(5);
    expect(foldedTurns).toBe(3);
    // 只保留最近 2 轮的 user/assistant，共 4 条
    expect(items.filter((i) => i.kind === 'user').map((i) => (i as { text: string }).text)).toEqual([
      'q4',
      'q5',
    ]);
  });
});
