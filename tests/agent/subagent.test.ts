import type Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubagentProgressEvent } from '../../src/agent/events.js';
import { buildAgentRegistry, parseAgentMarkdown } from '../../src/agent/subagent/registry.js';
import { closeDanglingToolUse } from '../../src/agent/wirelog.js';
import { createSubagentRunner, type SubagentRunnerDeps } from '../../src/agent/subagent/runner.js';
import { SubagentStore } from '../../src/agent/subagent/store.js';
import type { SubagentResult } from '../../src/agent/subagent/types.js';
import { BackgroundManager, type BackgroundTask } from '../../src/agent/background/manager.js';
import { applyCtrlB } from '../../src/chat/ctrlB.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { parseSkillMd, type SkillRegistry } from '../../src/skill/registry.js';
import { SessionStore } from '../../src/session/store.js';
import { spawnAgentTool } from '../../src/tools/spawnAgent.js';
import { subagentListing } from '../../src/agent/systemPrompt.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';
import { runAgent } from '../../src/agent/loop.js';

const LONG = 'x'.repeat(220); // >200，跳过摘要补写

// 子会话落盘的临时目录：deps() 每次新建，afterEach 统一清理
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function makeStores(): { sessions: SessionStore; subStore: SubagentStore } {
  const dir = mkdtempSync(join(tmpdir(), 'stepcode-sub-'));
  tmpDirs.push(dir);
  const sessions = new SessionStore(dir);
  return { sessions, subStore: new SubagentStore(sessions) };
}

function makeSubagentStore(): SubagentStore {
  return makeStores().subStore;
}

/** 断言历史里每个 tool_use 都有配对的 tool_result（无孤儿，可安全送 provider）。 */
function expectPaired(messages: StoredMessage[]): void {
  const answered = new Set<string>();
  for (const m of messages) {
    const c = m.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) if (b.type === 'tool_result') answered.add(b.tool_use_id);
  }
  for (const m of messages) {
    const c = m.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) if (b.type === 'tool_use') expect(answered.has(b.id), `孤儿 tool_use: ${b.id}`).toBe(true);
  }
}

describe('parseAgentMarkdown', () => {
  it('解析合法 frontmatter + 正文', () => {
    const md = `---\nname: reviewer\ndescription: 代码审查\ntools: [read_file, grep]\nmaxSteps: 12\n---\n你是一个只读代码审查子 agent，仔细检查改动。`;
    const def = parseAgentMarkdown(md, 'fallback');
    expect(def).not.toBeNull();
    expect(def!.name).toBe('reviewer');
    expect(def!.tools).toEqual(['read_file', 'grep']);
    expect(def!.maxSteps).toBe(12);
    expect(def!.systemPrompt).toContain('只读代码审查');
  });

  it('未配 maxSteps → undefined（交给 config 全局默认）', () => {
    const md = `---\nname: r\ndescription: d\n---\n这是一段足够长的子 agent 系统提示词内容。`;
    const def = parseAgentMarkdown(md, 'f');
    expect(def).not.toBeNull();
    expect(def!.maxSteps).toBeUndefined();
  });

  it('正文过短 / 缺字段 → null', () => {
    expect(parseAgentMarkdown(`---\nname: x\ndescription: d\n---\n短`, 'f')).toBeNull();
    expect(parseAgentMarkdown('没有 frontmatter 的普通文档内容', 'f')).toBeNull();
  });
});

describe('buildAgentRegistry', () => {
  it('内置 general / explore 存在', () => {
    const reg = buildAgentRegistry(process.cwd());
    expect(reg.has('general')).toBe(true);
    expect(reg.has('explore')).toBe(true);
    expect(reg.get('explore')!.tools).toContain('read_file');
  });
});

const deps = (
  provider: ReturnType<typeof makeFakeProvider>['provider'],
  onEvent?: (id: string | undefined, e: SubagentProgressEvent) => void,
  over: Partial<SubagentRunnerDeps> = {},
): SubagentRunnerDeps => ({
  provider,
  cwd: process.cwd(),
  hooks: {},
  maxDepth: 1,
  maxStepsDefault: 30,
  compaction: { maxContextSize: 1_000_000, triggerRatio: 0.85, reservedTokens: 32000 },
  sessionCounter: { spawned: 0 },
  subagentStore: makeSubagentStore(),
  parentSessionId: 'parent-main-session',
  onEvent,
  ...over,
});

describe('createSubagentRunner', () => {
  it('深度已达上限 → 拒绝且不调用 provider', async () => {
    const { provider, streamCalls } = makeFakeProvider([]);
    const run = createSubagentRunner(deps(provider));
    const r = await run({ subagentType: 'general', prompt: 'x', depth: 1 });
    expect(r.isError).toBe(true);
    expect(r.summary).toContain('深度上限');
    expect(streamCalls()).toBe(0);
  });

  it('maxDepth 可配为 2 时允许再下探一层', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock(LONG)] },
    ]);
    const run = createSubagentRunner(deps(provider, undefined, { maxDepth: 2 }));
    const r = await run({ subagentType: 'general', prompt: 'x', depth: 1 });
    expect(r.isError).toBe(false);
    expect(streamCalls()).toBe(1);
  });

  it('未知子 agent 类型 → 错误', async () => {
    const { provider, streamCalls } = makeFakeProvider([]);
    const run = createSubagentRunner(deps(provider));
    const r = await run({ subagentType: 'nope', prompt: 'x', depth: 0 });
    expect(r.isError).toBe(true);
    expect(r.summary).toContain('未知子 agent 类型');
    expect(streamCalls()).toBe(0);
  });

  it('每次成功派生递增会话计数器', async () => {
    const { provider } = makeFakeProvider([{ textChunks: [], finalContent: [textBlock(LONG)] }]);
    const counter = { spawned: 0 };
    const run = createSubagentRunner(deps(provider, undefined, { sessionCounter: counter }));
    await run({ subagentType: 'general', prompt: '干活', depth: 0 });
    expect(counter.spawned).toBe(1);
  });

  it('未知类型 / 深度超限不递增计数器', async () => {
    const { provider } = makeFakeProvider([]);
    const counter = { spawned: 0 };
    const run = createSubagentRunner(deps(provider, undefined, { sessionCounter: counter }));
    await run({ subagentType: 'nope', prompt: 'x', depth: 0 });
    await run({ subagentType: 'general', prompt: 'x', depth: 1 }); // 深度超限
    expect(counter.spawned).toBe(0);
  });

  it('maxDepth=2 时子 agent 可再派生（嵌套），工具集保留 spawn_agent', async () => {
    // 主 agent → 子 agent(depth1) 内模型再调 spawn_agent → 孙 agent(depth2)
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'spawn_agent', { prompt: '孙任务', description: 'd', subagent_type: 'explore' })] },
      { textChunks: [], finalContent: [textBlock(LONG)] }, // 孙 agent 返回
      { textChunks: [], finalContent: [textBlock(LONG)] }, // 子 agent 返回
    ]);
    const run = createSubagentRunner(deps(provider, undefined, { maxDepth: 2 }));
    const r = await run({ subagentType: 'general', prompt: '主任务', depth: 0 });
    expect(r.isError).toBe(false);
    expect(streamCalls()).toBeGreaterThanOrEqual(2); // 子 agent 和孙 agent 都跑了
  });

  it('正常跑完 → 最后一条 assistant 文本作为摘要回灌', async () => {
    const { provider } = makeFakeProvider([{ textChunks: [], finalContent: [textBlock(LONG)] }]);
    const run = createSubagentRunner(deps(provider));
    const r = await run({ subagentType: 'general', prompt: '干活', depth: 0 });
    expect(r.isError).toBe(false);
    expect(r.summary).toBe(LONG);
  });

  it('子 agent 共享 skill：system 拼清单、工具表含 skill 工具', async () => {
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock(LONG)] },
    ]);
    const reg: SkillRegistry = { skills: new Map() };
    reg.skills.set('demo', parseSkillMd('---\nname: demo\ndescription: 演示技能\n---\n技能正文', '/d', { kind: 'user' })!);
    const run = createSubagentRunner(deps(provider, undefined, { skills: reg }));
    const r = await run({ subagentType: 'explore', prompt: 'x', depth: 0 });
    expect(r.isError).toBe(false);
    const p = streamParams()[0]!;
    // system 含技能清单（子 agent 也能感知可用技能）
    expect(String(p.system)).toContain('可用技能');
    expect(String(p.system)).toContain('demo');
    // 工具表含 skill（explore 白名单已纳入，read-only 激活安全）
    const toolNames = (p.tools as { name: string }[]).map((tt) => tt.name);
    expect(toolNames).toContain('skill');
  });

  it('子 agent 无法派生：spawn_agent 被工具白名单拦下', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'spawn_agent', { prompt: 'y', description: 'd' })] },
      { textChunks: [], finalContent: [textBlock(LONG)] },
    ]);
    const run = createSubagentRunner(deps(provider));
    const r = await run({ subagentType: 'general', prompt: '试图再派生', depth: 0 });
    // spawn_agent 被子 agent 的工具白名单拦下（allowedTools 守卫），子 agent 仍正常跑完
    expect(r.isError).toBe(false);
    expect(streamCalls()).toBe(2); // 子 agent 尝试 spawn + 总结两轮
  });
});

