import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamicWorkflowError, runDynamicWorkflow } from '../../src/agent/dynamicWorkflow/runner.js';
import { Journal } from '../../src/agent/dynamicWorkflow/journal.js';
import { ScriptStore } from '../../src/agent/dynamicWorkflow/scriptStore.js';
import type { BackgroundManager } from '../../src/agent/background/manager.js';
import type { RunSubagentFn } from '../../src/agent/subagent/types.js';
import type { WorkflowStepEvent } from '../../src/agent/events.js';
import { dynamicWorkflowTool } from '../../src/tools/dynamicWorkflow.js';

const T = 30_000;

/** 成功 mock：summary 回显 prompt；prompt 含 'fail' 时终态失败。 */
const fakeRunner =
  (map: Record<string, string> = {}): RunSubagentFn =>
  async (req) => {
    if (req.prompt.includes('fail')) return { summary: '', isError: true };
    return { summary: map[req.prompt] ?? `结果:${req.prompt}`, isError: false };
  };

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'dwf-test-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const base = { maxConcurrent: 4, signal: undefined as AbortSignal | undefined };

describe('runDynamicWorkflow 三原语', () => {
  it('agent：返回子 agent 报告，脚本可拼接', { timeout: T }, async () => {
    const r = await runDynamicWorkflow({
      script: `const a = await agent('任务A'); return '拿到:' + a;`,
      runSubagent: fakeRunner(),
      ...base,
      cwd,
    });
    expect(r.report).toBe('拿到:结果:任务A');
    expect(r.agentsUsed).toBe(1);
  });

  it('parallel：并发 barrier，失败位 null，永不 reject', { timeout: T }, async () => {
    const r = await runDynamicWorkflow({
      script: `const ps = await parallel([() => agent('P1'), () => agent('fail-x'), () => agent('P3')]); return ps;`,
      runSubagent: fakeRunner(),
      ...base,
      cwd,
    });
    expect(JSON.parse(r.report)).toEqual(['结果:P1', null, '结果:P3']);
  });

  it('pipeline：某项失败掉 null 并跳过后续 stage，其他项不受影响', { timeout: T }, async () => {
    const seen: string[] = [];
    const runner: RunSubagentFn = async (req) => {
      seen.push(req.prompt);
      if (req.prompt === 's1:bad') return { summary: '', isError: true };
      return { summary: `结果:${req.prompt}`, isError: false };
    };
    const r = await runDynamicWorkflow({
      script: `return await pipeline(['good', 'bad'], (it) => agent('s1:' + it), (it) => agent('s2:' + it));`,
      runSubagent: runner,
      ...base,
      cwd,
    });
    expect(JSON.parse(r.report)).toEqual(['结果:s2:结果:s1:good', null]);
    // bad 项在 stage1 失败后不应再进 stage2
    expect(seen).not.toContain('s2:null');
    expect(seen.filter((p) => p.startsWith('s2:'))).toEqual(['s2:结果:s1:good']);
  });

  it('子 agent id 形如 dwf-<runId>-<n>', { timeout: T }, async () => {
    const ids: (string | undefined)[] = [];
    const runner: RunSubagentFn = async (req) => {
      ids.push(req.id);
      return { summary: 'ok', isError: false };
    };
    await runDynamicWorkflow({
      script: `await agent('A'); await agent('B'); return 'done';`,
      runSubagent: runner,
      ...base,
      cwd,
      runId: 'testrun',
    });
    expect(ids).toEqual(['dwf-testrun-1', 'dwf-testrun-2']);
  });
});

