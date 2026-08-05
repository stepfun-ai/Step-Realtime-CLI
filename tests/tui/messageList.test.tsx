import React from 'react';
import chalk from 'chalk';
import { Box, Static, Text } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageItem, MessageList, ThinkingPreview, appendStreamText, countSettledItems, removePartialAssistant } from '../../src/tui/MessageList.js';
import type { DisplayItem } from '../../src/tui/types.js';
import type { DynamicWorkflowPanelState } from '../../src/tui/DynamicWorkflowPanel.js';

const user = (text: string): DisplayItem => ({ kind: 'user', text });
const assistant = (text: string): DisplayItem => ({ kind: 'assistant', text });
const note = (text: string): DisplayItem => ({ kind: 'note', text });
const thinking = (text: string): DisplayItem => ({ kind: 'thinking', text });
const tool = (id: string, status: 'running' | 'ok' | 'error', dynamicWorkflow?: DynamicWorkflowPanelState): DisplayItem => ({
  kind: 'tool',
  id,
  name: 'bash',
  input: {},
  status,
  startedAt: Date.now(),
  ...(dynamicWorkflow !== undefined ? { dynamicWorkflow } : {}),
});
const dwfState = (phaseStatus: 'running' | 'done'): DynamicWorkflowPanelState => ({
  name: 'dwf',
  phases: [{ title: 'p1', status: phaseStatus }],
});

describe('countSettledItems 定稿判定', () => {
  it('非 busy 时全部定稿（含 abort 残留的 running 工具，此后不会再有更新）', () => {
    const items = [user('u1'), assistant('a1'), tool('t1', 'running'), note('n1')];
    expect(countSettledItems(items, false)).toBe(items.length);
  });

  it('busy 时最后一条 streaming 中的 assistant 留动态区', () => {
    const items = [user('u1'), assistant('流式中')];
    expect(countSettledItems(items, true)).toBe(1);
  });

  it('busy 时 assistant 后面跟了条目即定稿（text 只往末尾追加，旧条不可能再增长）', () => {
    const items = [user('u1'), assistant('a1'), tool('t1', 'ok')];
    expect(countSettledItems(items, true)).toBe(3);
  });

  it('busy 时正文流完进入工具执行期：assistant 随前缀定稿，仅 running 工具留动态区', () => {
    // 长正文不再被窗口化压整轮，「已隐藏 N 行」在 tool_start 到来时即释放
    const items = [user('u1'), assistant('长正文'), tool('t1', 'running')];
    expect(countSettledItems(items, true)).toBe(2);
  });

  it('busy 时 running 工具及其后的条目全部留动态区', () => {
    const items = [user('u1'), tool('t1', 'running'), note('n1')];
    expect(countSettledItems(items, true)).toBe(1);
  });

  it('busy 时 dynamic_workflow 面板运行中的工具条目留动态区', () => {
    const items = [user('u1'), tool('t1', 'running', dwfState('running'))];
    expect(countSettledItems(items, true)).toBe(1);
  });

  it('busy 时终态工具（含 dynamic_workflow 已完成）可以定稿', () => {
    const items = [user('u1'), tool('t1', 'ok', dwfState('done')), tool('t2', 'error')];
    expect(countSettledItems(items, true)).toBe(items.length);
  });

  it('busy 时无 assistant 且无 running 工具：全部定稿', () => {
    const items = [user('u1'), note('n1'), tool('t1', 'ok')];
    expect(countSettledItems(items, true)).toBe(items.length);
  });

  it('busy 时 thinking 定稿条目可定稿（落成条目即完整，不再有更新）', () => {
    const items = [user('u1'), thinking('想完了'), assistant('流式中')];
    // 最后一条 streaming assistant 留动态区，thinking 随前缀定稿
    expect(countSettledItems(items, true)).toBe(2);
  });

  it('busy 时取 streaming assistant 与 running 工具中更靠前的下标', () => {
    const items = [user('u1'), tool('t1', 'running'), assistant('a1')];
    expect(countSettledItems(items, true)).toBe(1);
  });

  it('busy 时 assistant 后只跟 UI 侧提示（非 boundary note）：仍视为未闭合，留动态区', () => {
    // 队列回执等 UI 提示不构成消息边界，流式正文会越过它续接（见 appendStreamText）
    const items = [user('u1'), assistant('流式中'), note('已加入发送队列')];
    expect(countSettledItems(items, true)).toBe(1);
  });

  it('busy 时 boundary note（retry/notice/aborted）闭合前面的 assistant', () => {
    const items = [user('u1'), assistant('失败的残文'), { kind: 'note' as const, text: '重试中', boundary: true }];
    // assistant 已终结可定稿；boundary note 是静态内容一并定稿
    expect(countSettledItems(items, true)).toBe(3);
  });

  it('retry 过渡态：boundary note 进 Static、重试新正文留动态区（countSettledItems 边界）', () => {
    // retry 后 items = [user, boundary note, 新 assistant(流式中)]。
    // boundary note 之前的（含它）进 Static 定稿；正在流式的新 assistant 留动态区待更新。
    const items = [
      user('u1'),
      { kind: 'note' as const, text: '连接中断，重试', boundary: true },
      assistant('重发的正文（流式中）'),
    ];
    expect(countSettledItems(items, true)).toBe(2);
  });

  it('busy 时 running 工具后的 UI 提示透明：仍按 running 工具截断', () => {
    const items = [user('u1'), assistant('a1'), tool('t1', 'running'), note('已加入发送队列')];
    expect(countSettledItems(items, true)).toBe(2);
  });
});