describe('runner 消费 usage 事件（计费口径累计上抛）', () => {
  it('连续两轮带 billedDelta → 累计值递增的 usage progress（缓存命中不计成本）', async () => {
    const events: SubagentProgressEvent[] = [];
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [toolUseBlock('c1', 'nonexistent_tool', {})],
        usage: { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 10 } as Anthropic.Usage,
      },
      {
        textChunks: [],
        finalContent: [textBlock(LONG)],
        usage: { input_tokens: 200, output_tokens: 20 } as Anthropic.Usage,
      },
    ]);
    const run = createSubagentRunner(deps(provider, (_id, e) => events.push(e)));
    const r = await run({ subagentType: 'general', prompt: '干活', depth: 0 });
    expect(r.isError).toBe(false);
    // 第 1 轮 100+10=110（cache_read 不计入）；第 2 轮 200+20=220 → 累计 330
    expect(events.filter((e) => e.kind === 'usage')).toEqual([
      { kind: 'usage', tokens: 110 },
      { kind: 'usage', tokens: 330 },
    ]);
  });

  it('摘要过短追加轮的消耗连续累计（同一闭包 tokensUsed）', async () => {
    const events: SubagentProgressEvent[] = [];
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [textBlock('短')], // <200 字，触发追加轮
        usage: { input_tokens: 50, output_tokens: 5 } as Anthropic.Usage,
      },
      {
        textChunks: [],
        finalContent: [textBlock(LONG)],
        usage: { input_tokens: 80, output_tokens: 30 } as Anthropic.Usage,
      },
    ]);
    const run = createSubagentRunner(deps(provider, (_id, e) => events.push(e)));
    const r = await run({ subagentType: 'general', prompt: '干活', depth: 0 });
    expect(r.isError).toBe(false);
    expect(r.summary).toBe(LONG);
    // 追加轮（55 + 110 = 165）接着首轮累计，不重置
    expect(events.filter((e) => e.kind === 'usage')).toEqual([
      { kind: 'usage', tokens: 55 },
      { kind: 'usage', tokens: 165 },
    ]);
  });

  it('压缩后的估算 usage（无 billedDelta）不计入累计', async () => {
    const events: SubagentProgressEvent[] = [];
    const usage = { input_tokens: 1000, output_tokens: 10 } as Anthropic.Usage;
    // 同构 behaviors：每一项都是「带 usage 的 tool_use」。
    //
    // 刻意不去精确控制压缩发生在第几轮。压缩预检的口径含框架固定开销
    // （system + tools schema，本仓库约 8k tok），触发时机会随工具表增删而漂移，
    // 把断言绑在某一轮上会让这个用例变成每次改工具都要重调的脆弱测试。
    // 同构序列让任何触发时机都不越界：摘要调用若落在某一项上，该项不是文本、
    // 摘要为空会被质量闸门挡下（压缩失败，不产出估算 usage）；压缩若成功则产出
    // 一条无 billedDelta 的估算 usage。两种情况本用例的判据都成立。
    //
    // 注意：每轮的工具 input 必须逐轮不同（{ i }）。跨回合零进展检测（roundLoop.ts）
    // 会把「调用与结果双双完全相同的连续 3 轮」判为死循环并硬停——完全同构的
    // 序列会在压缩触发前就被拦下，测不到本用例要测的压缩路径。
    const many = Array.from({ length: 14 }, (_, i) => ({
      textChunks: [] as string[],
      finalContent: [toolUseBlock(`c${Math.random().toString(36).slice(2, 8)}`, 'nonexistent_tool', { i })],
      usage,
    }));
    const { provider } = makeFakeProvider([
      ...many,
      { textChunks: [], finalContent: [textBlock(LONG)], usage }, // 收尾 end_turn
    ]);
    const run = createSubagentRunner(
      deps(provider, (_id, e) => events.push(e), {
        compaction: { maxContextSize: 20000, triggerRatio: 0.85, reservedTokens: 10 },
      }),
    );
    const r = await run({ subagentType: 'general', prompt: 'x'.repeat(1200), depth: 0 });
    expect(r.isError).toBe(false);

    const usageEvents = events.filter((e) => e.kind === 'usage') as { kind: 'usage'; tokens: number }[];
    expect(usageEvents.length).toBeGreaterThan(0);
    // 判据：累计值的**每一步增量恒为一轮真实计费**（1000 - 0 + 10）。
    // 估算 usage 是全量快照而非增量，一旦被计入必然出现非 1010 的跳变。
    let prev = 0;
    for (const e of usageEvents) {
      expect(e.tokens - prev).toBe(1010);
      prev = e.tokens;
    }
  });

  it('provider 未回 usage → 不产生 usage progress（billedDelta 缺省时旧行为不变）', async () => {
    const events: SubagentProgressEvent[] = [];
    const { provider } = makeFakeProvider([{ textChunks: [], finalContent: [textBlock(LONG)] }]);
    const run = createSubagentRunner(deps(provider, (_id, e) => events.push(e)));
    const r = await run({ subagentType: 'general', prompt: '干活', depth: 0 });
    expect(r.isError).toBe(false);
    expect(events.filter((e) => e.kind === 'usage')).toHaveLength(0);
  });
});

describe('start 事件的显示描述（短标签优先，防长 prompt 挤掉行尾统计段）', () => {
  it('req 带 description → start 事件用短标签，不用 prompt 截断', async () => {
    const events: SubagentProgressEvent[] = [];
    const { provider } = makeFakeProvider([{ textChunks: [], finalContent: [textBlock(LONG)] }]);
    const run = createSubagentRunner(deps(provider, (_id, e) => events.push(e)));
    await run({ subagentType: 'general', prompt: '背景：很长很长的任务描述', depth: 0, description: '实施 /reload 命令' });
    expect(events.find((e) => e.kind === 'start')).toEqual({
      kind: 'start',
      subagentType: 'general',
      description: '实施 /reload 命令',
    });
  });

  it('req 无 description → 退回 prompt 截断且压平换行', async () => {
    const events: SubagentProgressEvent[] = [];
    const { provider } = makeFakeProvider([{ textChunks: [], finalContent: [textBlock(LONG)] }]);
    const run = createSubagentRunner(deps(provider, (_id, e) => events.push(e)));
    await run({ subagentType: 'general', prompt: '第一行\n第二行\r\n第三行', depth: 0 });
    const start = events.find((e) => e.kind === 'start');
    expect(start).toEqual({ kind: 'start', subagentType: 'general', description: '第一行 第二行 第三行' });
  });
});

describe('runAgent allowedTools 守卫', () => {
  it('白名单外的工具调用被拒、不执行', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'write_file', { path: 'x', content: 'y' })] },
      { textChunks: ['ok'], finalContent: [textBlock('ok')] },
    ]);
    const messages: StoredMessage[] = [stored({ role: 'user', content: 'go' }, { kind: 'user' })];
    const events = await collect(
      runAgent({
        provider,
        system: 's',
        ctx: { cwd: process.cwd() },
        messages,
        allowedTools: ['read_file'],
      }),
    );
    const toolEnd = events.find((e) => e.type === 'tool_end') as
      | { type: 'tool_end'; isError: boolean; result: string }
      | undefined;
    expect(toolEnd?.isError).toBe(true);
    expect(toolEnd?.result).toContain('不可用');
  });
});