describe('护栏', () => {
  it('并发上限：三原语共享限制器', { timeout: T }, async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const runner: RunSubagentFn = async (req) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight -= 1;
      return { summary: `结果:${req.prompt}`, isError: false };
    };
    const r = await runDynamicWorkflow({
      script: `return await parallel([1,2,3,4,5].map((i) => () => agent('P' + i)));`,
      runSubagent: runner,
      maxConcurrent: 2,
      cwd,
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(JSON.parse(r.report)).toHaveLength(5);
  });

  it('agent 总数上限：超限向沙箱抛错，脚本不 catch 则 run 失败', { timeout: T }, async () => {
    const p = runDynamicWorkflow({
      script: `await agent('A'); await agent('B'); return 'unreachable';`,
      runSubagent: fakeRunner(),
      ...base,
      cwd,
      maxAgents: 1,
    });
    await expect(p).rejects.toThrow(/agent 总数上限/);
  });

  it('agent 总数上限：脚本可 catch 超限错误自救', { timeout: T }, async () => {
    const r = await runDynamicWorkflow({
      script: `
        await agent('A');
        try { await agent('B'); return 'no-throw'; }
        catch (e) { return 'caught:' + e.message; }
      `,
      runSubagent: fakeRunner(),
      ...base,
      cwd,
      maxAgents: 1,
    });
    expect(r.report).toContain('caught:');
    expect(r.report).toContain('上限');
  });

  it('max_agents 默认 100：第 101 个子 agent 触发上限', { timeout: T }, async () => {
    let calls = 0;
    const runner: RunSubagentFn = async (req) => {
      calls += 1;
      return { summary: `结果:${req.prompt}`, isError: false };
    };
    const p = runDynamicWorkflow({
      script: `for (let i = 0; i < 101; i++) await agent('A' + i); return 'unreachable';`,
      runSubagent: runner,
      ...base,
      cwd,
    });
    await expect(p).rejects.toThrow(/上限（100）/);
    expect(calls).toBe(100);
  });

  it('null 语义：子 agent 终态失败 agent() 返回 null 不抛错，脚本自行容错', { timeout: T }, async () => {
    const r = await runDynamicWorkflow({
      script: `const a = await agent('fail-task'); if (a === null) return '失败但被脚本接住'; return a;`,
      runSubagent: fakeRunner(),
      ...base,
      cwd,
    });
    expect(r.report).toBe('失败但被脚本接住');
  });
});

describe('记忆化与 resume', () => {
  it('记忆化：同 (prompt, subagentType) 重复调用命中缓存，不真跑', { timeout: T }, async () => {
    let calls = 0;
    const runner: RunSubagentFn = async (req) => {
      calls += 1;
      return { summary: `结果:${req.prompt}`, isError: false };
    };
    const r = await runDynamicWorkflow({
      script: `const a = await agent('same'); const b = await agent('same'); return [a, b];`,
      runSubagent: runner,
      ...base,
      cwd,
    });
    expect(calls).toBe(1);
    expect(r.journalHits).toBe(1);
    expect(JSON.parse(r.report)).toEqual(['结果:same', '结果:same']);
  });

  it('失败（null）结果不写 journal', { timeout: T }, async () => {
    const r = await runDynamicWorkflow({
      script: `await agent('ok-task'); await agent('fail-task'); return 'done';`,
      runSubagent: fakeRunner(),
      ...base,
      cwd,
      runId: 'jrnl',
    });
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(r.journalPath, 'utf-8');
    expect(text).toContain('ok-task');
    expect(text).not.toContain('fail-task');
  });

  it('resume：成功项走缓存瞬时返回，失败项真重跑', { timeout: T }, async () => {
    // 第一次：A 成功、B 失败（B 不写 journal）。
    const first = await runDynamicWorkflow({
      script: `const a = await agent('任务A'); const b = await agent('fail-任务B'); return [a, b];`,
      runSubagent: fakeRunner(),
      ...base,
      cwd,
      runId: 'resume-1',
    });
    expect(JSON.parse(first.report)).toEqual(['结果:任务A', null]);

    // 修复后第二次：B 不再失败；resume 预载缓存。
    const calls: string[] = [];
    const fixedRunner: RunSubagentFn = async (req) => {
      calls.push(req.prompt);
      return { summary: `修复:${req.prompt}`, isError: false };
    };
    const second = await runDynamicWorkflow({
      script: `const a = await agent('任务A'); const b = await agent('fail-任务B'); return [a, b];`,
      runSubagent: fixedRunner,
      ...base,
      cwd,
      resumeFromRunId: 'resume-1',
    });
    expect(calls).toEqual(['fail-任务B']); // 只有失败项真重跑
    expect(second.journalHits).toBe(1);
    expect(JSON.parse(second.report)).toEqual(['结果:任务A', '修复:fail-任务B']);
  });
});

