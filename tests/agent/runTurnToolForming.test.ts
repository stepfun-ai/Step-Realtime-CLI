import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/loop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { collect, makeFakeProvider, toolUseBlock } from '../helpers/fakeProvider.js';

function sm(text: string): StoredMessage {
  return stored({ role: 'user', content: text }, { kind: 'user' });
}

describe('runTurn 工具参数流式事件（tool_forming / tool_args_delta）', () => {
  it('content_block_start[tool_use] → tool_forming；input_json_delta → tool_args_delta（按块序）', async () => {
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        toolCallStream: { id: 'call_1', name: 'read_file', argChunks: ['{"pa', 'th":"a.ts"}'] },
        // finalMessage 里给真实 tool_use，让回合走完执行路径（工具未注册会报 unknown tool，无妨）
        finalContent: [toolUseBlock('call_1', 'read_file', { path: 'a.ts' })],
        stopReason: 'tool_use',
      },
      { textChunks: ['读完'], finalContent: [{ type: 'text', text: '读完' } as never] },
    ]);
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages: [sm('读 a.ts')] }),
    );
    const forming = events.filter((e) => e.type === 'tool_forming');
    expect(forming).toEqual([{ type: 'tool_forming', id: 'call_1', name: 'read_file' }]);
    const argDeltas = events.filter((e) => e.type === 'tool_args_delta');
    expect(argDeltas).toEqual([
      { type: 'tool_args_delta', id: 'call_1', partialJson: '{"pa' },
      { type: 'tool_args_delta', id: 'call_1', partialJson: 'th":"a.ts"}' },
    ]);
    // 顺序：forming 在参数增量之前，参数增量在 tool_start 之前
    const seq = events.map((e) => e.type);
    expect(seq.indexOf('tool_forming')).toBeLessThan(seq.indexOf('tool_args_delta'));
    expect(seq.indexOf('tool_args_delta')).toBeLessThan(seq.indexOf('tool_start'));
  });

  it('无工具调用的普通回合不产生 forming 事件（回归：不影响正文流）', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: ['你好'], finalContent: [{ type: 'text', text: '你好' } as never] },
    ]);
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages: [sm('hi')] }),
    );
    expect(events.filter((e) => e.type === 'tool_forming' || e.type === 'tool_args_delta')).toEqual([]);
  });
});
