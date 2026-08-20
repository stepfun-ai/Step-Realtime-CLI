/**
 * 窄终端全界面回归：40 列下每个界面组件 render 不得产出超宽行。
 *
 * 背景：超宽崩溃（`Rendered line N exceeds terminal width`）的修法是一个个组件补
 * `truncateToWidth`，属打地鼠——上次闭环后 resize 场景又复现过。pi-tui 的 doRender
 * 对超宽行直接 throw、进程崩溃，而终端宽度可变（拖拽、分屏），任何一条 render 路径
 * 漏截断就是一次崩溃。
 *
 * 与 widthOverflow.test.ts 的分工：那份测 ItemBlock/ActivityLine 的**自截断**（白盒，
 * 直接 render 断言）；这份把视角换成"窄终端下哪些**弹层组件**会崩"——审批三桥、
 * 选择器、查看器、tasks、provider 向导正是崩溃高发区（line 20/27/399 都来自弹层）。
 *
 * 反向红线：故意产出超宽行的坏组件必须被测出，否则这份测试是空绿。
 */
import { describe, expect, it } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { ItemBlock } from '../../src/tui-pi/blocks.js';
import { ActivityLine, StatusLine } from '../../src/tui-pi/StatusLine.js';
import { renderWelcome } from '../../src/tui-pi/blocks.js';
import { ChromePanels } from '../../src/tui-pi/ChromePanels.js';
import { InlineApproval, PlanApproval, QuestionPrompt } from '../../src/tui-pi/prompts.js';
import { PickerOverlay } from '../../src/tui-pi/pickers.js';
import { ExpandOverlay } from '../../src/tui-pi/ExpandOverlay.js';
import { TasksOverlay } from '../../src/tui-pi/TasksOverlay.js';
import { AgentsOverlay } from '../../src/tui-pi/AgentsOverlay.js';
import { collectExpandable } from '../../src/chat/expandable.js';
import type { DisplayItem } from '../../src/chat/types.js';
import type { AskUserRequest } from '../../src/tools/askUser.js';
import type { BackgroundTask } from '../../src/agent/background/manager.js';
import type { Component } from '@earendil-works/pi-tui';
import type { TodoItem } from '../../src/tools/types.js';

/** 崩溃重灾区宽度：40 列远窄于常见终端，任何漏截断都无处遁形。 */
const NARROW = [40, 45, 50];

function plain(lines: readonly string[]): string[] {
  // eslint-disable-next-line no-control-regex
  return lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/\]8;;[^\x07]*\x07/g, ''));
}

/** 断言组件在每个窄宽度下 render 的每一行可见宽度都不超过宽度。 */
function checkWidth(label: string, make: () => Component): void {
  for (const w of NARROW) {
    const comp = make();
    const lines = comp.render(w);
    for (let i = 0; i < lines.length; i++) {
      const vis = visibleWidth(lines[i]!);
      expect(vis, `${label} width=${w} line ${i} 可见宽度 ${vis} > ${w}`).toBeLessThanOrEqual(w);
    }
  }
}

const tool = (over: Partial<Extract<DisplayItem, { kind: 'tool' }>> = {}): DisplayItem => ({
  kind: 'tool',
  id: over.id ?? 't1',
  name: over.name ?? 'bash',
  input: over.input ?? { command: 'ls' },
  status: over.status ?? 'ok',
  result: over.result ?? 'line1\nline2',
  ...over,
});

const noop = (): void => {};