describe('确定性与错误反馈', () => {
  it('prelude：Date.now 抛错', { timeout: T }, async () => {
    const p = runDynamicWorkflow({ script: `return Date.now();`, runSubagent: fakeRunner(), ...base, cwd });
    await expect(p).rejects.toThrow(/Date\.now/);
  });

  it('prelude：Math.random 抛错', { timeout: T }, async () => {
    const p = runDynamicWorkflow({ script: `return Math.random();`, runSubagent: fakeRunner(), ...base, cwd });
    await expect(p).rejects.toThrow(/Math\.random/);
  });

  it('prelude：无参 new Date() 抛错并提示从 args 传时间戳', { timeout: T }, async () => {
    const p = runDynamicWorkflow({ script: `return new Date();`, runSubagent: fakeRunner(), ...base, cwd });
    await expect(p).rejects.toThrow(/new Date\(\) 无参构造/);
  });

  it('prelude：Date() 调用形式抛错（永远返回当前时间）', { timeout: T }, async () => {
    const p = runDynamicWorkflow({ script: `return Date(0);`, runSubagent: fakeRunner(), ...base, cwd });
    await expect(p).rejects.toThrow(/Date\(\) 调用形式/);
  });

  it('prelude：带参 new Date(timestamp) 保留，instanceof 正常', { timeout: T }, async () => {
    const r = await runDynamicWorkflow({
      script: `const d = new Date(0); return [d.getTime(), d instanceof Date, Date.parse('1970-01-01T00:00:00Z')];`,
      runSubagent: fakeRunner(),
      ...base,
      cwd,
    });
    expect(JSON.parse(r.report)).toEqual([0, true, 0]);
  });

  it('语法错误：反馈含错误消息、栈、agent 数、journal 路径、runId', { timeout: T }, async () => {
    try {
      await runDynamicWorkflow({ script: `const x = ;`, runSubagent: fakeRunner(), ...base, cwd, runId: 'synerr' });
      expect.unreachable('应当抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(DynamicWorkflowError);
      const err = e as DynamicWorkflowError;
      expect(err.message).toContain('SyntaxError');
      expect(err.detail.runId).toBe('synerr');
      expect(err.detail.agentsUsed).toBe(0);
      expect(err.detail.journalPath).toContain('dwf-synerr.jsonl');
      expect(err.detail.stack).toBeTruthy();
    }
  });

  it('运行时异常：脚本 throw 的错误消息与栈回传', { timeout: T }, async () => {
    const p = runDynamicWorkflow({
      script: `throw new Error('脚本自己抛的');`,
      runSubagent: fakeRunner(),
      ...base,
      cwd,
    });
    await expect(p).rejects.toThrow(/脚本自己抛的/);
  });

  it('死循环被指令预算打断', { timeout: T }, async () => {
    const p = runDynamicWorkflow({
      script: `while (true) {}`,
      runSubagent: fakeRunner(),
      ...base,
      cwd,
      maxInstructions: 20_000,
    });
    await expect(p).rejects.toThrow(/中断|指令预算/);
  });

  it('脚本无 return 时给出提示而非 undefined', { timeout: T }, async () => {
    const r = await runDynamicWorkflow({ script: `const x = 1;`, runSubagent: fakeRunner(), ...base, cwd });
    expect(r.report).toContain('没有 return');
  });

  it('args 注入：脚本可读全局 args', { timeout: T }, async () => {
    const r = await runDynamicWorkflow({
      script: `return '主题:' + args.topic;`,
      args: { topic: '测试' },
      runSubagent: fakeRunner(),
      ...base,
      cwd,
    });
    expect(r.report).toBe('主题:测试');
  });

  it('console.log 进日志缓冲，不占报告', { timeout: T }, async () => {
    const r = await runDynamicWorkflow({
      script: `console.log('进度 1/2'); console.log('进度 2/2'); return 'done';`,
      runSubagent: fakeRunner(),
      ...base,
      cwd,
    });
    expect(r.report).toBe('done');
    expect(r.logs).toEqual(['进度 1/2', '进度 2/2']);
  });
});

describe('phase 阶段标记', () => {
  it('phase(title)：发 kind:phase 事件（带标题）并进 console 缓冲', { timeout: T }, async () => {
    const events: WorkflowStepEvent[] = [];
    const r = await runDynamicWorkflow({
      script: `phase('侦察'); await agent('A'); phase('汇总'); return 'done';`,
      runSubagent: fakeRunner(),
      ...base,
      cwd,
      onWorkflowStep: (info) => events.push(info),
    });
    expect(r.report).toBe('done');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'phase', title: '侦察' });
    expect(events[1]).toMatchObject({ kind: 'phase', title: '汇总' });
    expect(r.logs).toEqual(['[phase] 侦察', '[phase] 汇总']);
  });

  it('agent(..., {phase})：并行归属阶段发事件且同阶段去重，phase() 原语与 opts 共用通道', { timeout: T }, async () => {
    const events: WorkflowStepEvent[] = [];
    const r = await runDynamicWorkflow({
      script:
        `await parallel([() => agent('A', { phase: '调研' }), () => agent('B', { phase: '调研' })]);` +
        `await agent('C', { phase: '汇总' }); return 'done';`,
      runSubagent: fakeRunner(),
      ...base,
      cwd,
      onWorkflowStep: (info) => events.push(info),
    });
    expect(r.report).toBe('done');
    // 两个同阶段 agent 只发一次「调研」，切换到「汇总」再发一次。
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'phase', title: '调研' });
    expect(events[1]).toMatchObject({ kind: 'phase', title: '汇总' });
    // phase 行同时进日志缓冲（随工具输出进返回给模型的报告），同阶段去重与事件一致。
    expect(r.logs).toEqual(['[phase] 调研', '[phase] 汇总']);
  });
});

