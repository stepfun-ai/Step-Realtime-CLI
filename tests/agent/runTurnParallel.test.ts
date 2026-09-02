import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/agent/events.js';
import type { LoopHooks } from '../../src/agent/hooks.js';
import { runAgent } from '../../src/agent/loop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import type { ToolContext } from '../../src/tools/types.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';

const LONG = 'x'.repeat(220); // >200，跳过子 agent 摘要补写

function sm(text: string): StoredMessage {
  return stored({ role: 'user', content: text }, { kind: 'user' });
}

const base = (
  provider: ReturnType<typeof makeFakeProvider>['provider'],
  messages: StoredMessage[],
  over: { ctx?: ToolContext; hooks?: LoopHooks; signal?: AbortSignal } = {},
) => ({
  provider,
  system: 'sys',
  ctx: over.ctx ?? { cwd: process.cwd() },
  messages,
  hooks: over.hooks,
  signal: over.signal,
});

/** 取回合里追加的那条 tool_result 消息的块数组。 */
function toolResultBlocks(messages: StoredMessage[]): Anthropic.ToolResultBlockParam[] {
  const m = messages.find(
    (mm) => mm.message.role === 'user' && Array.isArray(mm.message.content),
  );
  return m!.message.content as Anthropic.ToolResultBlockParam[];
}

/** 把事件流压成「start:id / end:id」序列，便于断言顺序。 */
function toolTrace(events: AgentEvent[]): string[] {
  return events
    .filter((e) => e.type === 'tool_start' || e.type === 'tool_end')
    .map((e) => `${e.type === 'tool_start' ? 'start' : 'end'}:${(e as { id: string }).id}`);
}

