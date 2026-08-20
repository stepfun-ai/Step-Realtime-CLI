import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/loop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { SessionStore } from '../../src/session/store.js';
import { collect, makeFakeProvider, textBlock } from '../helpers/fakeProvider.js';

/**
 * 跨天提醒在 **resume 路径**上的端到端保护。
 *
 * loopDateChange.test.ts 覆盖的是 runAgent 层的接线，但它直接构造内存里的 StoredMessage，
 * 绕过了持久化。而 resume 恰恰是跨天最典型的场景——昨天的会话今天接着聊。这条链路多了
 * 两个环节：消息落盘、加载回来。只要其中任何一步把 ts 重写成「写入时刻」或「加载时刻」，
 * 跨天判定就会永远失效（baseline 恒为今天），而单测与接线测试都发现不了。
 *
 * 本文件锁两件事：save → load 之后 ts 保真；用加载回来的历史跑 runAgent 仍会注入提醒。
 *
 * 时间一律用「N 小时前」构造，不依赖现实时间流逝：往前推 26 小时必然落在不同的本地
 * 日期上（一天只有 24 小时），所以无论几点跑都成立，不需要等到明天才能验证。
 */

let base: string;
let store: SessionStore;
const cwd = 'C:/some/project';

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stepcode-datechange-'));
  store = new SessionStore(base);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** 26 小时前：必然落在不同的本地日期，且与运行时刻无关。 */
function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600 * 1000).toISOString();
}

/** 把一条消息的 ts 改写为指定值（stored() 内部固定取当前时刻）。 */
function withTs(m: StoredMessage, ts: string): StoredMessage {
  return { ...m, ts };
}

function dateChangeInjections(messages: StoredMessage[]): StoredMessage[] {
  return messages.filter(
    (m) =>
      m.message.role === 'user' &&
      m.origin.kind === 'injection' &&
      typeof m.message.content === 'string' &&
      m.message.content.includes('日期已变更'),
  );
}

describe('跨天提醒：resume 路径', () => {
  it('save → load 之后消息 ts 保真（不被写入或加载时刻覆盖）', () => {
    const yesterday = hoursAgo(26);
    const s = store.create(cwd, 'step-3.7-flash');
    s.messages.push(withTs(stored({ role: 'user', content: '昨天问的' }, { kind: 'user' }), yesterday));
    store.save(s);

    const loaded = store.load(cwd, s.id);
    expect(loaded).not.toBeNull();
    // 保真是跨天判定的前提：baseline 取「最后一条消息的本地日期」，ts 一旦被重写成
    // 写入/加载时刻，resume 后 baseline 恒为今天，跨天永远检测不到。
    expect(loaded!.messages[0]!.ts).toBe(yesterday);
  });

  it('用加载回来的昨日历史跑 runAgent：仍会注入跨天提醒', async () => {
    const yesterday = hoursAgo(26);
    const s = store.create(cwd, 'step-3.7-flash');
    s.messages.push(withTs(stored({ role: 'user', content: '昨天问的' }, { kind: 'user' }), yesterday));
    store.save(s);

    const loaded = store.load(cwd, s.id);
    const messages = loaded!.messages;
    const { provider } = makeFakeProvider([
      { textChunks: ['好'], finalContent: [textBlock('好')], stopReason: 'end_turn' },
    ]);
    await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd(), signal: undefined },
        messages,
        maxIterations: 4,
      }),
    );

    const injected = dateChangeInjections(messages);
    expect(injected).toHaveLength(1);
    expect(injected[0]!.message.content as string).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('同一天内保存又恢复：不注入（避免 resume 本身被误判为跨天）', async () => {
    const s = store.create(cwd, 'step-3.7-flash');
    // 用 stored() 的默认 ts，即「刚才」——同一本地日期
    s.messages.push(stored({ role: 'user', content: '刚才问的' }, { kind: 'user' }));
    store.save(s);

    const loaded = store.load(cwd, s.id);
    const messages = loaded!.messages;
    const { provider } = makeFakeProvider([
      { textChunks: ['好'], finalContent: [textBlock('好')], stopReason: 'end_turn' },
    ]);
    await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd(), signal: undefined },
        messages,
        maxIterations: 4,
      }),
    );

    expect(dateChangeInjections(messages)).toHaveLength(0);
  });
});
