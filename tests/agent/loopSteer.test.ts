/**
 * runAgent 的 steerQueue（Ctrl+S 主动插队）step 边界注入测试。
 *
 * 守的是 loop 侧契约：UI 塞进来的插话在下一个 step 边界（模型调用前）注入为
 * kind: 'user' 的消息、数组就地清空、并产出一条 notice 事件。写坏了表现为
 * 用户按了 Ctrl+S 插话却到不了模型，或注入身份不对（回放/压缩口径跟着错）。
 */
import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/loop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';

function callMessagesText(params: Record<string, unknown>[], n: number): string {
  const msgs = params[n]!['messages'] as { role: string; content: unknown }[];
  return msgs
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

describe('runAgent steerQueue 注入', () => {
  it('step 边界取走插话：注入为 user 消息、数组清空、产出 notice', async () => {
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const messages: StoredMessage[] = [stored({ role: 'user', content: 'go' }, { kind: 'user' })];
    const steerQueue = ['先跑测试再改'];

    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd() },
        messages,
        steerQueue,
      }),
    );

    // 第 1 次模型调用就已携带插话（注入发生在 step 边界，不等回合结束）
    expect(callMessagesText(streamParams(), 0)).toContain('先跑测试再改');
    // 注入即视为用户消息：回放/压缩口径与正常输入一致
    const injected = messages.find(
      (m) => typeof m.message.content === 'string' && m.message.content.includes('先跑测试再改'),
    );
    expect(injected).toBeDefined();
    expect(injected!.message.role).toBe('user');
    expect(injected!.origin.kind).toBe('user');
    // 数组就地清空（UI 侧据此知道这批已注入）
    expect(steerQueue).toEqual([]);
    // 有一条 notice 告知 UI 注入成功
    expect(events.some((e) => e.type === 'notice')).toBe(true);
  });

  it('空数组/未传 steerQueue：不改旧路径', async () => {
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const messages: StoredMessage[] = [stored({ role: 'user', content: 'go' }, { kind: 'user' })];
    const steerQueue: string[] = [];

    await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages, steerQueue }),
    );

    expect(callMessagesText(streamParams(), 0)).not.toContain('插话');
    expect(messages).toHaveLength(2); // user + assistant，无注入条目
  });

  it('两回合之间塞入：第二次模型调用可见（busy 中插话的真实时序）', async () => {
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'nonexistent_tool', {})] },
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const messages: StoredMessage[] = [stored({ role: 'user', content: 'go' }, { kind: 'user' })];
    const steerQueue: string[] = [];

    // 驱动到第一次模型调用真的发出（provider 收到第 1 份参数）后再塞入，
    // 等价于「回合 1 流式进行中用户按 Ctrl+S」
    const it = runAgent({
      provider,
      system: 'sys',
      ctx: { cwd: process.cwd() },
      messages,
      steerQueue,
    });
    while (streamParams().length === 0) {
      const step = await it.next();
      if (step.done) throw new Error('循环在第一次模型调用前就结束了');
    }
    steerQueue.push('中途补一句');
    // 耗尽剩余事件
    while (!(await it.next()).done) {
      /* drain */
    }

    // 第 1 次调用（塞入前）没有，第 2 次调用（塞入后的 step 边界）有
    expect(callMessagesText(streamParams(), 0)).not.toContain('中途补一句');
    expect(callMessagesText(streamParams(), 1)).toContain('中途补一句');
    expect(steerQueue).toEqual([]);
  });
});