describe('appendStreamText 流式正文追加', () => {
  it('末尾是 assistant：直接续写', () => {
    const out = appendStreamText([user('u1'), assistant('前半')], '后半');
    expect(out).toEqual([user('u1'), assistant('前半后半')]);
  });

  it('末尾是 UI 侧提示：越过提示续接上一条 assistant，提示位置不动', () => {
    const out = appendStreamText([assistant('前半'), note('已加入发送队列'), note('另一条提示')], '后半');
    expect(out).toEqual([assistant('前半后半'), note('已加入发送队列'), note('另一条提示')]);
  });

  it('末尾是 boundary note：另开新 assistant 条目（重试/通知后的正文属新消息）', () => {
    const out = appendStreamText([assistant('残文'), { kind: 'note' as const, text: '重试中', boundary: true }], '新正文');
    expect(out).toEqual([
      assistant('残文'),
      { kind: 'note' as const, text: '重试中', boundary: true },
      assistant('新正文'),
    ]);
  });

  it('UI 提示前是工具而非 assistant：另开新条目', () => {
    const t1 = tool('t1', 'ok');
    const out = appendStreamText([assistant('a1'), t1, note('提示')], '新消息');
    expect(out).toEqual([assistant('a1'), t1, note('提示'), assistant('新消息')]);
  });

  it('空列表：新建 assistant 条目', () => {
    expect(appendStreamText([], '开头')).toEqual([assistant('开头')]);
  });
});

