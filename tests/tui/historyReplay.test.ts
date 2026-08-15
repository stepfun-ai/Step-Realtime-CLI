import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import type { MessageOriginKind, StoredMessage } from '../../src/agent/message.js';
import { historyToDisplayItems } from '../../src/chat/historyReplay.js';

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

  // 系统自撰的 user 角色消息（协议要求挂在 user 下，但不是真人输入）不得渲染成用户气泡：
  // 否则 resume 后用户会看到自己「说」过中断提示、后台任务 XML 信封、压缩摘要——那些话从没打过。
  describe('系统自撰的 user 消息不冒充用户输入', () => {
    it('中断提示（injection）不进历史区', () => {
      const messages: StoredMessage[] = [
        m({ role: 'user', content: '查一下 X' }, 'user', 'u1'),
        m({ role: 'user', content: '用户中断了模型的本次输出。这不是系统错误，请等待用户的下一步指示。' }, 'injection', 'inj1'),
      ];
      const { items } = historyToDisplayItems(messages);
      expect(items.filter((i) => i.kind === 'user')).toHaveLength(1);
      expect(items.some((i) => (i.text ?? '').includes('这不是系统错误'))).toBe(false);
    });

    it('压缩摘要不渲染成用户气泡', () => {
      const messages: StoredMessage[] = [
        m({ role: 'user', content: '之前聊到的内容摘要……' }, 'compaction_summary', 'cs1'),
        m({ role: 'user', content: '继续' }, 'user', 'u1'),
      ];
      const { items } = historyToDisplayItems(messages);
      expect(items).toEqual([{ kind: 'user', text: '继续' }]);
    });

    it('后台任务通知降级为 note，XML 信封正文不外泄', () => {
      const envelope = '<notification id="task:bg1:done" category="task">\n后台任务完成\n</notification>';
      const messages: StoredMessage[] = [
        {
          message: { role: 'user', content: envelope },
          origin: { kind: 'background_task', taskId: 'bg1', notificationId: 'task:bg1:done' },
          id: 'bg1',
          ts: new Date().toISOString(),
        },
      ];
      const { items } = historyToDisplayItems(messages);
      expect(items).toHaveLength(1);
      expect(items[0]?.kind).toBe('note'); // 不是 user
      expect(items[0]?.text).toContain('bg1');
      expect(items[0]?.text).not.toContain('<notification'); // 给模型看的信封不摆给用户
    });

    it('user_verbatim（压缩保真的真人原话）仍作为用户输入保留', () => {
      const messages: StoredMessage[] = [
        m({ role: 'user', content: '这是我当初说的话' }, 'user_verbatim', 'uv1'),
      ];
      const { items } = historyToDisplayItems(messages);
      expect(items).toEqual([{ kind: 'user', text: '这是我当初说的话' }]);
    });

    it('工具结果回灌（tool origin）不渲染成用户气泡', () => {
      const messages: StoredMessage[] = [
        m(
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '结果' }] },
          'tool',
          't1',
        ),
      ];
      const { items } = historyToDisplayItems(messages);
      expect(items.some((i) => i.kind === 'user')).toBe(false);
    });
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