describe('spawn_agent 工具', () => {
  it('一轮多个 explore spawn_agent → 并行执行，全部回 tool_result', async () => {
    const { provider } = makeFakeProvider([
      // 第 1 轮：模型同时发两个 explore spawn_agent
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('s1', 'spawn_agent', { description: 'd1', prompt: 'p1', subagent_type: 'explore' }),
          toolUseBlock('s2', 'spawn_agent', { description: 'd2', prompt: 'p2', subagent_type: 'explore' }),
        ],
      },
      // 两个子 agent 各自的 runAgent（并行，各取一条）
      { textChunks: [], finalContent: [textBlock(LONG)] },
      { textChunks: [], finalContent: [textBlock(LONG)] },
      // 主 agent 下一轮：结束
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const messages: StoredMessage[] = [stored({ role: 'user', content: '并行调查' }, { kind: 'user' })];
    const events = await collect(
      runAgent({
        provider,
        system: 's',
        ctx: { cwd: process.cwd(), depth: 0, runSubagent: async (req) => ({ summary: `done:${req.subagentType}`, isError: false }) },
        messages,
      }),
    );
    const toolEnds = events.filter((e) => e.type === 'tool_end');
    expect(toolEnds).toHaveLength(2);
    // tool_result 消息包含两个结果
    const toolResultMsg = messages.find(
      (m) => m.message.role === 'user' && Array.isArray(m.message.content) && m.message.content.some((b) => b.type === 'tool_result'),
    );
    expect(toolResultMsg).toBeDefined();
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('ctx 无 runSubagent → 报错（子 agent 内不能派生）', async () => {
    const r = await spawnAgentTool.execute(
      { description: 'd', prompt: 'p' },
      { cwd: process.cwd() },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('不支持派生');
  });

  it('run_in_background=true → 立即返回 task_id，后台执行', async () => {
    const { BackgroundManager } = await import('../../src/agent/background/manager.js');
    const mgr = new BackgroundManager();
    const r = await spawnAgentTool.execute(
      { description: 'd', prompt: 'p', subagent_type: 'explore', run_in_background: true },
      {
        cwd: process.cwd(),
        depth: 0,
        background: mgr,
        runSubagent: async () => ({ summary: '后台完成', isError: false }),
      },
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain('task_id=');
    // 等待后台任务完成
    await new Promise((res) => setTimeout(res, 50));
    const tasks = mgr.list();
    expect(tasks.length).toBeGreaterThan(0);
  });

  it('有 runSubagent → 透传结果', async () => {
    const r = await spawnAgentTool.execute(
      { description: 'd', prompt: 'p', subagent_type: 'explore' },
      {
        cwd: process.cwd(),
        depth: 0,
        runSubagent: async (req) => ({ summary: `done:${req.subagentType}`, isError: false }),
      },
    );
    expect(r.isError).toBe(false);
    // 结构化结果头 + 原样 summary 正文（无 sessionId 时头部省略 session 段）
    expect(r.content).toBe('subagent: explore | status: done\n\ndone:explore');
  });

  it('description 透传到 runSubagent 请求（进度卡片短标签的数据源）', async () => {
    let captured: { description?: string } | undefined;
    await spawnAgentTool.execute(
      { description: '查一下热点', prompt: '背景：很长', subagent_type: 'explore' },
      {
        cwd: process.cwd(),
        depth: 0,
        runSubagent: async (req) => {
          captured = req;
          return { summary: 'ok', isError: false };
        },
      },
    );
    expect(captured?.description).toBe('查一下热点');
  });
});

describe('子会话落盘（快照 + 全量日志 + 活跃锁）', () => {
  it('跑完后盘上有子会话文件：status done、meta 齐全、sessionId 回传、锁已释放', async () => {
    const { provider } = makeFakeProvider([{ textChunks: [], finalContent: [textBlock(LONG)] }]);
    const d = deps(provider);
    const run = createSubagentRunner(d);
    const r = await run({ subagentType: 'general', prompt: '干活', depth: 0 });
    expect(r.isError).toBe(false);
    expect(r.sessionId).toBeTruthy();

    const snap = d.subagentStore.loadSnapshot(d.cwd, r.sessionId!);
    expect(snap).not.toBeNull();
    expect(snap!.status).toBe('done');
    expect(snap!.agentType).toBe('general');
    expect(snap!.depth).toBe(1);
    expect(snap!.parentId).toBe('parent-main-session');
    expect(snap!.messages.length).toBeGreaterThan(0);
    // 全量日志同样落盘（首条 user prompt + assistant 回复）
    const full = d.subagentStore.loadFull(d.cwd, r.sessionId!);
    expect(full.length).toBeGreaterThanOrEqual(2);
    // list 可见该子会话
    expect(d.subagentStore.list(d.cwd).map((m) => m.id)).toEqual([r.sessionId]);
    // 活跃锁已释放（可重新 acquire）
    expect(d.subagentStore.acquireLock(d.cwd, r.sessionId!)).toBe(true);
    d.subagentStore.releaseLock(d.cwd, r.sessionId!);
  });

  it('异常路径：provider 持续抛错 → status error 且历史完整落盘', async () => {
    const { provider } = makeFakeProvider(Array.from({ length: 10 }, () => ({ throw: new Error('boom') })));
    const d = deps(provider);
    const run = createSubagentRunner(d);
    const r = await run({ subagentType: 'general', prompt: '会失败的任务', depth: 0 });
    expect(r.isError).toBe(true);
    expect(r.sessionId).toBeTruthy();

    const snap = d.subagentStore.loadSnapshot(d.cwd, r.sessionId!);
    expect(snap).not.toBeNull();
    expect(snap!.status).toBe('error');
    // 历史仍完整落盘：首条 user prompt 在，事后可完整回看失败现场
    expect(snap!.messages.length).toBeGreaterThan(0);
    expect(snap!.messages[0]!.message.content).toBe('会失败的任务');
    expect(d.subagentStore.loadFull(d.cwd, r.sessionId!).length).toBeGreaterThan(0);
  });

  it('4 个并发子 agent 各写各的会话文件，互不覆盖', async () => {
    const { provider } = makeFakeProvider(
      Array.from({ length: 4 }, () => ({ textChunks: [], finalContent: [textBlock(LONG)] })),
    );
    const d = deps(provider);
    const run = createSubagentRunner(d);
    const prompts = ['任务一', '任务二', '任务三', '任务四'];
    const results = await Promise.all(
      prompts.map((p) => run({ subagentType: 'general', prompt: p, depth: 0 })),
    );
    // UUID 会话 id 互不相同（并发下同秒派生也不会撞文件名）
    const ids = results.map((r) => r.sessionId!);
    expect(new Set(ids).size).toBe(4);
    for (const [i, r] of results.entries()) {
      const snap = d.subagentStore.loadSnapshot(d.cwd, r.sessionId!)!;
      expect(snap.status).toBe('done');
      expect(snap.messages[0]!.message.content).toBe(prompts[i]);
    }
    expect(d.subagentStore.list(d.cwd)).toHaveLength(4);
  });
});

describe('SubagentStore', () => {
  it('锁：acquire 独占、release 后可重新 acquire；持锁会话拒删', () => {
    const subStore = makeSubagentStore();
    const cwd = process.cwd();
    const s = subStore.create(cwd, { model: 'm', agentType: 'general', depth: 1, parentId: 'p' });
    subStore.appendMessages(cwd, s.id, [stored({ role: 'user', content: 'hi' }, { kind: 'user' })]);
    subStore.saveSnapshot(s);

    expect(subStore.acquireLock(cwd, s.id)).toBe(true);
    expect(subStore.acquireLock(cwd, s.id)).toBe(false); // 已持锁，独占创建失败
    expect(subStore.delete(cwd, s.id)).toBe('locked'); // 运行中的会话拒删
    subStore.releaseLock(cwd, s.id);
    expect(subStore.acquireLock(cwd, s.id)).toBe(true);
    subStore.releaseLock(cwd, s.id);

    expect(subStore.delete(cwd, s.id)).toBe('deleted');
    expect(subStore.loadSnapshot(cwd, s.id)).toBeNull();
    expect(subStore.loadFull(cwd, s.id)).toEqual([]);
    expect(subStore.delete(cwd, s.id)).toBe('missing');
  });

  it('锁 stale 检测：pid 已死则回收后 acquire / delete 成功；pid 活着则拒绝；旧锁无 pid 也回收', async () => {
    const { sessions, subStore } = makeStores();
    const cwd = process.cwd();
    const s = subStore.create(cwd, { model: 'm', agentType: 'general', depth: 1, parentId: 'p' });
    subStore.appendMessages(cwd, s.id, [stored({ role: 'user', content: 'hi' }, { kind: 'user' })]);
    subStore.saveSnapshot(s);

    const lockDir = sessions.subagentDirFor(cwd);
    const lockPath = join(lockDir, `${s.id}.lock`);

    // pid 已死 → stale，acquire 回收后成功。
    // 用一个真实启动后立即退出的子进程 pid（不能用 -1：POSIX 下 kill(-1, 0)
    // 是「发信号给全部进程」的特殊语义，会误判为存活，Linux/macOS 上假失败）
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => dead.on('exit', resolve));
    writeFileSync(lockPath, JSON.stringify({ pid: dead.pid, startedAt: new Date().toISOString() }), 'utf8');
    expect(subStore.acquireLock(cwd, s.id)).toBe(true);
    subStore.releaseLock(cwd, s.id);

    // pid ≤ 0 的非法锁 → 按 stale 回收（实现侧防御，见 isLockAlive）
    writeFileSync(lockPath, JSON.stringify({ pid: -1, startedAt: new Date().toISOString() }), 'utf8');
    expect(subStore.acquireLock(cwd, s.id)).toBe(true);
    subStore.releaseLock(cwd, s.id);

    // pid 活着（当前进程）→ 拒绝 acquire，拒绝 delete
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
    expect(subStore.acquireLock(cwd, s.id)).toBe(false);
    expect(subStore.delete(cwd, s.id)).toBe('locked');
    subStore.releaseLock(cwd, s.id);

    // 旧锁无 pid 字段 → 视为 stale，acquire 和 delete 均正常
    writeFileSync(lockPath, JSON.stringify({ startedAt: new Date().toISOString() }), 'utf8');
    expect(subStore.acquireLock(cwd, s.id)).toBe(true);
    subStore.releaseLock(cwd, s.id);
    writeFileSync(lockPath, JSON.stringify({ startedAt: new Date().toISOString() }), 'utf8');
    expect(subStore.delete(cwd, s.id)).toBe('deleted');
  });

  it('create 用 UUID 作 id；appendMessages 按 id 去重幂等；list 读回 meta', () => {
    const subStore = makeSubagentStore();
    const cwd = process.cwd();
    const a = subStore.create(cwd, { model: 'm', agentType: 'explore', depth: 1 });
    const b = subStore.create(cwd, { model: 'm', agentType: 'general', depth: 2, parentId: a.id });
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);

    const m1 = stored({ role: 'user', content: 'q' }, { kind: 'user' });
    const m2 = stored({ role: 'assistant', content: 'a' }, { kind: 'assistant' });
    expect(subStore.appendMessages(cwd, a.id, [m1])).toBe(1);
    expect(subStore.appendMessages(cwd, a.id, [m1, m2])).toBe(1); // m1 已存在，只写 m2
    expect(subStore.loadFull(cwd, a.id).map((m) => m.id)).toEqual([m1.id, m2.id]);

    a.messages = [m1, m2];
    subStore.saveSnapshot(a);
    const metas = subStore.list(cwd);
    expect(metas.map((m) => m.id)).toEqual([a.id]); // b 未落盘
    expect(metas[0]!.status).toBe('running');
    expect(metas[0]!.agentType).toBe('explore');
  });

  it('索引缓存：首次 list 建索引，二次 list 走缓存不重读快照（readFileSync 不额外调用）', () => {
    const subStore = makeSubagentStore();
    const cwd = process.cwd();
    const s = subStore.create(cwd, { model: 'm', agentType: 'general', depth: 1 });
    subStore.appendMessages(cwd, s.id, [stored({ role: 'user', content: 'hi' }, { kind: 'user' })]);
    subStore.saveSnapshot(s);

    // 首次 list：全量扫描 + 建索引
    const first = subStore.list(cwd);
    expect(first.map((m) => m.id)).toEqual([s.id]);

    // 对 readFileSync 设 spy：追踪后续是否还有读快照的行为
    const spy = vi.spyOn(require('node:fs'), 'readFileSync');

    // 二次 list：索引未过期，应直接返回缓存，不再读任何快照文件
    const second = subStore.list(cwd);
    expect(second.map((m) => m.id)).toEqual([s.id]);
    // 断言：readFileSync 未被调用（索引命中，无文件 IO）
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it('create + saveSnapshot 后索引同步更新，list 立即可见', () => {
    // 假时钟错开 updatedAt：同毫秒下倒序并列不稳定（Linux CI 实测 flaky），
    // 与主 store list 倒序测试同款的消除方式
    vi.useFakeTimers();
    try {
      const subStore = makeSubagentStore();
      const cwd = process.cwd();
      vi.setSystemTime(new Date('2026-08-07T00:00:00.000Z'));
      const a = subStore.create(cwd, { model: 'ma', agentType: 'explore', depth: 1 });
      subStore.appendMessages(cwd, a.id, [stored({ role: 'user', content: 'a' }, { kind: 'user' })]);
      subStore.saveSnapshot(a);

      vi.setSystemTime(new Date('2026-08-07T00:00:00.001Z'));
      const b = subStore.create(cwd, { model: 'mb', agentType: 'general', depth: 2, parentId: a.id });
      subStore.appendMessages(cwd, b.id, [stored({ role: 'user', content: 'b' }, { kind: 'user' })]);
      subStore.saveSnapshot(b);

      // 两次 saveSnapshot 都更新了索引，list 立即看到两条
      const metas = subStore.list(cwd);
      expect(metas).toHaveLength(2);
      expect(metas.map((m) => m.id)).toEqual([b.id, a.id]); // updatedAt 倒序
      expect(metas[0].agentType).toBe('general');
      expect(metas[1].agentType).toBe('explore');
    } finally {
      vi.useRealTimers();
    }
  });

  it('delete 后索引同步移除，list 不再返回已删会话', () => {
    const subStore = makeSubagentStore();
    const cwd = process.cwd();
    const a = subStore.create(cwd, { model: 'm', agentType: 'general', depth: 1 });
    subStore.saveSnapshot(a);
    const b = subStore.create(cwd, { model: 'm', agentType: 'explore', depth: 1 });
    subStore.saveSnapshot(b);

    expect(subStore.delete(cwd, a.id)).toBe('deleted');

    // 索引已同步移除 a；list 只返回 b
    const metas = subStore.list(cwd);
    expect(metas).toHaveLength(1);
    expect(metas[0].id).toBe(b.id);
  });

  it('索引文件损坏（非 JSON）→ 自动重建不报错', () => {
    const subStore = makeSubagentStore();
    // 访问 subStore 内部共享的 SessionStore 实例（同一 temp 目录）
    const sessions = (subStore as unknown as { sessions: SessionStore }).sessions;
    const cwd = process.cwd();
    const s = subStore.create(cwd, { model: 'm', agentType: 'general', depth: 1 });
    subStore.appendMessages(cwd, s.id, [stored({ role: 'user', content: 'hi' }, { kind: 'user' })]);
    subStore.saveSnapshot(s);

    // 确认索引已建立
    expect(subStore.list(cwd).map((m) => m.id)).toEqual([s.id]);

    // 写入损坏的索引文件：非 JSON 内容
    const indexFile = join(sessions.subagentDirFor(cwd), '_index.json');
    writeFileSync(indexFile, 'not json{{', 'utf8');

    // list 不抛错，自动重建索引
    const metas = subStore.list(cwd);
    expect(metas.map((m) => m.id)).toEqual([s.id]);

    // 重建后的索引文件是合法 JSON 且版本正确
    const raw = readFileSync(indexFile, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.sessions).toHaveLength(1);
  });

  it('索引版本号不匹配 → 重建而非复用', () => {
    const subStore = makeSubagentStore();
    // 访问 subStore 内部共享的 SessionStore 实例（同一 temp 目录）
    const sessions = (subStore as unknown as { sessions: SessionStore }).sessions;
    const cwd = process.cwd();
    const s = subStore.create(cwd, { model: 'm', agentType: 'general', depth: 1 });
    subStore.saveSnapshot(s);

    // 写入版本号为 99 的假索引
    const indexFile = join(sessions.subagentDirFor(cwd), '_index.json');
    writeFileSync(indexFile, JSON.stringify({ version: 99, rebuiltAt: new Date().toISOString(), sessions: [] }), 'utf8');

    // 版本不匹配触发重建，返回正确数据
    const metas = subStore.list(cwd);
    expect(metas.map((m) => m.id)).toEqual([s.id]);
    // 重建后版本已修正
    expect(JSON.parse(readFileSync(indexFile, 'utf8')).version).toBe(1);
  });
});

describe('resume：按 id 恢复子会话', () => {
  it('续跑：历史回灌 + 新 prompt 追加、首条 prompt 不重复、计数器不增、续接点无孤儿 tool_result', async () => {
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'nonexistent_tool', {})] },
      { textChunks: [], finalContent: [textBlock(LONG)] },
      { textChunks: [], finalContent: [textBlock(LONG)] }, // resume 轮
    ]);
    const counter = { spawned: 0 };
    const d = deps(provider, undefined, { sessionCounter: counter });
    const run = createSubagentRunner(d);
    const r1 = await run({ subagentType: 'general', prompt: '原始任务', depth: 0 });
    expect(r1.isError).toBe(false);
    expect(counter.spawned).toBe(1);

    const r2 = await run({ subagentType: 'general', prompt: '继续干活', depth: 0, resume: r1.sessionId });
    expect(r2.isError).toBe(false);
    expect(r2.sessionId).toBe(r1.sessionId); // 同一子会话，不新建
    expect(counter.spawned).toBe(1); // resume 不是新派生，计数器不增

    const snap = d.subagentStore.loadSnapshot(d.cwd, r1.sessionId!)!;
    expect(snap.status).toBe('done');
    // 首条 user prompt 不重复
    const firsts = snap.messages.filter((m) => m.message.content === '原始任务');
    expect(firsts).toHaveLength(1);
    // 新 prompt 作为 user 消息追加在旧历史之后
    const resumeIdx = snap.messages.findIndex((m) => m.message.content === '继续干活');
    expect(resumeIdx).toBeGreaterThan(0);
    // 续接点无孤儿 tool_result（历史里的 c1 早在首轮就有配对）
    expectPaired(snap.messages);
    // 发给 provider 的请求带完整回灌历史（resume 轮是第 3 次 stream 调用）
    expect(JSON.stringify(streamParams()[2]!.messages)).toContain('原始任务');
    expect(JSON.stringify(streamParams()[2]!.messages)).toContain('继续干活');
  });

  it('resume 不递增计数器（resume 不是新派生）', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock(LONG)] },
      { textChunks: [], finalContent: [textBlock(LONG)] }, // resume 轮
    ]);
    const counter = { spawned: 0 };
    const d = deps(provider, undefined, { sessionCounter: counter });
    const run = createSubagentRunner(d);
    const r1 = await run({ subagentType: 'general', prompt: '任务', depth: 0 });
    expect(counter.spawned).toBe(1);
    // resume 放行且不增计数
    const r2 = await run({ subagentType: 'general', prompt: '续', depth: 0, resume: r1.sessionId });
    expect(r2.isError).toBe(false);
    expect(counter.spawned).toBe(1);
  });

  it('目标会话不存在 → 明确报错；持活跃锁 → 拒绝且不覆写', async () => {
    const { provider } = makeFakeProvider([{ textChunks: [], finalContent: [textBlock(LONG)] }]);
    const d = deps(provider);
    const run = createSubagentRunner(d);
    const missing = await run({ subagentType: 'general', prompt: 'x', depth: 0, resume: 'no-such-id' });
    expect(missing.isError).toBe(true);
    expect(missing.summary).toContain('找不到子会话');

    const r1 = await run({ subagentType: 'general', prompt: '任务', depth: 0 });
    // 人为持锁模拟"正在跑"
    expect(d.subagentStore.acquireLock(d.cwd, r1.sessionId!)).toBe(true);
    const locked = await run({ subagentType: 'general', prompt: 'x', depth: 0, resume: r1.sessionId });
    expect(locked.isError).toBe(true);
    expect(locked.summary).toContain('正在运行');
    expect(locked.sessionId).toBe(r1.sessionId);
    d.subagentStore.releaseLock(d.cwd, r1.sessionId!);
    // 盘上快照未被覆写（仍是 done）
    expect(d.subagentStore.loadSnapshot(d.cwd, r1.sessionId!)!.status).toBe('done');
  });

  it('并发 resume 同一 id：第二个被锁拒绝，第一个正常跑完', async () => {
    const setup = makeFakeProvider([{ textChunks: [], finalContent: [textBlock(LONG)] }]);
    const d = deps(setup.provider);
    const run = createSubagentRunner(d);
    const r1 = await run({ subagentType: 'general', prompt: '底', depth: 0 });

    // gated provider：stream 迭代卡在 gate 上，模拟第一个 resume 正在执行
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const gatedProvider = {
      stream() {
        async function* iter(): AsyncGenerator<Anthropic.MessageStreamEvent> {
          await gate;
        }
        const gen = iter();
        return {
          [Symbol.asyncIterator]: () => gen,
          finalMessage: async () =>
            ({ content: [textBlock(LONG)], stop_reason: 'end_turn' }) as unknown as Anthropic.Message,
        };
      },
    } as unknown as ReturnType<typeof makeFakeProvider>['provider'];
    const d2 = deps(gatedProvider, undefined, { subagentStore: d.subagentStore });
    const run2 = createSubagentRunner(d2);

    const p1 = run2({ subagentType: 'general', prompt: '续一', depth: 0, resume: r1.sessionId! });
    await new Promise((r) => setTimeout(r, 50)); // 等 p1 拿锁并卡在 gate
    const r2 = await run2({ subagentType: 'general', prompt: '续二', depth: 0, resume: r1.sessionId! });
    expect(r2.isError).toBe(true);
    expect(r2.summary).toContain('正在运行');
    release();
    const rDone = await p1;
    expect(rDone.isError).toBe(false);
    expect(rDone.sessionId).toBe(r1.sessionId);
  });

  it('快照尾部含未配对 tool_use：resume 前补合成 tool_result，可安全送 provider', async () => {
    const subStore = makeSubagentStore();
    const cwd = process.cwd();
    const s = subStore.create(cwd, { model: 'm', agentType: 'general', depth: 1 });
    // 模拟崩溃在工具执行段的快照：末条 assistant 带 tool_use 但没有配对的 tool_result
    s.messages = [
      stored({ role: 'user', content: '原始任务' }, { kind: 'user' }),
      stored(
        { role: 'assistant', content: [textBlock('我来看一下'), toolUseBlock('c1', 'read_file', { path: 'x' })] },
        { kind: 'assistant' },
      ),
    ];
    subStore.saveSnapshot(s);

    const { provider, streamParams } = makeFakeProvider([{ textChunks: [], finalContent: [textBlock(LONG)] }]);
    const d = deps(provider, undefined, { subagentStore: subStore });
    const run = createSubagentRunner(d);
    const r = await run({ subagentType: 'general', prompt: '继续', depth: 0, resume: s.id });
    expect(r.isError).toBe(false);

    const snap = subStore.loadSnapshot(cwd, s.id)!;
    // 补合成后无孤儿；原 assistant 条保留（模型能看到自己发起过那次调用）
    expectPaired(snap.messages);
    const json = JSON.stringify(snap.messages);
    expect(json).toContain('[工具调用未产生结果：执行被中断。不要重试这次调用，按最新指示继续。]');
    expect(json).toContain('read_file');
    // 首个请求就已带上合成结果
    expect(JSON.stringify(streamParams()[0]!.messages)).toContain('[工具调用未产生结果：执行被中断。不要重试这次调用，按最新指示继续。]');
  });

  it('resume 回灌的 stepref 图片经 attachments rehydrate 后发给 provider（指针不外泄）', async () => {
    const subStore = makeSubagentStore();
    const cwd = process.cwd();
    const b64 = Buffer.alloc(4000, 7).toString('base64');
    const ref = subStore.attachments.offload(cwd, b64, 'image/png');
    expect(ref.startsWith('stepref:')).toBe(true);
    const s = subStore.create(cwd, { model: 'm', agentType: 'general', depth: 1 });
    s.messages = [
      stored(
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ref } },
          ],
        },
        { kind: 'user' },
      ),
      stored({ role: 'assistant', content: '看到了' }, { kind: 'assistant' }),
    ];
    subStore.saveSnapshot(s);

    const { provider, streamParams } = makeFakeProvider([{ textChunks: [], finalContent: [textBlock(LONG)] }]);
    const d = deps(provider, undefined, { subagentStore: subStore });
    const run = createSubagentRunner(d);
    const r = await run({ subagentType: 'general', prompt: '继续', depth: 0, resume: s.id });
    expect(r.isError).toBe(false);
    const wire = JSON.stringify(streamParams()[0]!.messages);
    expect(wire).toContain(b64); // stepref 已 rehydrate 回 base64
    expect(wire).not.toContain('stepref:');
  });

  it('嵌套派生：孙会话 parentId 指向子会话（谱系精确，不一律记主会话）', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'spawn_agent', { prompt: '孙任务', description: 'd', subagent_type: 'explore' })] },
      { textChunks: [], finalContent: [textBlock(LONG)] }, // 孙 agent 返回
      { textChunks: [], finalContent: [textBlock(LONG)] }, // 子 agent 返回
    ]);
    const d = deps(provider, undefined, { maxDepth: 2 });
    const run = createSubagentRunner(d);
    const r = await run({ subagentType: 'general', prompt: '主任务', depth: 0 });
    expect(r.isError).toBe(false);
    const metas = d.subagentStore.list(d.cwd);
    const child = metas.find((m) => m.agentType === 'general')!;
    const grand = metas.find((m) => m.agentType === 'explore')!;
    expect(child.parentId).toBe('parent-main-session');
    expect(grand.parentId).toBe(child.id);
    expect(grand.depth).toBe(2);
  });
});

