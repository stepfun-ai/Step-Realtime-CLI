/**
 * 长会话内存维度：折叠释放 + 单块事件累积窗口。
 *
 * 与 memoryGrowth.test.ts 的分工：那份测"流式帧"维度（每帧重渲不累积），这份测
 * "会话长度"维度——跑很多回合后，旧块是否真释放、子 agent 单卡事件是否无界。
 *
 * 背景：2026-08-16 跑 109 分钟堆到 4GB OOM。折叠/尾部窗口已落地，本份验证它们在
 * 长会话尺度下确实生效，并给 suspect 点加回归锁。
 */
import { describe, expect, it } from 'vitest';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transcript } from '../../src/tui-pi/Transcript.js';
import { ItemBlock } from '../../src/tui-pi/blocks.js';
import type { DisplayItem } from '../../src/chat/types.js';

function acquireGc(): (() => void) | undefined {
  if (typeof global.gc === 'function') return global.gc.bind(global);
  try {
    setFlagsFromString('--expose-gc');
    const fn = runInNewContext('gc') as unknown;
    return typeof fn === 'function' ? (fn as () => void) : undefined;
  } catch {
    return undefined;
  }
}
const gc = acquireGc();
const canGc = gc !== undefined;
function heapAfterGc(): number {
  gc!();
  gc!();
  return process.memoryUsage().heapUsed;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const piChat = readFileSync(join(repoRoot, 'src', 'tui-pi', 'PiChat.ts'), 'utf8');

/**  transcripts 行数：fold 后旧块坍缩，行数应显著回落。 */
function lineCount(t: Transcript): number {
  return t.render(80).length;
}

describe('长会话：折叠释放', () => {
  it('foldOldTurns 折掉旧块后，转录区行数回落（旧块被 foldSummary 替掉）', () => {
    const t = new Transcript();
    for (let i = 0; i < 100; i++) {
      t.push({ kind: 'user', text: `问题 ${i}` });
      t.push({ kind: 'assistant', text: '回复内容 '.repeat(100) });
      t.push({ kind: 'tool', id: `t${i}`, name: 'bash', input: { command: 'x' }, status: 'ok', result: '输出 '.repeat(100) });
    }
    const before = lineCount(t);
    expect(before).toBeGreaterThan(200); // 100 轮 × ~3 行
    // trigger=0 不设闸门：turn 一超 keepRecent 就折
    const result = t.foldOldTurns(5, 0);
    expect(result.folded).toBe(true);
    const after = lineCount(t);
    // foldOldTurns 只折 tool/thinking 大块（→foldSummary 1 行），保留 user/assistant 对话骨架。
    // 所以行数下降幅度 = 被折的 tool 大块行数，不会减半，但必然小于折前（100 个大结果块被替成摘要）。
    expect(after).toBeLessThan(before);
  });

  it.skipIf(!canGc)('折掉的大块被 dispose 释放：堆回落', () => {
    const t = new Transcript();
    for (let i = 0; i < 120; i++) {
      t.push({ kind: 'user', text: `问题 ${i}` });
      t.push({ kind: 'tool', id: `t${i}`, name: 'bash', input: { command: 'x' }, status: 'ok', result: 'x'.repeat(2000) });
    }
    heapAfterGc(); // 预热 + 稳定
    const before = heapAfterGc();
    t.foldOldTurns(5, 0);
    heapAfterGc();
    const after = heapAfterGc();
    // 折掉 115 个大结果块后，堆不应增长（释放的块可回收）。
    // 给 1MB 噪声空间，但绝不允许线性膨胀。
    expect(
      after - before,
      `折叠后堆增长 ${((after - before) / 1024 / 1024).toFixed(1)}MB——折掉的块未被释放，长会话会 OOM`,
    ).toBeLessThan(1 * 1024 * 1024);
  });

  it('折叠是幂等的：已折过的再折不重复计数', () => {
    const t = new Transcript();
    for (let i = 0; i < 50; i++) {
      t.push({ kind: 'user', text: `q${i}` });
      t.push({ kind: 'tool', id: `t${i}`, name: 'bash', input: {}, status: 'ok', result: 'o'.repeat(100) });
    }
    t.foldOldTurns(5, 0);
    const once = lineCount(t);
    t.foldOldTurns(5, 0);
    expect(lineCount(t)).toBe(once);
  });
});

describe('子 agent 单卡事件累积', () => {
  it('渲染只用最近 3 条事件（旧事件不占渲染开销）', () => {
    const manyEvents = Array.from({ length: 500 }, (_, i) => ({ name: `tool${i}`, status: 'ok' as const }));
    const item: DisplayItem = {
      kind: 'tool',
      id: 'sp1',
      name: 'spawn_agent',
      input: {},
      status: 'running',
      subagentToolUses: 500,
      subagentToolEvents: manyEvents,
    };
    const lines = new ItemBlock(item).render(80).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    // 500 条事件里只有最近 3 条（tool497/498/499）出现在渲染里
    const rendered = lines.join('\n');
    expect(rendered).toContain('tool499');
    expect(rendered).not.toContain('tool0\n');
  });

  it('接线断言：子 agent 事件累积有窗口上限（PiChat 不可实例化，锁源码）', () => {
    // 窗口常量 + tool/tool_end 两条累积路径都做窗口截断，防单卡无界 + O(n²) spread
    expect(piChat).toContain('SUBAGENT_EVENT_CAP');
    const toolBranch = piChat.slice(piChat.indexOf("ev.kind === 'tool'"), piChat.indexOf("ev.kind === 'tool_end'"));
    expect(toolBranch).toContain('SUBAGENT_EVENT_CAP');
    const endBranch = piChat.slice(piChat.indexOf("ev.kind === 'tool_end'"), piChat.indexOf("ev.kind === 'usage'"));
    expect(endBranch).toContain('SUBAGENT_EVENT_CAP');
  });
});
