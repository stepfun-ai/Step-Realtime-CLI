import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/loop.js';
import type { LoopHooks } from '../../src/agent/hooks.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';

function sm(text: string): StoredMessage {
  return stored({ role: 'user', content: text }, { kind: 'user' });
}

const base = (
  provider: ReturnType<typeof makeFakeProvider>['provider'],
  messages: StoredMessage[],
  hooks: LoopHooks,
) => ({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages, hooks });

describe('LoopHooks', () => {
  it('authorizeToolCall 拒绝：不执行工具，以 deny 原因回灌，回合继续', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'write_file', { path: 'x', content: 'y' })] },
      { textChunks: ['好的，我不写了'], finalContent: [textBlock('好的，我不写了')] },
    ]);
    const messages: StoredMessage[] = [sm('写文件')];
    const hooks: LoopHooks = {
      authorizeToolCall: (req) =>
        req.name === 'write_file'
          ? { decision: 'deny', reason: '用户未批准写操作' }
          : { decision: 'allow' },
    };
    const events = await collect(runAgent(base(provider, messages, hooks)));

    const toolEnd = events.find((e) => e.type === 'tool_end') as
      | { type: 'tool_end'; isError: boolean; result: string }
      | undefined;
    expect(toolEnd?.isError).toBe(true);
    expect(toolEnd?.result).toContain('用户未批准');

    // tool_result 已回灌，且没有真的写文件（历史推进到第二回合的文本）
    const toolResultMsg = messages[2]!.message;
    const blocks = toolResultMsg.content as Anthropic.ToolResultBlockParam[];
    expect(blocks[0]!.is_error).toBe(true);
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('finalizeToolResult 可改写工具结果', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'list_dir', {})] },
      { textChunks: ['done'], finalContent: [textBlock('done')] },
    ]);
    const messages: StoredMessage[] = [sm('ls')];
    const hooks: LoopHooks = {
      finalizeToolResult: (_req, _result) => ({ content: '[已脱敏]', isError: false }),
    };
    const events = await collect(runAgent(base(provider, messages, hooks)));
    const toolEnd = events.find((e) => e.type === 'tool_end') as { result: string } | undefined;
    expect(toolEnd?.result).toBe('[已脱敏]');
  });

  it('shouldContinueAfterStop 返回续接描述时产出 continuation 事件并结束本 run', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: ['第一段'], finalContent: [textBlock('第一段')] },
    ]);
    const messages: StoredMessage[] = [sm('go')];
    const hooks: LoopHooks = {
      shouldContinueAfterStop: () => ({ inject: '下一轮继续' }),
    };
    const events = await collect(runAgent(base(provider, messages, hooks)));
    // 续接不在本 run 内发生：产出 continuation 事件回 App 层，由 App 驱动下一轮
    expect(streamCalls()).toBe(1);
    const cont = events.find((e) => e.type === 'continuation') as
      | { type: 'continuation'; inject: string }
      | undefined;
    expect(cont?.inject).toBe('下一轮继续');
    expect(events.at(-1)!.type).toBe('turn_done');
  });
});