describe('closeDanglingToolUse（尾部悬空 tool_use 闭合）', () => {
  it('末条 assistant 含未配对 tool_use → 补合成 error tool_result，原条保留', () => {
    const messages: StoredMessage[] = [
      stored({ role: 'user', content: 'q' }, { kind: 'user' }),
      stored(
        { role: 'assistant', content: [textBlock('看'), toolUseBlock('c1', 'read_file', {}), toolUseBlock('c2', 'grep', {})] },
        { kind: 'assistant' },
      ),
    ];
    const result = closeDanglingToolUse(messages);
    expect(result.closed).toBe(true);
    expect(result.closedToolUseIds).toEqual(['c1', 'c2']);
    expectPaired(result.messages);
    // 原 assistant 条仍在（未截掉）
    expect(result.messages[1]!.message.role).toBe('assistant');
    const last = result.messages.at(-1)!;
    expect(last.message.role).toBe('user');
    expect(JSON.stringify(last.message.content)).toContain('[工具调用未产生结果：执行被中断。不要重试这次调用，按最新指示继续。]');
  });

  it('部分配对：只补缺失的那个', () => {
    const messages: StoredMessage[] = [
      stored({ role: 'user', content: 'q' }, { kind: 'user' }),
      stored(
        { role: 'assistant', content: [toolUseBlock('c1', 'read_file', {}), toolUseBlock('c2', 'grep', {})] },
        { kind: 'assistant' },
      ),
      stored(
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }],
        },
        { kind: 'user' },
      ),
      stored({ role: 'assistant', content: [toolUseBlock('c2', 'grep', {})] }, { kind: 'assistant' }),
    ];
    const result = closeDanglingToolUse(messages);
    expect(result.closed).toBe(true);
    expect(result.closedToolUseIds).toEqual(['c2']);
    expectPaired(result.messages);
  });

  it('末条非 assistant 或已配对 → 不动', () => {
    const clean: StoredMessage[] = [
      stored({ role: 'user', content: 'q' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [toolUseBlock('c1', 'read_file', {})] }, { kind: 'assistant' }),
      stored({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] }, { kind: 'user' }),
    ];
    const result = closeDanglingToolUse(clean);
    expect(result.closed).toBe(false);
    expect(result.messages).toHaveLength(3);
    const textOnly: StoredMessage[] = [stored({ role: 'assistant', content: '纯文本' }, { kind: 'assistant' })];
    expect(closeDanglingToolUse(textOnly).closed).toBe(false);
    expect(closeDanglingToolUse([]).closed).toBe(false);
  });
});