describe('runTurn 并行工具执行', () => {
  it('不冲突的多个 tool_use 并行：tool_start 一起发出，tool_result 顺序对齐 tool_use 顺序', async () => {
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'read_file', { path: 'package.json', limit: 1 }),
          toolUseBlock('c2', 'read_file', { path: 'tsconfig.json', limit: 1 }),
        ],
      },
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const messages: StoredMessage[] = [sm('读两个文件')];
    const events = await collect(runAgent(base(provider, messages)));

    // 两个 tool_start 都排在任何 tool_end 之前（并行启动的证据）
    expect(toolTrace(events)).toEqual(['start:c1', 'start:c2', 'end:c1', 'end:c2']);
    const blocks = toolResultBlocks(messages);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['c1', 'c2']);
    expect(blocks.every((b) => b.is_error !== true)).toBe(true);
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('全部冲突时串行：事件序列与旧实现一致（start→end 逐个交替）', async () => {
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'nonexistent_a', {}), // 未知工具 → access all → 互相冲突
          toolUseBlock('c2', 'nonexistent_b', {}),
        ],
      },
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent(base(provider, messages)));

    expect(toolTrace(events)).toEqual(['start:c1', 'end:c1', 'start:c2', 'end:c2']);
    const blocks = toolResultBlocks(messages);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['c1', 'c2']);
    expect(blocks.every((b) => b.is_error === true)).toBe(true);
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('写读同路径冲突 → 串行；不同路径的读不被拖住', async () => {
    const tmp = join(tmpdir(), 'step-code-parallel-test.txt');
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'write_file', { path: tmp, content: 'hello' }),
          toolUseBlock('c2', 'read_file', { path: tmp }), // 与 c1 冲突，等放行
          toolUseBlock('c3', 'read_file', { path: 'package.json', limit: 1 }), // 与谁都不同路径，但排在冲突任务后
        ],
      },
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent(base(provider, messages)));

    // c1 先跑完；c2 读到的是 c1 写入的内容；整体结果仍按 c1/c2/c3 顺序
    const blocks = toolResultBlocks(messages);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['c1', 'c2', 'c3']);
    expect(String(blocks[1]!.content)).toContain('hello');
    expect(blocks.every((b) => b.is_error !== true)).toBe(true);
    // c1 的 end 必在 c2 的 start 之前（冲突串行的直接证据）
    const trace = toolTrace(events);
    expect(trace.indexOf('end:c1')).toBeLessThan(trace.indexOf('start:c2'));
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('后完成的任务不抢先：tool_end 与 tool_result 都按 tool_use 顺序', async () => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => {
      releaseSlow = r;
    });
    const ctx: ToolContext = {
      cwd: process.cwd(),
      depth: 0,
      runSubagent: async (req) => {
        if (req.prompt === 'slow') await slowGate; // c1 慢，c2 快
        return { summary: `done:${req.prompt}${LONG}`, isError: false };
      },
    };
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'spawn_agent', { prompt: 'slow', subagent_type: 'explore' }),
          toolUseBlock('c2', 'spawn_agent', { prompt: 'fast', subagent_type: 'explore' }),
        ],
      },
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const messages: StoredMessage[] = [sm('go')];
    const gen = runAgent(base(provider, messages, { ctx }));
    const collecting = collect(gen);
    // 等 c2 先跑完，再放行 c1：制造乱序完成
    setTimeout(() => releaseSlow(), 50);
    const events = await collecting;

    expect(toolTrace(events)).toEqual(['start:c1', 'start:c2', 'end:c1', 'end:c2']);
    const blocks = toolResultBlocks(messages);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['c1', 'c2']);
    expect(String(blocks[0]!.content)).toContain('done:slow');
    expect(String(blocks[1]!.content)).toContain('done:fast');
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('授权拒绝占槽：被拒任务不执行，结果按位回灌，兄弟任务不受影响', async () => {
    const hooks: LoopHooks = {
      authorizeToolCall: (req) =>
        req.id === 'c2' ? { decision: 'deny', reason: '用户未批准' } : { decision: 'allow' },
    };
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'read_file', { path: 'package.json', limit: 1 }),
          toolUseBlock('c2', 'write_file', { path: 'should-not-exist.txt', content: 'x' }),
        ],
      },
      { textChunks: ['好的'], finalContent: [textBlock('好的')] },
    ]);
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent(base(provider, messages, { hooks })));

    const blocks = toolResultBlocks(messages);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['c1', 'c2']);
    expect(blocks[0]!.is_error).not.toBe(true);
    expect(blocks[1]!.is_error).toBe(true);
    expect(String(blocks[1]!.content)).toContain('用户未批准');
    const ends = events.filter((e) => e.type === 'tool_end') as { id: string; isError: boolean }[];
    expect(ends.find((e) => e.id === 'c2')?.isError).toBe(true);
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('授权拒绝可带 errorCode：plan mode 下返回 PLAN_MODE_BLOCKED', async () => {
    const hooks: LoopHooks = {
      authorizeToolCall: (req) =>
        req.name === 'write_file'
          ? { decision: 'deny', reason: 'plan mode blocked', errorCode: 'PLAN_MODE_BLOCKED' }
          : { decision: 'allow' },
    };
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'write_file', { path: 'should-not-exist.txt', content: 'x' }),
        ],
      },
      { textChunks: ['好的'], finalContent: [textBlock('好的')] },
    ]);
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent(base(provider, messages, { hooks })));

    const blocks = toolResultBlocks(messages);
    expect(blocks[0]!.is_error).toBe(true);
    expect(String(blocks[0]!.content)).toContain('plan mode blocked');
    const ends = events.filter((e) => e.type === 'tool_end') as { id: string; isError: boolean; errorCode?: string }[];
    const end = ends.find((e) => e.id === 'c1');
    expect(end?.isError).toBe(true);
    expect(end?.errorCode).toBe('PLAN_MODE_BLOCKED');
  });

  it('异常隔离：单个工具的结果后处理抛异常 → 该槽转 is_error，兄弟任务照常', async () => {
    const hooks: LoopHooks = {
      finalizeToolResult: (req, result) => {
        if (req.id === 'c1') throw new Error('finalize-boom');
        return result;
      },
    };
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'read_file', { path: 'package.json', limit: 1 }),
          toolUseBlock('c2', 'read_file', { path: 'tsconfig.json', limit: 1 }),
        ],
      },
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent(base(provider, messages, { hooks })));

    const blocks = toolResultBlocks(messages);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['c1', 'c2']);
    expect(blocks[0]!.is_error).toBe(true);
    expect(String(blocks[0]!.content)).toContain('finalize-boom');
    expect(blocks[1]!.is_error).not.toBe(true);
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('中断：已启动的收敛回真实结果，未启动的合成中断结果占槽（不发事件），回合标 aborted', async () => {
    const ac = new AbortController();
    const ctx: ToolContext = {
      cwd: process.cwd(),
      depth: 0,
      signal: ac.signal,
      runSubagent: async (req) => {
        ac.abort(); // c1 执行中中断
        return { summary: `done:${req.prompt}${LONG}`, isError: false };
      },
    };
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'spawn_agent', { prompt: 'p1', subagent_type: 'general' }), // all → 串行
          toolUseBlock('c2', 'spawn_agent', { prompt: 'p2', subagent_type: 'general' }),
        ],
      },
    ]);
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent(base(provider, messages, { ctx, signal: ac.signal })));

    // c1 正常 start/end；c2 从未启动（无事件），但结果占槽
    expect(toolTrace(events)).toEqual(['start:c1', 'end:c1']);
    const blocks = toolResultBlocks(messages);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['c1', 'c2']);
    expect(String(blocks[0]!.content)).toContain('done:p1');
    expect(blocks[1]!.is_error).toBe(true);
    expect(String(blocks[1]!.content)).toContain('用户主动中断');
    expect(events.at(-1)!.type).toBe('aborted');
  });

  it('spawn 超 maxConcurrent 时第 N+1 个等待（信号量在 runTurn 路径生效）', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const ctx: ToolContext = {
      cwd: process.cwd(),
      depth: 0,
      subagentMaxConcurrent: 1, // worker pool 容量 1
      runSubagent: async (req) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
        return { summary: `done:${req.prompt}${LONG}`, isError: false };
      },
    };
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'spawn_agent', { prompt: 'p1', subagent_type: 'explore' }),
          toolUseBlock('c2', 'spawn_agent', { prompt: 'p2', subagent_type: 'explore' }),
          toolUseBlock('c3', 'spawn_agent', { prompt: 'p3', subagent_type: 'explore' }),
        ],
      },
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent(base(provider, messages, { ctx })));

    expect(maxConcurrent).toBe(1); // 资源不冲突但受槽位约束，三个 explore 也逐个跑
    const blocks = toolResultBlocks(messages);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['c1', 'c2', 'c3']);
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('混合 explore/general：explore 并行跑完，general（all）最后串行', async () => {
    const log: string[] = [];
    const ctx: ToolContext = {
      cwd: process.cwd(),
      depth: 0,
      runSubagent: async (req) => {
        log.push(`start:${req.subagentType}:${req.prompt}`);
        await new Promise((r) => setTimeout(r, 10));
        log.push(`end:${req.subagentType}:${req.prompt}`);
        return { summary: `done${LONG}`, isError: false };
      },
    };
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'spawn_agent', { prompt: 'e1', subagent_type: 'explore' }),
          toolUseBlock('c2', 'spawn_agent', { prompt: 'e2', subagent_type: 'explore' }),
          toolUseBlock('c3', 'spawn_agent', { prompt: 'g1', subagent_type: 'general' }),
        ],
      },
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const messages: StoredMessage[] = [sm('go')];
    const events = await collect(runAgent(base(provider, messages, { ctx })));

    // 两个 explore 都在 general 启动前完成；general 与一切互斥
    expect(log.slice(0, 2)).toEqual(['start:explore:e1', 'start:explore:e2']);
    expect(log.indexOf('start:general:g1')).toBeGreaterThan(log.indexOf('end:explore:e1'));
    expect(log.indexOf('start:general:g1')).toBeGreaterThan(log.indexOf('end:explore:e2'));
    const blocks = toolResultBlocks(messages);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['c1', 'c2', 'c3']);
    expect(events.at(-1)!.type).toBe('turn_done');
  });
});
