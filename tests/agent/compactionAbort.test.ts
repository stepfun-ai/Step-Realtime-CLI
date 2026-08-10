import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { fullCompact } from '../../src/agent/compaction/compact.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import type { ChatProvider } from '../../src/provider/types.js';

/**
 * 压缩可中断。
 *
 * 压缩要等一次完整的摘要请求，历史越长越久（实测长会话可达数十秒），此前这段时间里
 * Esc 完全无效——手动 /compact 甚至没挂 abortRef，按了等于没按。
 *
 * 中断的状态安全性建立在一个既有事实上：fullCompact 对入参 messages **只读**，
 * 新序列先在局部算完，由调用方 replaceMessages 一次性生效。所以中断只要发生在返回前，
 * 历史必然停在压缩前的完整状态，不存在「压缩到一半」的中间态。本组测试就是钉死这个契约。
 */

/** 造一段够长的历史，保证过得了 fullCompact 的「太短不值得压」与安全切点检查。 */
function makeHistory(n = 20): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push(stored({ role: 'user', content: `用户第 ${i} 条消息，内容足够长以便产生压缩价值。`.repeat(20) }, { kind: 'user' }));
    out.push(stored({ role: 'assistant', content: `助手第 ${i} 条回复，同样有一定长度。`.repeat(20) }, { kind: 'assistant' }));
  }
  return out;
}

/**
 * provider 桩：摘要请求「挂起」直到 signal abort 才 reject，模拟真实的长耗时请求。
 * 记录每次调用拿到的 signal，用于断言 signal 确实被透传下去。
 */
function makeHangingProvider(): {
  provider: ChatProvider;
  calls: () => number;
  signals: () => (AbortSignal | undefined)[];
} {
  let calls = 0;
  const signals: (AbortSignal | undefined)[] = [];
  const provider = {
    stream(p: { signal?: AbortSignal }) {
      calls++;
      signals.push(p.signal);
      return {
        finalMessage: () =>
          new Promise<Anthropic.Message>((_resolve, reject) => {
            const s = p.signal;
            if (s === undefined) return; // 永不结束：signal 没传下来时测试会超时，正是我们要暴露的问题
            if (s.aborted) {
              reject(new Anthropic.APIUserAbortError());
              return;
            }
            s.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()), { once: true });
          }),
      };
    },
  } as unknown as ChatProvider;
  return { provider, calls: () => calls, signals: () => signals };
}

describe('fullCompact 中断', () => {
  it('signal 被透传到 provider.stream', async () => {
    const { provider, signals } = makeHangingProvider();
    const ctrl = new AbortController();
    const history = makeHistory();

    const p = fullCompact(provider, history, 6, undefined, undefined, undefined, ctrl.signal);
    ctrl.abort();
    await p;

    expect(signals()).toHaveLength(1);
    expect(signals()[0]).toBe(ctrl.signal);
  });

  it('请求进行中中断：原样返回同一引用，历史零改动', async () => {
    const { provider } = makeHangingProvider();
    const ctrl = new AbortController();
    const history = makeHistory();
    const snapshot = [...history];
    const lenBefore = history.length;

    const p = fullCompact(provider, history, 6, undefined, undefined, undefined, ctrl.signal);
    ctrl.abort(); // 模拟用户按 Esc
    const result = await p;

    // 返回同引用 = 调用方的 `compacted !== messages` 判定不成立 = 不替换历史
    expect(result).toBe(history);
    expect(history).toHaveLength(lenBefore);
    expect(history).toEqual(snapshot);
  });

  it('中断不触发重试：只发一次请求就收手', async () => {
    const { provider, calls } = makeHangingProvider();
    const ctrl = new AbortController();

    const p = fullCompact(provider, makeHistory(), 6, undefined, undefined, undefined, ctrl.signal);
    ctrl.abort();
    await p;

    // 压缩失败本有 3 次重试降级（剥媒体 / 收缩历史 / drop 最老）。
    // 中断若被当成普通失败，用户按一次 Esc 还要再等两轮请求。
    expect(calls()).toBe(1);
  });

  it('进门前已中断：一次请求都不发', async () => {
    const { provider, calls } = makeHangingProvider();
    const ctrl = new AbortController();
    ctrl.abort();
    const history = makeHistory();

    const result = await fullCompact(provider, history, 6, undefined, undefined, undefined, ctrl.signal);

    expect(calls()).toBe(0);
    expect(result).toBe(history);
  });

  it('不传 signal 时行为不变（向后兼容）', async () => {
    // 正常返回摘要的 provider
    const provider = {
      stream: () => ({
        finalMessage: async () =>
          ({
            content: [{ type: 'text', text: '这是一段足够长的摘要正文，用于通过质量闸门校验。'.repeat(10) }],
          }) as unknown as Anthropic.Message,
      }),
    } as unknown as ChatProvider;

    const history = makeHistory();
    const result = await fullCompact(provider, history, 6);

    expect(result).not.toBe(history); // 正常压缩，返回新数组
    expect(result.some((m) => m.origin.kind === 'compaction_summary')).toBe(true);
  });

  it('真实故障仍走重试降级，不被中断判定吞掉', async () => {
    let calls = 0;
    const provider = {
      stream: () => {
        calls++;
        return {
          finalMessage: async () => {
            if (calls < 2) throw new Error('provider 临时故障');
            return {
              content: [{ type: 'text', text: '重试后拿到的摘要正文，长度足够通过闸门校验。'.repeat(10) }],
            } as unknown as Anthropic.Message;
          },
        };
      },
    } as unknown as ChatProvider;

    const ctrl = new AbortController(); // 传了 signal 但从不 abort
    const result = await fullCompact(provider, makeHistory(), 6, undefined, undefined, undefined, ctrl.signal);

    expect(calls).toBe(2); // 第一次失败、第二次成功——降级路径没被中断逻辑截断
    expect(result.some((m) => m.origin.kind === 'compaction_summary')).toBe(true);
  });
});

describe('isAbortError', () => {
  it('识别 SDK 中断、DOM AbortError 与内部「已取消」', async () => {
    const { isAbortError } = await import('../../src/provider/retry.js');
    const domAbort = new Error('aborted');
    domAbort.name = 'AbortError';

    expect(isAbortError(new Anthropic.APIUserAbortError())).toBe(true);
    expect(isAbortError(domAbort)).toBe(true);
    expect(isAbortError(new Error('已取消'))).toBe(true);
    // 真实故障不能被误判成中断，否则会静默跳过重试
    expect(isAbortError(new Error('socket hang up'))).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});