describe('SubagentStore 级联删除与留存清理', () => {
  it('deleteWithParent：删主会话连带其子会话，持锁与其他父级的跳过', () => {
    const { subStore } = makeStores();
    const cwd = process.cwd();
    const mk = (parentId: string) => {
      const s = subStore.create(cwd, { model: 'm', agentType: 'general', depth: 1, parentId });
      subStore.saveSnapshot(s);
      return s;
    };
    const a = mk('P'); // 待级联
    const b = mk('OTHER'); // 别的父级
    const c = mk('P'); // 待级联但持锁
    expect(subStore.acquireLock(cwd, c.id)).toBe(true);

    expect(subStore.deleteWithParent(cwd, 'P')).toBe(1);
    expect(subStore.loadSnapshot(cwd, a.id)).toBeNull();
    expect(subStore.loadSnapshot(cwd, b.id)).not.toBeNull(); // 其他父级不受影响
    expect(subStore.loadSnapshot(cwd, c.id)).not.toBeNull(); // 持锁跳过
  });

  it('cleanup max_sessions：按 updatedAt 删最旧，持锁跳过', async () => {
    const { subStore } = makeStores();
    const cwd = process.cwd();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = subStore.create(cwd, { model: 'm', agentType: 'general', depth: 1 });
      s.status = 'done';
      subStore.saveSnapshot(s);
      ids.push(s.id);
      await new Promise((r) => setTimeout(r, 5)); // 拉开 updatedAt
    }
    // 锁住中间旧的：即使超上限也不删
    expect(subStore.acquireLock(cwd, ids[1]!)).toBe(true);
    expect(subStore.cleanup(cwd, { maxSessions: 1 })).toBe(1);
    expect(subStore.loadSnapshot(cwd, ids[0]!)).toBeNull(); // 最旧被删
    expect(subStore.loadSnapshot(cwd, ids[1]!)).not.toBeNull(); // 持锁跳过
    expect(subStore.loadSnapshot(cwd, ids[2]!)).not.toBeNull(); // 最新保留
  });

  it('cleanup ttl_days：删过期快照，未过期与持锁保留；全 0 不动', () => {
    const { sessions, subStore } = makeStores();
    const cwd = process.cwd();
    const old = subStore.create(cwd, { model: 'm', agentType: 'general', depth: 1 });
    subStore.saveSnapshot(old);
    const fresh = subStore.create(cwd, { model: 'm', agentType: 'general', depth: 1 });
    subStore.saveSnapshot(fresh);
    // 把 old 的 updatedAt 改到 10 天前（saveSnapshot 总刷新 updatedAt，直接改盘上的文件）
    const file = join(sessions.subagentDirFor(cwd), `${old.id}.json`);
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { updatedAt: string };
    raw.updatedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(file, JSON.stringify(raw), 'utf8');
    // mtime 显式拨到未来：索引过期判定是「文件 mtime >= 索引 rebuiltAt」，
    // 直改若与写索引落在同一毫秒会让判定依赖时序巧合（Windows CI 实测翻车），
    // 拨到未来让「索引必重建」成为确定性前提。
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);

    expect(subStore.cleanup(cwd, { ttlDays: 1 })).toBe(1);
    expect(subStore.loadSnapshot(cwd, old.id)).toBeNull();
    expect(subStore.loadSnapshot(cwd, fresh.id)).not.toBeNull();
    // 全 0 = 默认形态，不动任何文件
    expect(subStore.cleanup(cwd, { maxSessions: 0, ttlDays: 0 })).toBe(0);
    expect(subStore.loadSnapshot(cwd, fresh.id)).not.toBeNull();
  });

  it('fork 不复制子会话：fork 出的兄弟会话不继承子代', () => {
    const { sessions, subStore } = makeStores();
    const cwd = 'C:/fork-test';
    const a = sessions.create(cwd, 'm');
    sessions.save(a);
    const sub = subStore.create(cwd, { model: 'm', agentType: 'general', depth: 1, parentId: a.id });
    subStore.saveSnapshot(sub);

    // fork：新主会话 id + forkedFrom 谱系（与 /fork 命令同一形态）
    const fork = sessions.create(cwd, 'm');
    fork.forkedFrom = a.id;
    sessions.save(fork);

    // 子会话仍只属于源会话，不随 fork 复制；fork id 下没有任何子会话文件
    const metas = subStore.list(cwd);
    expect(metas).toHaveLength(1);
    expect(metas[0]!.parentId).toBe(a.id);
    expect(subStore.loadSnapshot(cwd, fork.id)).toBeNull();
  });
});

