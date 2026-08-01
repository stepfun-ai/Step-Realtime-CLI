import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { projectMessages } from '../../src/provider/projector.js';

/** 快捷构造：assistant 带 tool_use / user 带 tool_result。 */
const assistantToolUse = (id: string): Anthropic.MessageParam => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 't', input: {} }],
});
const userToolResult = (id: string, text = 'r'): Anthropic.MessageParam => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: text }],
});

describe('projectMessages 孤儿 tool_result 修复', () => {
  it('找不到对应 tool_use 的 tool_result 被丢弃', () => {
    const out = projectMessages([
      { role: 'user', content: '问' },
      userToolResult('ghost'),
      { role: 'assistant', content: '答' },
    ]);
    // 孤儿结果被丢后该消息掏空，与前后消息按规则整形，全文不再出现 ghost
    expect(JSON.stringify(out)).not.toContain('ghost');
  });

  it('正常配对的 tool_result 保留', () => {
    const out = projectMessages([
      { role: 'user', content: '问' },
      assistantToolUse('a'),
      userToolResult('a'),
    ]);
    expect(JSON.stringify(out)).toContain('a');
  });

  it('有 tool_use 无 tool_result：合成错误结果并入紧随的 user 消息', () => {
    const out = projectMessages([
      { role: 'user', content: '问' },
      assistantToolUse('dangling'),
      { role: 'user', content: '下一句' },
    ]);
    const userMsg = out.find(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === 'tool_result'),
    );
    expect(userMsg).toBeDefined();
    const tr = (userMsg!.content as Anthropic.ToolResultBlockParam[]).find(
      (b) => b.type === 'tool_result' && b.tool_use_id === 'dangling',
    ) as Anthropic.ToolResultBlockParam;
    expect(tr.is_error).toBe(true);
  });

  it('悬空 tool_use 后没有 user 消息：就地插入合成结果消息', () => {
    const out = projectMessages([
      { role: 'user', content: '问' },
      assistantToolUse('tail'),
    ]);
    const last = out[out.length - 1]!;
    expect(last.role).toBe('user');
    const tr = (last.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(tr.type).toBe('tool_result');
    expect(tr.tool_use_id).toBe('tail');
    expect(tr.is_error).toBe(true);
  });
});

describe('projectMessages 合并连续同 role 消息', () => {
  it('连续两条 user 合并为一条，块按序拼接', () => {
    const out = projectMessages([
      { role: 'user', content: '一' },
      { role: 'user', content: [{ type: 'text', text: '二' }] },
    ]);
    expect(out).toHaveLength(1);
    expect((out[0]!.content as unknown[]).length).toBe(2);
  });

  it('连续两条 assistant 合并', () => {
    const out = projectMessages([
      { role: 'user', content: '问' },
      { role: 'assistant', content: '答一' },
      { role: 'assistant', content: [{ type: 'text', text: '答二' }] },
    ]);
    expect(out).toHaveLength(2);
    expect((out[1]!.content as unknown[]).length).toBe(2);
  });
});

describe('projectMessages 首条补空 user', () => {
  it('首条是 assistant 时补一条空 user 开场', () => {
    const out = projectMessages([{ role: 'assistant', content: '答' }]);
    expect(out[0]!.role).toBe('user');
    expect(out[0]!.content).toBe('');
  });

  it('空输入也只补一条空 user', () => {
    const out = projectMessages([]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ role: 'user', content: '' });
  });

  it('首条已是 user 时不补', () => {
    const out = projectMessages([{ role: 'user', content: '问' }]);
    expect(out).toHaveLength(1);
  });
});

describe('projectMessages 不变性', () => {
  it('不改动入参数组与消息对象', () => {
    const input: Anthropic.MessageParam[] = [
      { role: 'user', content: '问' },
      assistantToolUse('x'),
      userToolResult('x'),
    ];
    const before = JSON.stringify(input);
    projectMessages(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