describe('removePartialAssistant 撤回残文气泡（B 方案）', () => {
  it('末尾是 assistant 残文：移除该条目', () => {
    const out = removePartialAssistant([user('u1'), assistant('写了一半')]);
    expect(out).toEqual([user('u1')]);
  });

  it('残文后挂透明 note：连残文带透明 note 一并撤', () => {
    // 队列回执等 UI 提示挂在残文之后，撤回残文时一并清掉（它们属于这次失败的尝试）
    const out = removePartialAssistant([assistant('残文'), note('已加入发送队列'), note('另一条提示')]);
    expect(out).toEqual([]);
  });

  it('末尾是 boundary note：不撤（残文已被后续内容封口，防误删历史）', () => {
    const items = [assistant('残文'), { kind: 'note' as const, text: '重试中', boundary: true }];
    const out = removePartialAssistant(items);
    expect(out).toEqual(items);
  });

  it('末尾是工具：不撤（assistant 残文后已进入工具执行，残文属已定稿内容）', () => {
    const items = [assistant('a1'), tool('t1', 'ok')];
    const out = removePartialAssistant(items);
    expect(out).toEqual(items);
  });

  it('历史 assistant + 当前残文：只撤末尾残文，历史完整保留', () => {
    const out = removePartialAssistant([user('u1'), assistant('完整回复'), user('u2'), assistant('写了一半')]);
    expect(out).toEqual([user('u1'), assistant('完整回复'), user('u2')]);
  });

  it('空列表 / 末尾无 assistant：原样返回（无残文可撤）', () => {
    expect(removePartialAssistant([])).toEqual([]);
    const items = [user('u1'), note('提示')];
    expect(removePartialAssistant(items)).toEqual(items);
  });

  it('onRemoved 回调被撤正文字符数：撤回时同步扣减 token 估算（Bug 1 钉住）', () => {
    // 撤回残文后 turnOutputCharsRef 要扣掉被撤正文的字符数，否则 retry 延迟窗口
    // 状态栏 tok 估算仍算着被撤内容、虚高。onRemoved 传出被撤 assistant.text.length。
    let removed = -1;
    const out = removePartialAssistant([user('u1'), assistant('写了一半')], (n) => { removed = n; });
    expect(out).toEqual([user('u1')]);
    expect(removed).toBe('写了一半'.length);

    // 末尾无 assistant（无可撤）→ 不回调
    let called = false;
    removePartialAssistant([user('u1'), { kind: 'note', text: 'r', boundary: true }], () => { called = true; });
    expect(called).toBe(false);

    // 带透明 note：回调只算 assistant 正文，不含 note 字符
    let removed2 = -1;
    removePartialAssistant([assistant('残文'), note('提示')], (n) => { removed2 = n; });
    expect(removed2).toBe('残文'.length);
  });

  it('连续两次撤回（retry × 2）：每次撤回末尾新残文，历史完整保留', () => {
    // 第一次撤回后末尾是 boundary note；重试吐新残文（另开 assistant），第二次撤回仍正确定位。
    const after1 = removePartialAssistant([user('u1'), assistant('残文1')]);
    const withRetryNote = [...after1, { kind: 'note' as const, text: '重试中', boundary: true }];
    // 重试吐字：appendStreamText 遇 boundary note 另开新 assistant
    const withPartial2 = appendStreamText(withRetryNote, '残文2');
    expect(withPartial2).toEqual([user('u1'), { kind: 'note' as const, text: '重试中', boundary: true }, assistant('残文2')]);
    // 第二次撤回：只撤残文2，保留 user + 上次 boundary note
    const after2 = removePartialAssistant(withPartial2);
    expect(after2).toEqual([user('u1'), { kind: 'note' as const, text: '重试中', boundary: true }]);
  });
});