describe('budget 预算收紧', () => {
  it('budget({agents})：收紧本 run agent 上限，耗尽后 agent() 抛错', { timeout: T }, async () => {
    const p = runDynamicWorkflow({
      script: `budget({ agents: 1 }); await agent('A'); await agent('B'); return 'unreachable';`,
      runSubagent: fakeRunner(),
      ...base,
      cwd,
      maxAgents: 50,
    });
    await expect(p).rejects.toThrow(/上限（1）/);
  });

  it('budget({agents})：只能收紧不能放松', { timeout: T }, async () => {
    const p = runDynamicWorkflow({
      script: `budget({ agents: 2 }); budget({ agents: 99 }); for (let i = 0; i < 3; i++) await agent('A' + i); return 'unreachable';`,
      runSubagent: fakeRunner(),
      ...base,
      cwd,
    });
    await expect(p).rejects.toThrow(/上限（2）/);
  });

  it('budget({minutes})：收紧 wall-clock，耗尽后 agent() 抛错', { timeout: T }, async () => {
    let agentCalls = 0;
    const p = runDynamicWorkflow({
      script: `budget({ minutes: 0 }); await agent('A'); return 'unreachable';`,
      runSubagent: async () => {
        agentCalls += 1;
        return { summary: '不应到达', isError: false };
      },
      ...base,
      cwd,
    });
    // deadline 拦截有两层：runner.runOnce 的 agent() 前检查（「时间预算耗尽」）与
    // sandbox 泵循环/中断检查（「执行超时」）。负载高时后者可能先触发，语义同为
    // wall-clock 到点——本用例断言的是「deadline 强制生效、agent 不会真跑」，
    // 不是哪一层先抓到，故两种消息都接受。
    await expect(p).rejects.toThrow(/时间预算耗尽|执行超时/);
    expect(agentCalls).toBe(0);
  });

  it('budget 错误可被脚本 catch 自救', { timeout: T }, async () => {
    const r = await runDynamicWorkflow({
      script: `
        budget({ agents: 1 });
        await agent('A');
        try { await agent('B'); return 'no-throw'; }
        catch (e) { return 'caught:' + e.message; }
      `,
      runSubagent: fakeRunner(),
      ...base,
      cwd,
    });
    expect(r.report).toContain('caught:');
    expect(r.report).toContain('上限（1）');
  });
});