describe('窄终端：弹层组件 render 不超宽', () => {
  it('InlineApproval：超长命令 + 危险警告', () => {
    checkWidth('approval.longCmd', () => new InlineApproval('bash', { command: 'a'.repeat(300) }, noop, noop));
    checkWidth('approval.danger', () => new InlineApproval('bash', { command: 'rm -rf / ' + 'x'.repeat(300) }, noop, noop));
  });

  it('InlineApproval：50 行预览折叠态不超宽', () => {
    const content = Array.from({ length: 50 }, (_, i) => `第 ${i} 行内容 ` + 'z'.repeat(60)).join('\n');
    checkWidth('approval.preview', () => new InlineApproval('write_file', { path: 'x.txt', content }, noop, noop));
  });

  it('PlanApproval：超长 markdown 计划不超宽', () => {
    const plan = '# 计划\n\n' + Array.from({ length: 40 }, (_, i) => `## 步骤 ${i}\n` + '- 清单项 '.repeat(10)).join('\n');
    checkWidth('plan', () => new PlanApproval(plan, noop, noop));
  });

  it('QuestionPrompt：超长题干与选项不超宽', () => {
    const req: AskUserRequest = {
      questions: [
        {
          question: '超长题干 '.repeat(30),
          header: '长头部'.repeat(10),
          options: [{ label: '超长选项 '.repeat(20), description: '说明 '.repeat(20) }, { label: '普通选项' }],
        },
      ],
    };
    checkWidth('question', () => new QuestionPrompt(req, noop, noop));
  });

  it('PickerOverlay：超长 title/项/说明 + tab 模式', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      value: `v${i}`,
      label: '超长标签 '.repeat(8),
      description: '超长说明 '.repeat(8),
    }));
    checkWidth('picker.plain', () => new PickerOverlay({
      title: '超长标题 '.repeat(10),
      items,
      requestRender: noop,
      onSelect: noop,
      onCancel: noop,
    }));
    checkWidth('picker.tab', () => new PickerOverlay({
      title: '切换渠道',
      items,
      tabs: [
        { id: 'stepfun', label: 'StepFun 官方渠道长名' },
        { id: 'openai', label: 'OpenAI 兼容渠道长名' },
      ],
      itemsForTab: () => items,
      requestRender: noop,
      onSelect: noop,
      onCancel: noop,
    }));
  });

  it('ExpandOverlay：窄终端 render 出口不超宽', () => {
    const items: DisplayItem[] = [];
    for (let i = 0; i < 5; i++) {
      items.push({ kind: 'user', text: `问题 ${i} `.repeat(20) });
      items.push(tool({ id: `t${i}`, result: Array.from({ length: 30 }, (_, j) => `输出行 ${j} `.repeat(10)).join('\n') }));
    }
    for (const w of NARROW) {
      const overlay = new ExpandOverlay({
        groups: collectExpandable(items),
        width: 60,
        viewportRows: 8,
        entryRenderer: (item, width) => ItemBlock.renderExpanded(item, width),
        requestRender: noop,
        onClose: noop,
      });
      for (const l of overlay.render(w)) {
        expect(visibleWidth(l), `expand width=${w}`).toBeLessThanOrEqual(w);
      }
    }
  });

  it('TasksOverlay：超长任务 id/命令不超宽', () => {
    const tasks: BackgroundTask[] = [
      { id: '超长任务标识 '.repeat(15), command: 'a'.repeat(300), status: 'running', startedAt: '2026-08-19T10:00:00Z', output: '输出 '.repeat(100), kind: 'process' },
      { id: 't2', command: 'b'.repeat(300), status: 'done', exitCode: 0, startedAt: '2026-08-19T10:00:00Z', endedAt: '2026-08-19T10:01:00Z', output: '', kind: 'process' },
    ];
    checkWidth('tasks', () => new TasksOverlay({
      getTasks: () => tasks,
      stopTask: () => true,
      openOutput: noop,
      requestRender: noop,
      onClose: noop,
      now: () => Date.parse('2026-08-19T10:01:30Z'),
    }));

    // ④ 新增的 AgentsOverlay 必须进窄终端回归（否则新增组件漏截断 = 新的崩溃点）
    const agents = [
      { id: 'agent-run-001', cwd: '/w', model: 'm', createdAt: '2026-08-19T00:00:00Z', updatedAt: '2026-08-19T00:05:00Z', messageCount: 42, status: 'running', agentType: 'explore', name: '很长的子agent任务名称'.repeat(8) },
      { id: 'agent-done-002', cwd: '/w', model: 'm', createdAt: '2026-08-19T00:00:00Z', updatedAt: '2026-08-19T00:03:00Z', messageCount: 18, status: 'done', agentType: 'general', title: '已完成的代码修改任务' },
      { id: 'agent-err-003', cwd: '/w', model: 'm', createdAt: '2026-08-19T00:00:00Z', updatedAt: '2026-08-19T00:04:00Z', messageCount: 7, status: 'error', agentType: 'custom-reviewer', name: '审查失败的长任务' },
    ];
    checkWidth('agents', () => new AgentsOverlay({
      getAgents: () => agents,
      onBrowse: noop,
      requestRender: noop,
      onClose: noop,
    }));
  });

  it('ItemBlock 全类型窄终端不超宽', () => {
    const items: DisplayItem[] = [
      { kind: 'user', text: '长用户输入 '.repeat(30) },
      { kind: 'assistant', text: '长回复 '.repeat(40) },
      { kind: 'thinking', text: Array.from({ length: 15 }, (_, i) => `思考行 ${i} `.repeat(20)).join('\n\n') },
      { kind: 'note', text: '长提示 '.repeat(30) },
      { kind: 'error', text: '长错误 '.repeat(30) },
      tool({ id: 'long', result: '结果 '.repeat(200) }),
      { kind: 'cron', data: { id: 'c1', cron: '* * * * *', prompt: '长 prompt '.repeat(40), recurring: true, coalesced: 0 } },
    ];
    for (const it of items) checkWidth(`block.${it.kind}`, () => new ItemBlock(it));
  });

  it('ActivityLine：无空格长 token 预览被钳到窄宽度内', () => {
    const token = 'a'.repeat(500);
    checkWidth('activity.longToken', () => {
      const a = new ActivityLine();
      a.setBusy(true);
      a.setThinking(true, token);
      return a;
    });
  });
});