/** 去掉 ANSI 颜色码，便于对纯文本内容断言。 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('user 条目配色', () => {
  // vitest worker 非 TTY，chalk 默认 level 0 不输出 ANSI；这里临时开启 16 色再断言
  let prevLevel: number;
  beforeEach(() => {
    prevLevel = chalk.level;
    chalk.level = 1;
  });
  afterEach(() => {
    chalk.level = prevLevel;
  });

  it('user 条目正文带黄色 ANSI 码，› 前缀保持蓝色加粗', () => {
    const { lastFrame } = render(<MessageList items={[user('用户问题')]} />);
    const out = lastFrame() ?? '';
    // 正文黄色（ANSI 33m），直接包在正文外
    expect(out).toContain('\x1b[33m用户问题');
    // 前缀仍是蓝色（34m）加粗（1m），作为视觉锚点不变
    expect(out).toContain('› ');
    expect(out).toMatch(/\x1b\[(?:1m\x1b\[34m|34m\x1b\[1m)›/);
    // 去掉 ANSI 后内容本身完整
    expect(stripAnsi(out)).toContain('› 用户问题');
  });

  it('assistant 等其他条目不带黄色 ANSI 码', () => {
    const { lastFrame } = render(<MessageList items={[assistant('AI 回答')]} />);
    expect(lastFrame() ?? '').not.toContain('\x1b[33m');
  });
});

/** 模拟 App 根布局：单 <Static>（welcome 首条 + 定稿前缀）+ 动态区 MessageList。 */
function Harness({
  items,
  busy,
  epoch = 0,
}: {
  items: DisplayItem[];
  busy: boolean;
  epoch?: number;
}): React.ReactElement {
  const settledCount = countSettledItems(items, busy);
  const staticEntries: Array<{ kind: 'welcome' } | DisplayItem> = [
    { kind: 'welcome' },
    ...items.slice(0, settledCount),
  ];
  return (
    <Box flexDirection="column">
      <Static key={epoch} items={staticEntries}>
        {(entry, i) =>
          entry.kind === 'welcome' ? (
            <Text key="welcome">WELCOME-BANNER</Text>
          ) : (
            <MessageItem key={i} item={entry} expanded={false} />
          )
        }
      </Static>
      <MessageList items={items.slice(settledCount)} busy={busy} />
    </Box>
  );
}

/** 断言 out 中 keys 全部出现且按给定顺序。 */
function expectInOrder(out: string, keys: string[]): void {
  let prev = -1;
  for (const k of keys) {
    const idx = out.indexOf(k);
    expect(idx, `帧输出缺少 ${k}`).toBeGreaterThan(-1);
    expect(idx, `${k} 顺序错误`).toBeGreaterThan(prev);
    prev = idx;
  }
}