describe('spawn_agent resume 参数', () => {
  it('resume 透传到 runSubagent；返回串带 sessionId 供后续引用', async () => {
    let captured: { resume?: string } | undefined;
    const r = await spawnAgentTool.execute(
      { description: 'd', prompt: 'p', resume: 'sub-123' },
      {
        cwd: process.cwd(),
        depth: 0,
        runSubagent: async (req) => {
          captured = req;
          return { summary: 'ok', isError: false, sessionId: 'sub-123' };
        },
      },
    );
    expect(r.isError).toBe(false);
    expect(captured?.resume).toBe('sub-123');
    expect(r.content).toContain('sub-123');
  });
});

describe('前台子 agent 的转后台（Ctrl+B detach）', () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const deferred = <T,>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  };

  it('运行中 detach：工具结果立即结算为已转后台，终态经通知链路回灌', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    const run = deferred<SubagentResult>();
    const p = spawnAgentTool.execute(
      { description: '查资料', prompt: 'p', subagent_type: 'explore' },
      { cwd: process.cwd(), depth: 0, background: mgr, runSubagent: () => run.promise },
    );
    await sleep(10); // 等登记
    const fg = mgr.listForeground();
    expect(fg).toHaveLength(1);
    expect(fg[0]!.kind).toBe('subagent');
    expect(fg[0]!.agentType).toBe('explore');
    expect(fg[0]!.command).toBe('子agent·查资料');
    expect(mgr.activeBackgroundCount()).toBe(0); // 未 detach 不算后台

    expect(mgr.detach(fg[0]!.id)).toBe(true);
    const r = await p; // 父回合立即拿到结算结果
    expect(r.isError).toBe(false);
    expect(r.content).toContain('已转为后台任务');
    expect(r.content).toContain(fg[0]!.id);
    expect(mgr.activeBackgroundCount()).toBe(1);

    // 子 agent 继续跑完 → 终态结果经既有通知链路回灌（onSettle + 待投递队列）
    run.resolve({ summary: '后台跑完的结果', isError: false, sessionId: 'sub-1' });
    await sleep(20);
    expect(mgr.get(fg[0]!.id)?.status).toBe('completed');
    expect(settled).toHaveLength(1);
    expect(settled[0]!.output).toContain('后台跑完的结果');
    expect(settled[0]!.output).toContain('sub-1');
    expect(mgr.drainSettled().map((t) => t.id)).toEqual([fg[0]!.id]);
  });

  it('signal 解绑：detach 后父信号中断不再波及子 agent', async () => {
    const mgr = new BackgroundManager();
    const parentCtrl = new AbortController();
    let childSignal: AbortSignal | undefined;
    const run = deferred<SubagentResult>();
    const p = spawnAgentTool.execute(
      { description: 'd', prompt: 'p' },
      {
        cwd: process.cwd(),
        depth: 0,
        background: mgr,
        signal: parentCtrl.signal,
        runSubagent: (req) => {
          childSignal = req.signal;
          return run.promise;
        },
      },
    );
    await sleep(10);
    const id = mgr.listForeground()[0]!.id;
    expect(mgr.detach(id)).toBe(true);
    await p; // 工具结果已结算
    parentCtrl.abort(); // 父回合 Esc：已转后台的子 agent 不受影响
    expect(childSignal?.aborted).toBe(false);
    // 子 agent 照常跑完并置终态
    run.resolve({ summary: 'ok', isError: false });
    await sleep(20);
    expect(mgr.get(id)?.status).toBe('completed');
  });

  it('对照：未 detach 时父信号中断照常传给子 agent', async () => {
    const mgr = new BackgroundManager();
    const parentCtrl = new AbortController();
    let childSignal: AbortSignal | undefined;
    const run = deferred<SubagentResult>();
    const p = spawnAgentTool.execute(
      { description: 'd', prompt: 'p' },
      {
        cwd: process.cwd(),
        depth: 0,
        background: mgr,
        signal: parentCtrl.signal,
        runSubagent: (req) => {
          childSignal = req.signal;
          return run.promise;
        },
      },
    );
    await sleep(10);
    parentCtrl.abort();
    expect(childSignal?.aborted).toBe(true);
    run.resolve({ summary: '子 agent 已被中断。', isError: true });
    const r = await p;
    expect(r.isError).toBe(true);
    expect(r.content).toContain('中断');
  });

  it('同轮并行多个前台子 agent：一次 detach 全部（与 bash 同语义）', async () => {
    const mgr = new BackgroundManager();
    const gate = new Promise<SubagentResult>(() => {});
    const mk = (desc: string): ReturnType<typeof spawnAgentTool.execute> =>
      spawnAgentTool.execute(
        { description: desc, prompt: 'p', subagent_type: 'explore' },
        { cwd: process.cwd(), depth: 0, background: mgr, runSubagent: () => gate },
      );
    const p1 = mk('任务一');
    const p2 = mk('任务二');
    await sleep(10);
    expect(mgr.listForeground()).toHaveLength(2);
    // TUI 键位路径：busy 且有前台任务 → 一次 detach 全部
    expect(applyCtrlB(true, mgr)).toBe(2);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.content).toContain('已转为后台任务');
    expect(r2.content).toContain('已转为后台任务');
    expect(mgr.listForeground()).toEqual([]);
    expect(mgr.activeBackgroundCount()).toBe(2);
  });

  it('并发上限登记失败：退化为直接前台等待，结果原样返回', async () => {
    const mgr = new BackgroundManager(0); // 上限 0：登记必抛
    const r = await spawnAgentTool.execute(
      { description: 'd', prompt: 'p' },
      {
        cwd: process.cwd(),
        depth: 0,
        background: mgr,
        runSubagent: async () => ({ summary: 'ok', isError: false }),
      },
    );
    expect(r.isError).toBe(false);
    expect(r.content).toBe('subagent: general | status: done\n\nok');
    expect(mgr.list()).toEqual([]); // 没有留下任务
  });

  it('上下文不支持后台任务：信号原样透传（父中断照常生效）', async () => {
    const parentCtrl = new AbortController();
    let childSignal: AbortSignal | undefined;
    const run = deferred<SubagentResult>();
    const p = spawnAgentTool.execute(
      { description: 'd', prompt: 'p' },
      {
        cwd: process.cwd(),
        depth: 0,
        signal: parentCtrl.signal,
        runSubagent: (req) => {
          childSignal = req.signal;
          return run.promise;
        },
      },
    );
    await sleep(10);
    parentCtrl.abort();
    expect(childSignal?.aborted).toBe(true);
    run.resolve({ summary: '子 agent 已被中断。', isError: true });
    const r = await p;
    expect(r.isError).toBe(true);
  });

  // 两段式 provider：第一轮返回 tool_use（工具执行后 tool_end 触发落盘，子会话由此上盘），
  // 第二轮 stream 卡在 gate 上模拟长任务，直到放行。
  const twoStageGatedProvider = (gate: Promise<void>): ReturnType<typeof makeFakeProvider>['provider'] => {
    let calls = 0;
    return {
      stream() {
        calls += 1;
        const gated = calls > 1;
        async function* iter(): AsyncGenerator<Anthropic.MessageStreamEvent> {
          if (gated) await gate;
        }
        const gen = iter();
        return {
          [Symbol.asyncIterator]: () => gen,
          finalMessage: async () =>
            (gated
              ? { content: [textBlock(LONG)], stop_reason: 'end_turn' }
              : { content: [toolUseBlock('c1', 'nonexistent_tool', {})], stop_reason: 'tool_use' }) as unknown as Anthropic.Message,
        };
      },
    } as unknown as ReturnType<typeof makeFakeProvider>['provider'];
  };
  // 等子会话快照上盘（首轮 tool_end 落盘后可见）
  const waitSessionId = async (d: SubagentRunnerDeps): Promise<string> => {
    for (let i = 0; i < 100; i++) {
      const metas = d.subagentStore.list(d.cwd);
      if (metas.length > 0) return metas[0]!.id;
      await sleep(20);
    }
    throw new Error('子会话快照迟迟未上盘');
  };

  it('端到端：detach 后子会话以 running 落盘、锁持有；跑完写 done、锁释放、通知回灌', async () => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((res) => {
      releaseGate = res;
    });
    const d = deps(twoStageGatedProvider(gate));
    const runSubagent = createSubagentRunner(d);
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });

    const p = spawnAgentTool.execute(
      { description: '干活', prompt: '干活', subagent_type: 'general' },
      { cwd: d.cwd, depth: 0, background: mgr, runSubagent },
    );
    const taskId = mgr.listForeground()[0]!.id;
    const sessionId = await waitSessionId(d);
    // detach 前：会话 running 落盘、活跃锁持有
    expect(d.subagentStore.loadSnapshot(d.cwd, sessionId)!.status).toBe('running');
    expect(d.subagentStore.acquireLock(d.cwd, sessionId)).toBe(false);

    expect(mgr.detach(taskId)).toBe(true);
    const r = await p;
    expect(r.isError).toBe(false);
    expect(r.content).toContain('已转为后台任务');
    // detach 后子 agent 仍在跑：会话仍 running、锁仍持有
    expect(d.subagentStore.loadSnapshot(d.cwd, sessionId)!.status).toBe('running');
    expect(d.subagentStore.acquireLock(d.cwd, sessionId)).toBe(false);

    releaseGate(); // 放行，子 agent 跑完
    await sleep(100);
    expect(mgr.get(taskId)?.status).toBe('completed');
    const snap = d.subagentStore.loadSnapshot(d.cwd, sessionId)!;
    expect(snap.status).toBe('done'); // 终态落盘
    expect(d.subagentStore.acquireLock(d.cwd, sessionId)).toBe(true); // 锁已释放
    d.subagentStore.releaseLock(d.cwd, sessionId);
    // 终态通知回灌：onSettle 触发、输出带子会话 id、待投递队列可取
    expect(settled).toHaveLength(1);
    expect(settled[0]!.output).toContain(sessionId);
    expect(mgr.drainSettled().map((t) => t.id)).toEqual([taskId]);
  });

  it('detach 后 stop：经 onStop 中断子 agent，子会话写 aborted、锁释放', async () => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((res) => {
      releaseGate = res;
    });
    const d = deps(twoStageGatedProvider(gate));
    const runSubagent = createSubagentRunner(d);
    const mgr = new BackgroundManager();

    const p = spawnAgentTool.execute(
      { description: '干活', prompt: '干活', subagent_type: 'general' },
      { cwd: d.cwd, depth: 0, background: mgr, runSubagent },
    );
    const taskId = mgr.listForeground()[0]!.id;
    const sessionId = await waitSessionId(d);
    expect(mgr.detach(taskId)).toBe(true);
    await p;

    // /tasks 里 stop：走 manager 终止路径，经 onStop 中断子 agent 的 AbortController
    expect(mgr.stop(taskId)).toBe(true);
    releaseGate();
    await sleep(100);
    expect(mgr.get(taskId)?.status).toBe('killed');
    const snap = d.subagentStore.loadSnapshot(d.cwd, sessionId)!;
    expect(snap.status).toBe('aborted'); // 子 agent 感知中断，终态如实落盘
    expect(d.subagentStore.acquireLock(d.cwd, sessionId)).toBe(true); // 锁已释放
    d.subagentStore.releaseLock(d.cwd, sessionId);
  });
});