describe('反向红线：超宽必须被测出', () => {
  it('故意不截断的组件触发断言', () => {
    const bad: Component = { render: (w) => ['x'.repeat(w + 50)] };
    expect(() => checkWidth('bad', () => bad)).toThrow();
  });
});

describe('窄终端：剩余三件套（WelcomeBox / StatusLine / ChromePanels）', () => {
  it('WelcomeBox：超长 cwd/session/model/version 不超宽', () => {
    const data = {
      cwd: 'C:\\Users\\一个很长的用户名\\Documents\\projects\\'.repeat(4),
      sessionId: '20260819123456-abcdef0123456789',
      model: 'Water 18（内测）超长模型名'.repeat(5),
      version: '0.1.2 (abcdef0123456789 2026-08-19T06:12:21Z)',
    };
    for (const w of NARROW) {
      const lines = renderWelcome(data, w);
      for (let i = 0; i < lines.length; i++) {
        const vis = visibleWidth(lines[i]!);
        expect(vis, `welcome width=${w} line ${i} 可见宽度 ${vis} > ${w}`).toBeLessThanOrEqual(w);
      }
    }
  });

  it('StatusLine：全字段 + 超长 model/cwd/bgTask/goal 不超宽', () => {
    checkWidth('status.full', () => {
      const s = new StatusLine({
        mode: 'yolo',
        planMode: true,
        model: '超长模型名 '.repeat(10),
        thinking: 'high',
        busy: true,
        cwd: 'C:\\超长路径\\'.repeat(15),
        usedTokens: 243000,
        maxContextSize: 400000,
        hints: 'Enter 发送 · Esc 中断 · Ctrl+C 退出 · /help 命令',
        backgroundCount: 3,
        latestBgTask: '超长后台任务命令 '.repeat(10),
        queueLen: 5,
        goal: { status: 'active', turnsUsed: 12, turnBudget: 50, elapsedMs: 3600000 },
        teamActive: true,
      });
      // 设一个 spinner 帧，触发 render 的 spinner/elapsed 路径
      return s;
    });
  });

  it('ChromePanels：超长 todos + 超长 queue 不超宽', () => {
    checkWidth('chrome.full', () => {
      const c = new ChromePanels();
      c.setTodos([
        { text: '超长待办事项 '.repeat(15), status: 'in_progress' },
        { text: '另一条很长的待办 '.repeat(10), status: 'done' },
        { text: '第三条 '.repeat(8), status: 'pending' },
      ]);
      c.setQueue([
        '排队消息一 '.repeat(20),
        '排队消息二 '.repeat(15),
      ]);
      c.setBusy(true);
      return c;
    });
  });
});
