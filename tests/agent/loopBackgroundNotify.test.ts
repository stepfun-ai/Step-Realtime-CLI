import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/loop.js';
import { BackgroundManager } from '../../src/agent/background/manager.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';

/** 两回合脚本：第 1 回合工具调用（busy 中），第 2 回合纯文本收尾。 */
function twoTurnProvider() {
  return makeFakeProvider([
    { textChunks: [], finalContent: [toolUseBlock('c1', 'nonexistent_tool', {})] },
    { textChunks: ['完成'], finalContent: [textBlock('完成')] },
  ]);
}

function runOpts(
  provider: ReturnType<typeof makeFakeProvider>['provider'],
  messages: StoredMessage[],
  background: BackgroundManager,
  inject: boolean,
  onWireEvent?: (event: import('../../src/agent/wirelog.js').WireEvent) => void,
) {
  return {
    provider,
    system: 'sys',
    ctx: { cwd: process.cwd(), background },
    messages,
    injectBackgroundNotifications: inject,
    onWireEvent,
  };
}

/** 取第 n 次 stream 调用的 messages 快照文本（wire 格式，user 文本块拼接）。 */
function callMessagesText(params: Record<string, unknown>[], n: number): string {
  const msgs = params[n]!['messages'] as { role: string; content: unknown }[];
  return msgs
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

describe('runAgent 后台通知 step 边界注入', () => {
  it('busy 中终态：通知在下一回合前注入（第 2 次模型调用已可见），不等循环结束', async () => {
    const { provider, streamParams } = twoTurnProvider();
    const background = new BackgroundManager(10);
    // 任务随循环启动即 resolve：微任务在第 1 回合流式期间完成 → 第 1 回合结束后处于待投递队列
    background.startTask('npm test', Promise.resolve({ output: 'all passed', ok: true }));
    const messages: StoredMessage[] = [stored({ role: 'user', content: 'go' }, { kind: 'user' })];
    const wireEvents: import('../../src/agent/wirelog.js').WireEvent[] = [];

    const events = await collect(
      runAgent(runOpts(provider, messages, background, true, (e) => wireEvents.push(e))),
    );

    // 第 1 次调用（回合 1）尚无通知；第 2 次调用（回合 2）已带通知 → 注入早于循环结束
    expect(callMessagesText(streamParams(), 0)).not.toContain('source_kind');
    expect(callMessagesText(streamParams(), 1)).toContain('<notification');
    expect(callMessagesText(streamParams(), 1)).toContain('npm test');
    expect(events.at(-1)!.type).toBe('turn_done');
    // 通知作为独立条目进入会话历史：结构化 origin（background_task + 幂等 id），中途注入不开新轮
    const note = messages.find((m) => typeof m.message.content === 'string' && m.message.content.includes('<notification'));
    expect(note).toBeDefined();
    expect(note!.origin.kind).toBe('background_task');
    expect(note!.origin.taskId).toBeDefined();
    expect(note!.origin.notificationId).toMatch(/^task:.+:(completed|failed|killed)$/);
    expect(note!.origin.startsPromptTurn).toBe(false);
    // 送达事件不再由 loop 在注入时落盘（待办 #17：事件先写而消息本体回合末 persist 才落盘，
    // 中间崩溃会让对账误判已送达）——统一由 persist 与消息本体同刻补写（pendingDeliveredEvents）。
    // 此层只保证消息带结构化 origin 进历史，补写可寻址。
    const delivered = wireEvents.filter((e) => e.type === 'background.notify_delivered');
    expect(delivered).toHaveLength(0);
    // 已 drain，不留残余
    expect(background.drainSettled()).toEqual([]);
  });

  it('多条同时终态：同批注入、各自独立条目（不合成单条大消息）', async () => {
    const { provider, streamParams } = twoTurnProvider();
    const background = new BackgroundManager(10);
    background.startTask('任务甲', Promise.resolve({ output: 'A', ok: true }));
    background.startTask('任务乙', Promise.resolve({ output: 'B', ok: false }));
    const messages: StoredMessage[] = [stored({ role: 'user', content: 'go' }, { kind: 'user' })];

    await collect(runAgent(runOpts(provider, messages, background, true)));

    const second = callMessagesText(streamParams(), 1);
    expect(second).toContain('任务甲');
    expect(second).toContain('任务乙');
    const notes = messages.filter(
      (m) => typeof m.message.content === 'string' && m.message.content.includes('<notification'),
    );
    expect(notes).toHaveLength(2); // 各自独立条目
  });

  it('未开启开关（如 -p 模式）：不在循环内注入，通知留在管理器待投递队列', async () => {
    const { provider, streamParams } = twoTurnProvider();
    const background = new BackgroundManager(10);
    background.startTask('npm test', Promise.resolve({ output: 'all passed', ok: true }));
    const messages: StoredMessage[] = [stored({ role: 'user', content: 'go' }, { kind: 'user' })];

    await collect(runAgent(runOpts(provider, messages, background, false)));

    expect(callMessagesText(streamParams(), 1)).not.toContain('<notification');
    expect(background.drainSettled()).toHaveLength(1); // 留给 -p 退出时 drain 到 stderr
  });

  it('被 task_stop 抑制（suppress）的任务不注入', async () => {
    const { provider, streamParams } = twoTurnProvider();
    const background = new BackgroundManager(10);
    const id = background.startTask('长任务', new Promise(() => {}));
    background.suppressNotification(id);
    background.stop(id); // 同步置 killed，settle 时被抑制跳过
    const messages: StoredMessage[] = [stored({ role: 'user', content: 'go' }, { kind: 'user' })];

    await collect(runAgent(runOpts(provider, messages, background, true)));

    expect(callMessagesText(streamParams(), 1)).not.toContain('<notification');
    expect(background.drainSettled()).toEqual([]);
  });
});
