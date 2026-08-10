import type Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/loop.js';
import type { LoopHooks } from '../../src/agent/hooks.js';
import { composeLoopHooks, HookEngine } from '../../src/agent/hooks/engine.js';
import type { HookConfigEntry } from '../../src/config/config.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';

/** 接入点测试：真实 HookEngine + node 小脚本 hook（避免 bash 依赖），跑 runAgent 验证四个接入点语义。 */
let dir = '';

function writeScript(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body, 'utf8');
  return p;
}

function cmd(script: string, ...args: string[]): string {
  return [`"${process.execPath}"`, `"${script}"`, ...args.map((a) => `"${a}"`)].join(' ');
}

function makeEngine(entries: HookConfigEntry[]): HookEngine {
  return new HookEngine(entries, { sessionId: 'sess-1', cwd: dir });
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stepcode-hook-compose-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const base = (
  provider: ReturnType<typeof makeFakeProvider>['provider'],
  messages: StoredMessage[],
  hooks: LoopHooks,
) => ({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages, hooks });

describe('composeLoopHooks 接入点', () => {
  it('PreToolUse exit 2 → deny，reason 作为 tool_result 回灌模型，工具不执行', async () => {
    const script = writeScript('block.js', `process.stderr.write('hook 拒绝执行'); process.exit(2);`);
    const engine = makeEngine([{ event: 'PreToolUse', command: cmd(script), timeout: 30 }]);
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'write_file', { path: 'x', content: 'y' })] },
      { textChunks: ['明白，我不写了'], finalContent: [textBlock('明白，我不写了')] },
    ]);
    const messages: StoredMessage[] = [stored({ role: 'user', content: '写文件' }, { kind: 'user' })];
    const hooks = composeLoopHooks(engine, {});
    const events = await collect(runAgent(base(provider, messages, hooks)));

    const toolEnd = events.find((e) => e.type === 'tool_end') as
      | { type: 'tool_end'; isError: boolean; result: string }
      | undefined;
    expect(toolEnd?.isError).toBe(true);
    expect(toolEnd?.result).toContain('hook 拒绝执行');
    const blocks = messages[2]!.message.content as Anthropic.ToolResultBlockParam[];
    expect(blocks[0]!.is_error).toBe(true);
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('PreToolUse exit 0 → 落回既有权限审批（hook 只能否决不能批准）', async () => {
    const script = writeScript('ok.js', `process.exit(0);`);
    const engine = makeEngine([{ event: 'PreToolUse', command: cmd(script), timeout: 30 }]);

    // base 审批拒绝：hook 放行但审批拒绝 → 仍 deny，reason 是审批的
    const denyBase: LoopHooks = {
      authorizeToolCall: () => ({ decision: 'deny', reason: '审批未通过' }),
    };
    const denied = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'write_file', { path: 'x', content: 'y' })] },
      { textChunks: ['好'], finalContent: [textBlock('好')] },
    ]);
    const messages1: StoredMessage[] = [stored({ role: 'user', content: '写' }, { kind: 'user' })];
    const events1 = await collect(
      runAgent(base(denied.provider, messages1, composeLoopHooks(engine, denyBase))),
    );
    const toolEnd1 = events1.find((e) => e.type === 'tool_end') as { isError: boolean; result: string } | undefined;
    expect(toolEnd1?.isError).toBe(true);
    expect(toolEnd1?.result).toContain('审批未通过');

    // base 审批放行：hook 放行 + 审批放行 → 工具真实执行
    const allowed = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'list_dir', {})] },
      { textChunks: ['列完了'], finalContent: [textBlock('列完了')] },
    ]);
    const messages2: StoredMessage[] = [stored({ role: 'user', content: 'ls' }, { kind: 'user' })];
    const events2 = await collect(
      runAgent(base(allowed.provider, messages2, composeLoopHooks(engine, {}))),
    );
    const toolEnd2 = events2.find((e) => e.type === 'tool_end') as { isError: boolean } | undefined;
    expect(toolEnd2?.isError).toBe(false);
  });

  it('PostToolUse fire-and-forget：hook 真实执行但不改写工具结果', async () => {
    const marker = join(dir, 'post-ran.txt');
    // hook 即使 exit 2 也不影响结果（观察语义）
    const script = writeScript(
      'post.js',
      `require('node:fs').writeFileSync(process.argv[2], 'ran'); process.exit(2);`,
    );
    const engine = makeEngine([{ event: 'PostToolUse', command: cmd(script, marker), timeout: 30 }]);
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'list_dir', {})] },
      { textChunks: ['done'], finalContent: [textBlock('done')] },
    ]);
    const messages: StoredMessage[] = [stored({ role: 'user', content: 'ls' }, { kind: 'user' })];
    const events = await collect(
      runAgent(base(provider, messages, composeLoopHooks(engine, {}))),
    );
    const toolEnd = events.find((e) => e.type === 'tool_end') as
      | { isError: boolean; result: string }
      | undefined;
    expect(toolEnd?.isError).toBe(false);
    expect(toolEnd?.result).not.toBe('');
    // fire-and-forget：等 hook 进程异步落盘
    await waitFor(() => existsSync(marker));
  });

  it('Stop exit 2 → 返回续接描述（inject 为 reason），统一走 continuation 事件', async () => {
    const script = writeScript('stop.js', `process.stderr.write('还没做完，继续'); process.exit(2);`);
    const engine = makeEngine([{ event: 'Stop', command: cmd(script), timeout: 30 }]);
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: ['第一段'], finalContent: [textBlock('第一段')] },
    ]);
    const messages: StoredMessage[] = [stored({ role: 'user', content: 'go' }, { kind: 'user' })];
    const hooks = composeLoopHooks(engine, {});
    const events = await collect(runAgent(base(provider, messages, hooks)));

    // end_turn：Stop hook 阻断 → 产出 continuation（inject = reason）+ turn_done，本 run 结束；
    // 引擎不再直写 history（消除双写，注入由 App/headless 层消费 continuation 后完成）
    expect(streamCalls()).toBe(1);
    const cont = events.find((e) => e.type === 'continuation') as
      | { type: 'continuation'; inject: string }
      | undefined;
    expect(cont?.inject).toBe('还没做完，继续');
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('Stop 一次性语义：同轮只续一次，resetStopContinuation 后恢复续行机会', async () => {
    const script = writeScript('stop2.js', `process.stderr.write('继续'); process.exit(2);`);
    const engine = makeEngine([{ event: 'Stop', command: cmd(script), timeout: 30 }]);
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: ['一'], finalContent: [textBlock('一')] },
      { textChunks: ['二'], finalContent: [textBlock('二')] },
      { textChunks: ['三'], finalContent: [textBlock('三')] },
    ]);
    const messages: StoredMessage[] = [stored({ role: 'user', content: 'go' }, { kind: 'user' })];
    const hooks = composeLoopHooks(engine, {});
    // 第一轮：Stop 阻断 → continuation
    const ev1 = await collect(runAgent(base(provider, messages, hooks)));
    expect(ev1.some((e) => e.type === 'continuation')).toBe(true);
    expect(streamCalls()).toBe(1);
    // 第二轮（未复位）：一次性标志已用 → 落回 base（无 goal）→ 结束，无 continuation
    const ev2 = await collect(runAgent(base(provider, messages, hooks)));
    expect(ev2.some((e) => e.type === 'continuation')).toBe(false);
    expect(streamCalls()).toBe(2);
    // 复位（模拟新一轮提交）：Stop hook 重新获得一次续行机会
    hooks.resetStopContinuation();
    const ev3 = await collect(runAgent(base(provider, messages, hooks)));
    expect(ev3.some((e) => e.type === 'continuation')).toBe(true);
    expect(streamCalls()).toBe(3);
  });

  it('Stop hook 不覆盖 base 的停止/阻塞裁决：base 返回 null 时直接结束', async () => {
    const script = writeScript('stop-blocked.js', `process.stderr.write('继续'); process.exit(2);`);
    const engine = makeEngine([{ event: 'Stop', command: cmd(script), timeout: 30 }]);
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: ['一'], finalContent: [textBlock('一')] },
    ]);
    const messages: StoredMessage[] = [stored({ role: 'user', content: 'go' }, { kind: 'user' })];
    const blockedBase: LoopHooks = {
      shouldContinueAfterStop: () => null,
    };
    const hooks = composeLoopHooks(engine, blockedBase);
    const events = await collect(runAgent(base(provider, messages, hooks)));

    // base 已裁决结束，Stop hook 不应再触发并返回续接
    expect(events.some((e) => e.type === 'continuation')).toBe(false);
    expect(streamCalls()).toBe(1);
  });

  it('Stop hook 续接受 base 预算约束：每轮都经 base 计轮/判预算，耗尽后不再续行', async () => {
    const script = writeScript('stop-budget.js', `process.stderr.write('继续'); process.exit(2);`);
    const engine = makeEngine([{ event: 'Stop', command: cmd(script), timeout: 30 }]);
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: ['一'], finalContent: [textBlock('一')] },
      { textChunks: ['二'], finalContent: [textBlock('二')] },
      { textChunks: ['三'], finalContent: [textBlock('三')] },
      { textChunks: ['四'], finalContent: [textBlock('四')] },
    ]);
    const messages: StoredMessage[] = [stored({ role: 'user', content: 'go' }, { kind: 'user' })];

    // base 模拟 goal 轮次预算：最多允许 2 次续接
    let turns = 0;
    const budgetBase: LoopHooks = {
      shouldContinueAfterStop: () => {
        if (turns >= 2) return null;
        turns += 1;
        return { inject: 'goal continuation' };
      },
    };
    const hooks = composeLoopHooks(engine, budgetBase);

    // 第 1 轮：Stop hook 触发，但 base 已计数
    const ev1 = await collect(runAgent(base(provider, messages, hooks)));
    expect(ev1.some((e) => e.type === 'continuation')).toBe(true);
    expect(streamCalls()).toBe(1);
    expect(turns).toBe(1);

    // 复位后第 2 轮：仍可续
    hooks.resetStopContinuation();
    const ev2 = await collect(runAgent(base(provider, messages, hooks)));
    expect(ev2.some((e) => e.type === 'continuation')).toBe(true);
    expect(streamCalls()).toBe(2);
    expect(turns).toBe(2);

    // 复位后第 3 轮：base 预算耗尽，Stop hook 不应再触发，无 continuation
    hooks.resetStopContinuation();
    const ev3 = await collect(runAgent(base(provider, messages, hooks)));
    expect(ev3.some((e) => e.type === 'continuation')).toBe(false);
    expect(streamCalls()).toBe(3);
    expect(turns).toBe(2);
  });
});
