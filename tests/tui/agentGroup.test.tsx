import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { AgentGroup, agentGroupRows, formatAgentGroupSummary, formatDetachedHandoff, type SubagentProgress } from '../../src/tui/AgentGroup.js';
import { I18N_TABLES } from '../../src/i18n.js';

// 期望串从中文 i18n 表按键构造，避免硬编码文案：改措辞或新增 locale 时测试随字典走，不静默失效。
// 这些断言测的是「渲染逻辑/结构」（计数、树形、状态符），不是中文措辞本身，故引用字典而非字面量。
const zh = I18N_TABLES.zh;
/** 模板变量替换，与 src/i18n.ts 的 t() 行为一致（{key} → 值）。 */
function fmt(key: string, vars?: Record<string, string | number>): string {
  let s = zh[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

describe('AgentGroup 面板', () => {
  it('多个并行子 agent 显示并行计数与各状态', () => {
    const { lastFrame } = render(
      React.createElement(AgentGroup, {
        agents: [
          { id: '1', type: 'explore', description: '统计 a.txt', status: 'done', toolCount: 3, startedAt: 0, endedAt: 3000 },
          { id: '2', type: 'explore', description: '统计 b.txt', status: 'running', toolCount: 1, activity: 'grep', startedAt: Date.now() },
          { id: '3', type: 'explore', description: '统计 c.txt', status: 'queued', toolCount: 0, startedAt: Date.now() },
        ],
      }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('并行子 agent'); // manyRunning 前缀无变量，字面比对结构关键词
    expect(out).toContain('3 个');
    expect(out).toContain('统计 b.txt');
    expect(out).toContain('grep');
  });

  it('多个并行子 agent 全部完成显示汇总', () => {
    const { lastFrame } = render(
      React.createElement(AgentGroup, {
        agents: [
          { id: '1', type: 'explore', description: 'a', status: 'done', toolCount: 2, startedAt: 0, endedAt: 1000 },
          { id: '2', type: 'explore', description: 'b', status: 'done', toolCount: 1, startedAt: 0, endedAt: 1000 },
        ],
      }),
    );
    expect(lastFrame() ?? '').toContain('并行子 agent 完成'); // manyDone 无变量前缀（「：N 个」为变量段）
  });

  it('单个子 agent 显示「子 agent 运行中」（不含并行/蜂群措辞）', () => {
    const { lastFrame } = render(
      React.createElement(AgentGroup, {
        agents: [{ id: '1', type: 'explore', description: '搜索', status: 'running', toolCount: 1, activity: 'grep', startedAt: Date.now() }],
      }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain(fmt('agentGroup.header.singleRunning'));
    expect(out).not.toContain('蜂群');
    expect(out).not.toContain('并行');
  });

  it('空列表不渲染', () => {
    const { lastFrame } = render(React.createElement(AgentGroup, { agents: [] }));
    expect(lastFrame() ?? '').toBe('');
  });

  it('行格式：tools · 时长 · tok 三段（分钟级带秒、千进制 tok）', () => {
    // startedAt 留 800ms 余量：满负载并跑时渲染延迟不跨秒界（500ms 曾在全量运行下抖动）
    const { lastFrame } = render(
      React.createElement(AgentGroup, {
        agents: [
          { id: '1', type: 'explore', description: '统计代码结构', status: 'running', toolCount: 14, startedAt: Date.now() - 148_200, tokens: 107_000 },
        ],
      }),
    );
    expect(lastFrame() ?? '').toContain('14 tools · 2m 28s · 107k tok');
  });

  it('tokens 为 0 / 缺省不显示 tok 段', () => {
    const { lastFrame } = render(
      React.createElement(AgentGroup, {
        agents: [
          { id: '1', type: 'explore', description: 'a', status: 'running', toolCount: 3, startedAt: Date.now() - 5_200, tokens: 0 },
          { id: '2', type: 'explore', description: 'b', status: 'running', toolCount: 1, startedAt: Date.now() - 5_200 },
        ],
      }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('3 tools · 5s');
    expect(out).toContain('1 tools · 5s');
    expect(out).not.toContain('tok');
  });

  it('终态行显示定格时长（endedAt − startedAt），不随渲染时刻跳动', () => {
    const { lastFrame } = render(
      React.createElement(AgentGroup, {
        agents: [
          { id: '1', type: 'explore', description: 'a', status: 'done', toolCount: 2, startedAt: 1_000, endedAt: 46_000, tokens: 2500 },
        ],
      }),
    );
    expect(lastFrame() ?? '').toContain('2 tools · 45s · 2.5k tok ●');
  });
});

describe('agentGroupRows（渲染行数 ↔ 高度预算的一致性）', () => {
  // 面板漏算 1 行即让动态帧越过 rows−1 红线，Ink 走全量清屏（\x1b[3J）清掉 scrollback，
  // 用户向上滚动被拽回顶部。用真实渲染帧行数校验公式，公式或渲染任一侧漂移都会被抓住。
  //
  // marginTop={1} 会渲染成帧内首行空行，已含在 lastFrame 行数里，故两侧直接相等。
  function renderedRows(agents: SubagentProgress[]): number {
    const { lastFrame } = render(React.createElement(AgentGroup, { agents }));
    return (lastFrame() ?? '').split('\n').length;
  }

  const cases: Array<{ name: string; agents: SubagentProgress[] }> = [
    {
      name: '单个 running 带 activity（含 Ctrl+B 提示行）',
      agents: [
        { id: '1', type: 'explore', description: '搜索', status: 'running', toolCount: 1, activity: 'grep', startedAt: Date.now() },
      ],
    },
    {
      name: '单个 running 无 activity',
      agents: [{ id: '1', type: 'explore', description: '搜索', status: 'running', toolCount: 1, startedAt: Date.now() }],
    },
    {
      name: '全终态（无 Ctrl+B 提示行）',
      agents: [
        { id: '1', type: 'explore', description: 'a', status: 'done', toolCount: 2, startedAt: 0, endedAt: 1000 },
        { id: '2', type: 'explore', description: 'b', status: 'error', toolCount: 1, startedAt: 0, endedAt: 1000 },
      ],
    },
    {
      name: '混合态：running 带 activity + queued + done',
      agents: [
        { id: '1', type: 'explore', description: 'a', status: 'done', toolCount: 3, startedAt: 0, endedAt: 3000 },
        { id: '2', type: 'explore', description: 'b', status: 'running', toolCount: 1, activity: 'grep', startedAt: Date.now() },
        { id: '3', type: 'explore', description: 'c', status: 'queued', toolCount: 0, startedAt: Date.now() },
      ],
    },
    {
      name: '多个 running 各带 activity',
      agents: [
        { id: '1', type: 'explore', description: 'a', status: 'running', toolCount: 1, activity: 'grep', startedAt: Date.now() },
        { id: '2', type: 'general', description: 'b', status: 'running', toolCount: 2, activity: 'read_file', startedAt: Date.now() },
      ],
    },
  ];

  for (const { name, agents } of cases) {
    it(`${name}：预算行数 == 实测渲染行数`, () => {
      expect(agentGroupRows(agents)).toBe(renderedRows(agents));
    });
  }

  it('空列表：0 行（面板不渲染）', () => {
    expect(agentGroupRows([])).toBe(0);
  });

  it('running 条目存在时比全终态多算一行（Ctrl+B 转后台提示）', () => {
    const running: SubagentProgress[] = [
      { id: '1', type: 'explore', description: 'a', status: 'running', toolCount: 1, startedAt: 0 },
    ];
    const done: SubagentProgress[] = [
      { id: '1', type: 'explore', description: 'a', status: 'done', toolCount: 1, startedAt: 0, endedAt: 1000 },
    ];
    expect(agentGroupRows(running) - agentGroupRows(done)).toBe(1);
  });
});

describe('formatDetachedHandoff（转入后台的交接记录）', () => {
  // 面板只承载前台在跑的子 agent，回合收尾即撤下；仍在运行的条目是转后台继续跑，
  // 不是结束。没有这条记录就表现为「回答一结束，进度和 token 凭空消失」。
  const running: SubagentProgress[] = [
    { id: '1', type: 'explore', description: '调研 A', status: 'running', toolCount: 4, startedAt: Date.now() - 12_000, tokens: 8200 },
    { id: '2', type: 'general', description: '改造 B', status: 'running', toolCount: 2, startedAt: Date.now() - 12_000 },
  ];

  it('交代去向：数量 + 后续查看入口（bg 徽章 / tasks）', () => {
    const text = formatDetachedHandoff(running);
    expect(text).toContain('2 个子 agent');
    expect(text).toContain('后台');
    expect(text).toContain('/tasks');
  });

  it('逐条保留身份与已用量（类型 · 描述 · tools · 时长 · tok）', () => {
    const lines = formatDetachedHandoff(running).split('\n');
    expect(lines).toHaveLength(3); // 头部 + 2 条
    expect(lines[1]).toContain('explore');
    expect(lines[1]).toContain('调研 A');
    expect(lines[1]).toContain('4 tools');
    expect(lines[1]).toContain('8.2k tok'); // 已消耗 token 必须留痕，撤面板前定格
    expect(lines[2]).toContain('改造 B');
    expect(lines[2]).not.toContain('tok'); // 无 token 的条目不显示空段
  });

  it('树形分支符号：末条用 └─，其余 ├─', () => {
    const lines = formatDetachedHandoff(running).split('\n');
    expect(lines[1]?.startsWith('├─')).toBe(true);
    expect(lines[2]?.startsWith('└─')).toBe(true);
  });

  it('单条：直接用 └─，计数为 1', () => {
    const text = formatDetachedHandoff([running[0]!]);
    expect(text).toContain('1 个子 agent');
    expect(text.split('\n')[1]?.startsWith('└─')).toBe(true);
  });
});

describe('formatAgentGroupSummary（全终态冻结进历史的摘要）', () => {
  it('多个子 agent：头部计数 + 逐条树形行', () => {
    const text = formatAgentGroupSummary([
      { id: '1', type: 'explore', description: '统计 a.txt', status: 'done', toolCount: 3, startedAt: 0, endedAt: 3000 },
      { id: '2', type: 'coder', description: '改 b.ts', status: 'done', toolCount: 5, startedAt: 0, endedAt: 3000 },
    ]);
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(fmt('agentGroup.header.manyDone', { total: 2, failed: '' }));
    expect(lines[1]).toContain(`├─ explore · 统计 a.txt · 3 tools · 3s · ✓ ${zh['agentGroup.status.done']}`);
    expect(lines[2]).toContain(`└─ coder · 改 b.ts · 5 tools · 3s · ✓ ${zh['agentGroup.status.done']}`);
  });

  it('含失败：头部带失败计数，失败行用 ✗', () => {
    const text = formatAgentGroupSummary([
      { id: '1', type: 'explore', description: 'a', status: 'done', toolCount: 1, startedAt: 0, endedAt: 1000 },
      { id: '2', type: 'explore', description: 'b', status: 'error', toolCount: 2, startedAt: 0, endedAt: 1000 },
    ]);
    expect(text).toContain(fmt('agentGroup.header.manyDone', { total: 2, failed: fmt('agentGroup.failedSuffix', { count: 1 }) }));
    expect(text).toContain(`✗ ${zh['agentGroup.status.error']}`);
  });

  it('单个子 agent：用单数头部，无并行措辞', () => {
    const text = formatAgentGroupSummary([
      { id: '1', type: 'explore', description: '搜索', status: 'done', toolCount: 4, startedAt: 0, endedAt: 3000 },
    ]);
    expect(text).toContain(`✓ ${fmt('agentGroup.header.singleDone', { failed: '' })}`);
    expect(text).not.toContain('并行');
    expect(text).toContain(`└─ explore · 搜索 · 4 tools · 3s · ✓ ${zh['agentGroup.status.done']}`);
  });

  it('摘要带定格时长与最终 tokens（可回看的定稿记录）', () => {
    const text = formatAgentGroupSummary([
      { id: '1', type: 'explore', description: '统计 a.txt', status: 'done', toolCount: 14, startedAt: 0, endedAt: 148_000, tokens: 107_000 },
    ]);
    expect(text).toContain(`14 tools · 2m 28s · 107k tok · ✓ ${zh['agentGroup.status.done']}`);
  });
});