describe('Static 挂载后的帧输出', () => {
  it('全部定稿时：welcome + 全部历史按序出现在帧中，动态区为空', () => {
    const items = [user('问题一'), assistant('回答一'), note('提示一')];
    const { lastFrame } = render(<Harness items={items} busy={false} />);
    const out = lastFrame() ?? '';
    expectInOrder(out, ['WELCOME-BANNER', '问题一', '回答一', '提示一']);
  });

  it('busy 流式中：定稿前缀与在途尾部都可见且顺序正确', () => {
    const items = [user('问题一'), assistant('回答一'), user('问题二'), assistant('流式中')];
    const { lastFrame } = render(<Harness items={items} busy={true} />);
    const out = lastFrame() ?? '';
    expectInOrder(out, ['WELCOME-BANNER', '问题一', '回答一', '问题二', '流式中']);
  });

  it('流式结束（busy 转 false）后：全文按序保留在帧中', () => {
    const streaming = [user('问题一'), assistant('流式中')];
    const done = [user('问题一'), assistant('流式完毕'), note('回合结束')];
    const { lastFrame, rerender } = render(<Harness items={streaming} busy={true} />);
    rerender(<Harness items={done} busy={false} />);
    const out = lastFrame() ?? '';
    expectInOrder(out, ['WELCOME-BANNER', '问题一', '流式完毕', '回合结束']);
  });

  it('条目定稿前后的关键文案与顺序，和纯 MessageList 渲染一致', () => {
    const items = [user('问题一'), assistant('回答一'), note('提示一')];
    const plain = render(<MessageList items={items} busy={false} />).lastFrame() ?? '';
    const mounted = render(<Harness items={items} busy={false} />).lastFrame() ?? '';
    for (const k of ['问题一', '回答一', '提示一']) {
      expect(plain).toContain(k);
      expect(mounted).toContain(k);
    }
    expectInOrder(mounted, ['问题一', '回答一', '提示一']);
  });

  it('会话重置（epoch 重挂载）后：旧静态内容被丢弃，新条目正常进 Static', () => {
    const old = [note('旧会话提示')];
    const fresh = [note('新会话已开始')];
    const { lastFrame, rerender } = render(<Harness items={old} busy={false} epoch={0} />);
    rerender(<Harness items={fresh} busy={false} epoch={1} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('新会话已开始');
    expect(out).not.toContain('旧会话提示');
  });
});

describe('thinking 条目渲染', () => {
  it('≤5 行全部展示，不折叠', () => {
    const text = ['第一行', '第二行', '第三行', '第四行', '第五行'].join('\n');
    const { lastFrame } = render(<MessageList items={[thinking(text)]} />);
    const out = stripAnsi(lastFrame() ?? '');
    for (const l of ['第一行', '第二行', '第三行', '第四行', '第五行']) {
      expect(out).toContain(l);
    }
    expect(out).not.toContain('共');
  });

  it('>5 行折叠：只显示前 5 行 + 「…（共 N 行）」', () => {
    const text = Array.from({ length: 8 }, (_, i) => `第${i + 1}行`).join('\n');
    const { lastFrame } = render(<MessageList items={[thinking(text)]} />);
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('第5行');
    expect(out).not.toContain('第6行');
    expect(out).toContain('…（共 8 行 · Ctrl+O 查看）');
  });
});

describe('thinking 条目配色（暗色斜体）', () => {
  // vitest worker 非 TTY，chalk 默认 level 0 不输出 ANSI；这里临时开启 16 色再断言
  let prevLevel: number;
  beforeEach(() => {
    prevLevel = chalk.level;
    chalk.level = 1;
  });
  afterEach(() => {
    chalk.level = prevLevel;
  });

  it('定稿块带灰色（90m）与斜体（3m）ANSI 码', () => {
    const { lastFrame } = render(<MessageList items={[thinking('想了一下')]} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('\x1b[90m');
    expect(out).toContain('\x1b[3m');
    expect(stripAnsi(out)).toContain('想了一下');
  });
});

describe('ThinkingPreview 流式预览', () => {
  it('显示「思考中…」+ 思考文本（短文本全显）', () => {
    const { lastFrame } = render(<ThinkingPreview text={'推理中'} />);
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('思考中…');
    expect(out).toContain('推理中');
  });

  it('文本为空（无痕思考）只出「思考中…」标题，不出空白正文行', () => {
    const { lastFrame } = render(<ThinkingPreview text={''} maxLines={0} />);
    const out = stripAnsi(lastFrame() ?? '').replace(/\n+$/, '');
    expect(out).toBe('思考中…');
  });

  it('长文本只保留尾部 3 行（滚动预览）', () => {
    const text = ['AA', 'BB', 'CC', 'DD', 'EE', 'FF', 'GG', 'HH', 'II', 'JJ'].join('\n');
    const { lastFrame } = render(<ThinkingPreview text={text} />);
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('思考中…');
    for (const l of ['HH', 'II', 'JJ']) expect(out).toContain(l);
    expect(out).not.toContain('GG');
    expect(out).not.toContain('AA');
  });
});


describe('MessageItem user 条目排版（防 squash 回归）', () => {
  it('长行折行：「› 」空格保留，续行保持 2 列悬挂缩进', () => {
    // 两个 Text 兄弟会被 Ink squash 成一个文本块统一折行，前缀尾空格落在断行点时被吞、
    // 续行只剩 1 空格；包 Box 后正文在自己的盒子里折行，缩进稳定
    const { lastFrame } = render(<MessageItem item={user('输'.repeat(120))} expanded={false} />);
    const lines = (lastFrame() ?? '').split('\n').filter((l) => l.includes('输'));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toMatch(/^› 输/);
    expect(lines[1]).toMatch(/^ {2}输/);
  });

  it('多行文本：续行保持 2 列悬挂缩进', () => {
    const { lastFrame } = render(<MessageItem item={user('第一行内容\n第二行内容')} expanded={false} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('› 第一行内容');
    expect(out).toContain('  第二行内容');
  });
});