describe('角色定义的 whenToUse 字段', () => {
  it('内置 general / explore 都带 whenToUse（供主 agent 选型）', () => {
    const reg = buildAgentRegistry(mkdtempSync(join(tmpdir(), 'stepcode-empty-')));
    expect(reg.get('general')!.whenToUse).toBeTruthy();
    expect(reg.get('explore')!.whenToUse).toBeTruthy();
  });

  it('markdown frontmatter 的 whenToUse 驼峰写法可解析', () => {
    const def = parseAgentMarkdown(
      `---\nname: r\ndescription: d\nwhenToUse: 需要独立复核时用它\n---\n${'正文'.repeat(20)}`,
      'r',
    );
    expect(def!.whenToUse).toBe('需要独立复核时用它');
  });

  it('markdown frontmatter 的 when_to_use 蛇形写法同样可解析（与 skill 命名对齐）', () => {
    const def = parseAgentMarkdown(
      `---\nname: r\ndescription: d\nwhen_to_use: 蛇形也认\n---\n${'正文'.repeat(20)}`,
      'r',
    );
    expect(def!.whenToUse).toBe('蛇形也认');
  });

  it('未写 whenToUse 时为 undefined（存量自定义 agent 不因新字段失效）', () => {
    const def = parseAgentMarkdown(
      `---\nname: r\ndescription: d\n---\n${'正文'.repeat(20)}`,
      'r',
    );
    expect(def).not.toBeNull();
    expect(def!.whenToUse).toBeUndefined();
  });
});