describe('schema 结构化输出', () => {
  const countSchema = { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] };

  it('成功：prompt 追加输出契约，返回解析后的对象（不是字符串）', { timeout: T }, async () => {
    const seen: string[] = [];
    const runner: RunSubagentFn = async (req) => {
      seen.push(req.prompt);
      return { summary: '{"count": 3}', isError: false };
    };
    const r = await runDynamicWorkflow({
      script: `
        const r = await agent('统计', { schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } });
        if (r === null) return 'null';
        return (typeof r === 'object' && r.count === 3) ? 'obj-ok' : 'bad:' + JSON.stringify(r);
      `,
      runSubagent: runner,
      ...base,
      cwd,
    });
    expect(r.report).toBe('obj-ok');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('输出契约');
    expect(seen[0]).toContain('JSON Schema');
  });

  it('纠正重试：首次不匹配带错误重试，第二次成功', { timeout: T }, async () => {
    const seen: string[] = [];
    let calls = 0;
    const runner: RunSubagentFn = async (req) => {
      calls += 1;
      seen.push(req.prompt);
      // 第一次给非法 JSON，第二次给合法 JSON
      return { summary: calls === 1 ? '这不是 JSON' : '{"count": 7}', isError: false };
    };
    const r = await runDynamicWorkflow({
      script: `const r = await agent('统计', { schema: ${JSON.stringify(countSchema)} }); return r === null ? 'null' : 'count:' + r.count;`,
      runSubagent: runner,
      ...base,
      cwd,
    });
    expect(r.report).toBe('count:7');
    expect(calls).toBe(2);
    expect(seen[1]).toContain('未通过校验');
  });

  it('校验失败重试 ≤2 次仍败：返回 null 由脚本容错', { timeout: T }, async () => {
    let calls = 0;
    const runner: RunSubagentFn = async () => {
      calls += 1;
      return { summary: '{"wrong": true}', isError: false };
    };
    const r = await runDynamicWorkflow({
      script: `const r = await agent('统计', { schema: ${JSON.stringify(countSchema)} }); return r === null ? 'got-null' : 'bad';`,
      runSubagent: runner,
      ...base,
      cwd,
    });
    expect(r.report).toBe('got-null');
    expect(calls).toBe(3); // 首次 + 2 次纠正
  });

  it('子 agent 终态失败：不重试直接 null', { timeout: T }, async () => {
    let calls = 0;
    const runner: RunSubagentFn = async () => {
      calls += 1;
      return { summary: '', isError: true };
    };
    const r = await runDynamicWorkflow({
      script: `const r = await agent('统计', { schema: ${JSON.stringify(countSchema)} }); return r === null ? 'got-null' : 'bad';`,
      runSubagent: runner,
      ...base,
      cwd,
    });
    expect(r.report).toBe('got-null');
    expect(calls).toBe(1);
  });
});

