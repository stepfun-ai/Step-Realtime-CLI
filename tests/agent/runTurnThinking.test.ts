import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/loop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { collect, makeFakeProvider, textBlock, thinkingBlock, toolUseBlock } from '../helpers/fakeProvider.js';

function sm(text: string): StoredMessage {
  return stored({ role: 'user', content: text }, 'user');
}

describe('runTurn thinking 事件与历史', () => {
  it('thinking_delta 产生事件，正文 text 事件不受影响（思考先于正文）', async () => {
    const { provider } = makeFakeProvider([
      {
        thinkingChunks: ['先分析', '问题'],
        textChunks: ['答案', '如下'],
        finalContent: [thinkingBlock('先分析问题'), textBlock('答案如下')],
      },
    ]);
    const messages: StoredMessage[] = [sm('问')];
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages }),
    );

    const stream = events.filter((e) => e.type === 'thinking_delta' || e.type === 'text');
    expect(stream).toEqual([
      { type: 'thinking_delta', text: '先分析' },
      { type: 'thinking_delta', text: '问题' },
      { type: 'text', text: '答案' },
      { type: 'text', text: '如下' },
    ]);
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('finalMessage 的 thinking 块（带 signature）随 assistant 消息进历史', async () => {
    const { provider } = makeFakeProvider([
      {
        thinkingChunks: ['推理过程'],
        textChunks: ['结论'],
        finalContent: [thinkingBlock('推理过程', 'sig-abc'), textBlock('结论')],
      },
    ]);
    const messages: StoredMessage[] = [sm('问')];
    await collect(runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages }));

    const assistant = messages.find((m) => m.origin.kind === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.message.content).toEqual([
      { type: 'thinking', thinking: '推理过程', signature: 'sig-abc' },
      { type: 'text', text: '结论' },
    ]);
  });

  it('thinking + tool_use 回合：思考事件与工具事件都正常，thinking 块随历史保留', async () => {
    const { provider } = makeFakeProvider([
      {
        thinkingChunks: ['需要读文件'],
        textChunks: [],
        finalContent: [thinkingBlock('需要读文件'), toolUseBlock('c1', 'read_file', { path: 'package.json', limit: 1 })],
      },
      { textChunks: ['读完'], finalContent: [textBlock('读完')] },
    ]);
    const messages: StoredMessage[] = [sm('问')];
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages }),
    );

    expect(events[0]).toEqual({ type: 'thinking_delta', text: '需要读文件' });
    expect(events.some((e) => e.type === 'tool_start')).toBe(true);
    expect(events.at(-1)!.type).toBe('turn_done');
    const assistant = messages.find((m) => m.origin.kind === 'assistant');
    expect((assistant!.message.content as unknown[])[0]).toMatchObject({ type: 'thinking' });
  });
});