describe('subagentListing 角色清单', () => {
  it('列出全部角色（含内置 general / explore），不再只列自定义', () => {
    const out = subagentListing([
      { name: 'general', description: '通用', whenToUse: '要动手时' },
      { name: 'explore', description: '只读', whenToUse: '要调查时' },
      { name: 'reviewer', description: '复核', whenToUse: '要复核时' },
    ]);
    expect(out).toContain('general');
    expect(out).toContain('explore');
    expect(out).toContain('reviewer');
  });

  it('whenToUse 拼进清单；缺省时只渲染 description', () => {
    const out = subagentListing([
      { name: 'a', description: '甲角色', whenToUse: '甲的时机' },
      { name: 'b', description: '乙角色' },
    ]);
    expect(out).toContain('- a：甲角色 何时用：甲的时机');
    expect(out).toContain('- b：乙角色');
    expect(out).not.toContain('- b：乙角色 何时用');
  });

  it('空注册表返回空串（不产出只有标题的空段）', () => {
    expect(subagentListing([])).toBe('');
  });

  it('超预算先压缩描述：丢 whenToUse、description 只留首句', () => {
    const roles = Array.from({ length: 8 }, (_, i) => ({
      name: `role${String(i)}`,
      description: `第${String(i)}个角色。后面还有很长的补充说明用来撑爆预算${'补'.repeat(40)}`,
      whenToUse: `时机${String(i)}${'详'.repeat(40)}`,
    }));
    const out = subagentListing(roles, 600);
    expect(out).not.toContain('何时用'); // 压缩档丢掉 whenToUse
    expect(out).toContain('第0个角色'); // 首句保留
    expect(out).not.toContain('补补补'); // 首句之后的内容被截
  });

  it('压缩后仍超预算：按预算截断并注明省略条数', () => {
    const roles = Array.from({ length: 30 }, (_, i) => ({
      name: `role${String(i)}`,
      description: `这是第${String(i)}个角色的说明文字用来占预算`,
    }));
    const out = subagentListing(roles, 400);
    expect(out).toMatch(/另有 \d+ 个角色因篇幅省略/);
    expect(out.length).toBeLessThanOrEqual(400);
  });
});

describe('子 agent 结果结构化回灌', () => {
  it('成功：头部含角色、status done 与子会话 id，正文原样保留', async () => {
    const r = await spawnAgentTool.execute(
      { description: 'd', prompt: 'p', subagent_type: 'explore' },
      {
        cwd: process.cwd(),
        depth: 0,
        runSubagent: async () => ({ summary: '调查结论正文', isError: false, sessionId: 'sess-1' }),
      },
    );
    expect(r.isError).toBe(false);
    expect(r.content).toBe(
      'subagent: explore | status: done | session: sess-1\n\n调查结论正文',
    );
  });

  it('失败：status error 且尾部给出 resume 提示（父侧据此决定是否续跑）', async () => {
    const r = await spawnAgentTool.execute(
      { description: 'd', prompt: 'p', subagent_type: 'general' },
      {
        cwd: process.cwd(),
        depth: 0,
        runSubagent: async () => ({ summary: '跑到一半失败了', isError: true, sessionId: 'sess-2' }),
      },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('subagent: general | status: error | session: sess-2');
    expect(r.content).toContain('跑到一半失败了');
    expect(r.content).toContain('resume="sess-2"');
  });

  it('无 sessionId（起步前被拒）：头部省略 session 段，也不给 resume 提示', async () => {
    const r = await spawnAgentTool.execute(
      { description: 'd', prompt: 'p', subagent_type: 'general' },
      {
        cwd: process.cwd(),
        depth: 0,
        runSubagent: async () => ({ summary: '未知子 agent 类型', isError: true }),
      },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toBe('subagent: general | status: error\n\n未知子 agent 类型');
    expect(r.content).not.toContain('resume=');
  });
});

describe('终态事件的完整性与幂等（所有退出路径都发终态事件）', () => {
  /**
   * 回归依据：Claude Agent SDK 0.2.101 修过同类缺陷——后台任务被杀时 CLI 只发
   * task_updated{status:killed} 而不发 task_notification，只监听后者的消费方永久 hang。
   * 我们的 runner 曾同构：catch 分支只 persist + throw 不发 end，start 已发出但终态永不到达
   * （TUI 条目卡在运行中、stream-json 外部程序等不到收尾）。
   */
  it('异常冒泡出 runner 时仍发出 end 终态（不让消费方永久等待）', async () => {
    const events: SubagentProgressEvent[] = [];
    const { provider } = makeFakeProvider([{ textChunks: [], finalContent: [textBlock(LONG)] }]);
    const store = makeSubagentStore();
    // attachments 在 start 之后被 runAgent 使用，用它模拟运行中途基础设施抛错：
    // 异常会冒出 runner（不像 persist 内部有静默 catch）。
    Object.defineProperty(store, 'attachments', {
      get() {
        throw new Error('infra down');
      },
    });
    const run = createSubagentRunner(deps(provider, (_id, e) => events.push(e), { subagentStore: store }));
    await expect(run({ subagentType: 'general', prompt: '干活', depth: 0 })).rejects.toThrow('infra down');
    const ends = events.filter((e) => e.kind === 'end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ kind: 'end', isError: true });
    // 异常路径也带统计与说明，外部消费方不必读快照就知道发生了什么
    expect(ends[0]).toHaveProperty('summary');
    expect(ends[0]).toHaveProperty('toolUses');
    expect(ends[0]).toHaveProperty('durationMs');
  });

  it('正常成功路径 end 恰好一次，带 summary 与统计', async () => {
    const events: SubagentProgressEvent[] = [];
    const { provider } = makeFakeProvider([{ textChunks: [], finalContent: [textBlock(LONG)] }]);
    const run = createSubagentRunner(deps(provider, (_id, e) => events.push(e)));
    const r = await run({ subagentType: 'general', prompt: '干活', depth: 0 });
    expect(r.isError).toBe(false);
    const ends = events.filter((e) => e.kind === 'end');
    expect(ends).toHaveLength(1);
    // summary 与 runner 返回值同一份文本；sessionId 供消费方取回完整产出
    expect(ends[0]).toMatchObject({
      kind: 'end',
      isError: false,
      summary: r.summary,
      toolUses: 0,
      sessionId: r.sessionId,
    });
    expect(typeof (ends[0] as { durationMs?: number }).durationMs).toBe('number');
  });

  it('provider 持续失败的错误返回路径：end 恰好一次且标记错误', async () => {
    const events: SubagentProgressEvent[] = [];
    const { provider } = makeFakeProvider(Array.from({ length: 10 }, () => ({ throw: new Error('boom') })));
    const run = createSubagentRunner(deps(provider, (_id, e) => events.push(e)));
    const r = await run({ subagentType: 'general', prompt: '会失败的任务', depth: 0 });
    expect(r.isError).toBe(true);
    const ends = events.filter((e) => e.kind === 'end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ kind: 'end', isError: true, summary: r.summary });
  });

  it('每个子 agent 生命周期都以 start 开、以 end 收（多路径统一）', async () => {
    const check = async (behaviors: Parameters<typeof makeFakeProvider>[0]): Promise<void> => {
      const events: SubagentProgressEvent[] = [];
      const { provider } = makeFakeProvider(behaviors);
      const run = createSubagentRunner(deps(provider, (_id, e) => events.push(e)));
      await run({ subagentType: 'general', prompt: 'x', depth: 0 }).catch(() => undefined);
      const kinds = events.map((e) => e.kind);
      expect(kinds[0]).toBe('start');
      expect(kinds[kinds.length - 1]).toBe('end');
    };
    await check([{ textChunks: [], finalContent: [textBlock(LONG)] }]);
    await check(Array.from({ length: 10 }, () => ({ throw: new Error('boom') })));
  });

  it('工具调用被计数（toolUses 反映真实调用次数）', async () => {
    const events: SubagentProgressEvent[] = [];
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'nonexistent_tool', {})] },
      { textChunks: [], finalContent: [textBlock(LONG)] },
    ]);
    const run = createSubagentRunner(deps(provider, (_id, e) => events.push(e)));
    await run({ subagentType: 'general', prompt: '干活', depth: 0 });
    const end = events.find((e) => e.kind === 'end') as { toolUses?: number };
    expect(end.toolUses).toBe(1);
  });
});