describe('ScriptStore 命名脚本', () => {
  it('存 / 取 / 列：save 后可 load 回原文，list 字典序返回条目', async () => {
    await ScriptStore.save(cwd, '体检', 'return 1;');
    await ScriptStore.save(cwd, 'alpha-scan', 'return 2;');
    expect(await ScriptStore.load(cwd, '体检')).toBe('return 1;');
    expect(await ScriptStore.list(cwd)).toEqual([
      { name: 'alpha-scan', description: undefined },
      { name: '体检', description: undefined },
    ]);
    // 落点正确
    expect(ScriptStore.filePathFor(cwd, 'alpha-scan')).toContain(path.join('.step-code', 'workflows'));
  });

  it('save_as 覆盖：同名再存即更新', async () => {
    await ScriptStore.save(cwd, 'job', 'return 1;');
    await ScriptStore.save(cwd, 'job', 'return 2;');
    expect(await ScriptStore.load(cwd, 'job')).toBe('return 2;');
  });

  it('非法名字拒绝保存（防路径穿越）', async () => {
    await expect(ScriptStore.save(cwd, '../escape', 'return 1;')).rejects.toThrow(/非法脚本名/);
    expect(await ScriptStore.load(cwd, '../escape')).toBeUndefined();
  });

  it('save 带 description 写首行注释；脚本已有首行注释则不重复写', async () => {
    await ScriptStore.save(cwd, 'job', 'return 1;', '每日 体检 脚本');
    expect(await ScriptStore.load(cwd, 'job')).toBe('// description: 每日 体检 脚本\nreturn 1;');
    await ScriptStore.save(cwd, 'job2', '// description: 已有描述\nreturn 2;', '新描述');
    expect(await ScriptStore.load(cwd, 'job2')).toBe('// description: 已有描述\nreturn 2;');
  });

  it('list 解析首行描述；无注释脚本只有名字', async () => {
    await ScriptStore.save(cwd, 'with-desc', '// description: 扫描全库\nreturn 1;');
    await ScriptStore.save(cwd, 'no-desc', 'return 2;');
    expect(await ScriptStore.list(cwd)).toEqual([
      { name: 'no-desc', description: undefined },
      { name: 'with-desc', description: '扫描全库' },
    ]);
  });

  it('工具：name 按名加载执行', { timeout: T }, async () => {
    await ScriptStore.save(cwd, 'job', `const a = await agent('存档任务'); return a;`);
    const r = await dynamicWorkflowTool.execute(
      { name: 'job' },
      { cwd, runSubagent: fakeRunner(), subagentMaxConcurrent: 4 },
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain('结果:存档任务');
  });

  it('工具：name 未命中返回错误并列出可用脚本名', { timeout: T }, async () => {
    await ScriptStore.save(cwd, 'existing-one', 'return 1;');
    const r = await dynamicWorkflowTool.execute({ name: 'missing' }, { cwd, runSubagent: fakeRunner() });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('未找到命名脚本「missing」');
    expect(r.content).toContain('existing-one');
  });

  it('工具：save_as 存本次 script，之后 name 可复用；同名覆盖', { timeout: T }, async () => {
    const ctx = { cwd, runSubagent: fakeRunner(), subagentMaxConcurrent: 4 };
    const r1 = await dynamicWorkflowTool.execute(
      { script: `return 'v1';`, save_as: 'job' },
      ctx,
    );
    expect(r1.isError).toBe(false);
    expect(r1.content).toContain('脚本已保存');
    expect(await ScriptStore.load(cwd, 'job')).toBe(`return 'v1';`);

    // 覆盖更新
    const r2 = await dynamicWorkflowTool.execute({ script: `return 'v2';`, save_as: 'job' }, ctx);
    expect(r2.isError).toBe(false);
    expect(await ScriptStore.load(cwd, 'job')).toBe(`return 'v2';`);

    // name 复用执行的是覆盖后的版本
    const r3 = await dynamicWorkflowTool.execute({ name: 'job' }, ctx);
    expect(r3.isError).toBe(false);
    expect(r3.content).toContain('v2');
  });

  it('工具：save_as 必须配 script', { timeout: T }, async () => {
    const r = await dynamicWorkflowTool.execute({ save_as: 'job' }, { cwd, runSubagent: fakeRunner() });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('save_as 必须配 script');
  });

  it('工具：零参数调用返回可用脚本列表（非错误），有脚本时列名', { timeout: T }, async () => {
    await ScriptStore.save(cwd, 'alpha-scan', 'return 1;');
    await ScriptStore.save(cwd, '体检', 'return 2;');
    const r = await dynamicWorkflowTool.execute({}, { cwd, runSubagent: fakeRunner() });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('alpha-scan');
    expect(r.content).toContain('体检');
    expect(r.content).toContain('.step-code');
    expect(r.content).toContain('save_as');
  });

  it('工具：零参数调用且无已存脚本时显示（无）', { timeout: T }, async () => {
    const r = await dynamicWorkflowTool.execute({}, { cwd, runSubagent: fakeRunner() });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('（无）');
  });

  it('工具：save_as 带 description 写首行注释，零参数列表按「名字 — 描述」展示', { timeout: T }, async () => {
    const ctx = { cwd, runSubagent: fakeRunner(), subagentMaxConcurrent: 4 };
    const r1 = await dynamicWorkflowTool.execute(
      { script: `return 'v1';`, save_as: 'job', description: '每日 体检 脚本' },
      ctx,
    );
    expect(r1.isError).toBe(false);
    expect(await ScriptStore.load(cwd, 'job')).toContain('// description: 每日 体检 脚本\n');

    const r2 = await dynamicWorkflowTool.execute({}, { cwd, runSubagent: fakeRunner() });
    expect(r2.isError).toBe(false);
    expect(r2.content).toContain('job — 每日 体检 脚本');
  });
});

describe('自动存档与 script_path', () => {
  it('运行后脚本存档到 journal/scripts/<runId>.js，内容一致，结果带 scriptPath', { timeout: T }, async () => {
    const script = `const a = await agent('任务A'); return a;`;
    const r = await runDynamicWorkflow({ script, runSubagent: fakeRunner(), ...base, cwd, runId: 'arch-1' });
    expect(r.scriptPath).toBe(Journal.scriptPathFor(cwd, 'arch-1'));
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(r.scriptPath, 'utf-8')).toBe(script);
  });

  it('失败 run 也存档，错误详情带 scriptPath', { timeout: T }, async () => {
    const script = `throw new Error('炸了');`;
    try {
      await runDynamicWorkflow({ script, runSubagent: fakeRunner(), ...base, cwd, runId: 'arch-fail' });
      expect.unreachable('应当抛错');
    } catch (e) {
      const err = e as DynamicWorkflowError;
      expect(err.detail.scriptPath).toBe(Journal.scriptPathFor(cwd, 'arch-fail'));
      const { readFile } = await import('node:fs/promises');
      expect(await readFile(err.detail.scriptPath, 'utf-8')).toBe(script);
    }
  });

  it('工具：script_path 从 cwd 内文件读脚本执行，结果含存档路径', { timeout: T }, async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(cwd, 'my-script.js'), `const a = await agent('文件任务'); return a;`, 'utf-8');
    const r = await dynamicWorkflowTool.execute(
      { script_path: 'my-script.js' },
      { cwd, runSubagent: fakeRunner(), subagentMaxConcurrent: 4 },
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain('结果:文件任务');
    expect(r.content).toContain('脚本存档');
  });

  it('工具：script_path 与 script 同给拒绝（歧义）', { timeout: T }, async () => {
    const r = await dynamicWorkflowTool.execute(
      { script: `return 1;`, script_path: 'x.js' },
      { cwd, runSubagent: fakeRunner() },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('歧义');
  });

  it('工具：script_path 越界 cwd 拒绝', { timeout: T }, async () => {
    const r = await dynamicWorkflowTool.execute(
      { script_path: '../outside.js' },
      { cwd, runSubagent: fakeRunner() },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('cwd 内');
  });

  it('工具：script_path 文件不存在 fail 并给出路径', { timeout: T }, async () => {
    const r = await dynamicWorkflowTool.execute(
      { script_path: 'no-such.js' },
      { cwd, runSubagent: fakeRunner() },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('不存在或读取失败');
    expect(r.content).toContain('no-such.js');
  });

  it('工具：script_path 与 resume_from_run_id 叠加（缓存命中，只真跑失败项）', { timeout: T }, async () => {
    // 第一次：A 成功、B 失败（B 不写 journal）。
    const first = await runDynamicWorkflow({
      script: `const a = await agent('任务A'); const b = await agent('fail-任务B'); return [a, b];`,
      runSubagent: fakeRunner(),
      ...base,
      cwd,
      runId: 'sp-resume',
    });
    expect(JSON.parse(first.report)).toEqual(['结果:任务A', null]);

    // 修复后的脚本写入文件，用 script_path + resume 重跑。
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      path.join(cwd, 'fixed.js'),
      `const a = await agent('任务A'); const b = await agent('fail-任务B'); return [a, b];`,
      'utf-8',
    );
    const calls: string[] = [];
    const fixedRunner: RunSubagentFn = async (req) => {
      calls.push(req.prompt);
      return { summary: `修复:${req.prompt}`, isError: false };
    };
    const r = await dynamicWorkflowTool.execute(
      { script_path: 'fixed.js', resume_from_run_id: 'sp-resume' },
      { cwd, runSubagent: fixedRunner, subagentMaxConcurrent: 4 },
    );
    expect(r.isError).toBe(false);
    expect(calls).toEqual(['fail-任务B']); // 只有失败项真重跑
    expect(r.content).toContain('缓存命中 1 次');
    expect(r.content).toContain('修复:fail-任务B');
  });

  it('工具：失败结果含脚本存档路径与 script_path 重跑指引', { timeout: T }, async () => {
    const r = await dynamicWorkflowTool.execute(
      { script: `throw new Error('炸了');` },
      { cwd, runSubagent: fakeRunner(), subagentMaxConcurrent: 4 },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('脚本存档');
    expect(r.content).toContain('script_path');
    expect(r.content).toContain('resume_from_run_id');
  });
});

describe('dynamic_workflow 工具', () => {
  it('工具名已回收为 dynamic_workflow', () => {
    expect(dynamicWorkflowTool.name).toBe('dynamic_workflow');
  });

  it('工具描述：含 parallel 反模式提示、filter(Boolean)、脚本发现路径等关键引导', () => {
    const d = dynamicWorkflowTool.description;
    expect(d).toContain('parallel');
    expect(d).toContain('反模式');
    expect(d).toContain('慢 N 倍');
    expect(d).toContain('.filter(Boolean)');
    expect(d).toContain('.step-code/workflows');
    expect(d).toContain('pipeline');
    expect(d).toContain('save_as');
    expect(d).toContain('resume_from_run_id');
  });

  it('max_agents 超硬顶 1000 拒绝', { timeout: T }, async () => {
    const r = await dynamicWorkflowTool.execute(
      { script: `return 1;`, max_agents: 1001 },
      { cwd, runSubagent: fakeRunner() },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('硬顶 1000');
  });

  it('成功：返回报告与 meta', { timeout: T }, async () => {
    const r = await dynamicWorkflowTool.execute(
      { script: `const a = await agent('调查'); return a;` },
      { cwd, runSubagent: fakeRunner(), subagentMaxConcurrent: 4 },
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain('dynamic_workflow 完成');
    expect(r.content).toContain('结果:调查');
  });

  it('失败：反馈含错误、journal 路径、resume 提示', { timeout: T }, async () => {
    const r = await dynamicWorkflowTool.execute(
      { script: `throw new Error('炸了');` },
      { cwd, runSubagent: fakeRunner(), subagentMaxConcurrent: 4 },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('炸了');
    expect(r.content).toContain('journal');
    expect(r.content).toContain('resume_from_run_id');
  });

  it('ctx 无 runSubagent 报不支持', { timeout: T }, async () => {
    const r = await dynamicWorkflowTool.execute({ script: `return 1;` }, { cwd });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('不支持');
  });

  it('run_in_background：startTask 被调、立即返回 task_id、label 用 description', { timeout: T }, async () => {
    let captured: Promise<{ output: string; ok: boolean }> | undefined;
    const startTask = vi.fn((_label: string, run: Promise<{ output: string; ok: boolean }>) => {
      captured = run;
      return 'task-j1';
    });
    const background = { startTask } as unknown as BackgroundManager;
    const r = await dynamicWorkflowTool.execute(
      { script: `return '报告';`, description: '批量 分析 任务', run_in_background: true },
      { cwd, runSubagent: fakeRunner(), background },
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain('task-j1');
    expect(startTask).toHaveBeenCalledTimes(1);
    expect(startTask.mock.calls[0]![0]).toBe('dynamic_workflow·批量 分析 任务');
    // 交出去的 promise 完成后产出 {output, ok}（manager 据此置终态）
    const settled = await captured!;
    expect(settled.ok).toBe(true);
    expect(settled.output).toContain('dynamic_workflow 完成');
  });

  it('run_in_background 但 ctx 无 background：fail 且不启动沙箱', { timeout: T }, async () => {
    const r = await dynamicWorkflowTool.execute(
      { script: `return 1;`, run_in_background: true },
      { cwd, runSubagent: fakeRunner() },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('不支持后台任务');
  });
});
