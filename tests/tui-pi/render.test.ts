/**
 * pi-tui 前端的渲染层测试。
 *
 * 上游 @earendil-works/pi-tui@0.84.1 没有导出 VirtualTerminal（设计文档写的那个测试方案
 * 不成立，见「待确认项实测结论」第四条），所以这里自己实现 Terminal 接口：收集写入的字节，
 * 直接对差分渲染的输出做断言。这比读 xterm 屏幕缓冲更贴近要验证的东西——我们关心的是
 * 「有没有发清屏序列」，而不是「屏幕最终长什么样」。
 */
import chalk from 'chalk';
import { describe, expect, it } from 'vitest';
import { TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui';
import type { Terminal } from '@earendil-works/pi-tui';
import { Transcript } from '../../src/tui-pi/Transcript.js';
import { ItemBlock } from '../../src/tui-pi/blocks.js';
import { ActivityLine, StatusLine, formatCount, shortenPath } from '../../src/tui-pi/StatusLine.js';
import { subagentStats } from '../../src/tui-pi/blocks.js';
import { ChatEditor } from '../../src/tui-pi/ChatEditor.js';
import type { DisplayItem } from '../../src/chat/types.js';

/** 清 scrollback 的序列：CSI 3J。差分渲染的全量重绘路径才会发它。 */
const CLEAR_SCROLLBACK = '\x1b[3J';

class FakeTerminal implements Terminal {
  columns = 80;
  rows = 24;
  readonly writes: string[] = [];
  kittyProtocolActive = false;
  private onInput: ((data: string) => void) | undefined;

  start(onInput: (data: string) => void): void {
    this.onInput = onInput;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  /** 测试驱动输入。 */
  send(data: string): void {
    this.onInput?.(data);
  }
  allOutput(): string {
    return this.writes.join('');
  }
  reset(): void {
    this.writes.length = 0;
  }
}

function plain(lines: readonly string[]): string[] {
  // eslint-disable-next-line no-control-regex
  return lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
}

describe('ItemBlock 渲染', () => {
  it('欢迎框：logo + 四行元信息在圆角框内', () => {
    const w = new ItemBlock({
      kind: 'welcome',
      data: { cwd: '/proj/demo', sessionId: 'abc123', model: 'step-3.7', version: '0.1.2' },
    });
    const lines = plain(w.render(80));
    expect(lines[0]).toMatch(/^╭─+╮$/);
    expect(lines.some((l) => l.includes('│ / __|'))).toBe(true);
    expect(lines.some((l) => l.includes('Welcome to Step Code!'))).toBe(true);
    expect(lines.some((l) => l.includes('Directory: /proj/demo'))).toBe(true);
    expect(lines.some((l) => l.includes('Model:     step-3.7'))).toBe(true);
    expect(lines[lines.length - 2]).toMatch(/^╰─+╯$/);
    // 窄终端不爆宽：每行可视宽度 ≤ width
    for (const l of w.render(30)) expect(visibleWidth(l)).toBeLessThanOrEqual(30);
  });

  it('用户消息带竖线前缀，助手正文走 markdown', () => {
    const user = new ItemBlock({ kind: 'user', text: '帮我改个文件' });
    expect(plain(user.render(40))[0]).toBe('│ 帮我改个文件');
    const asst = new ItemBlock({ kind: 'assistant', text: '**好**' });
    expect(plain(asst.render(40)).join('\n')).toContain('好');
  });

  it('成功的工具输出整段折叠成一行，diff 完整展示', () => {
    const ok = new ItemBlock({
      kind: 'tool',
      id: 't1',
      name: 'read_file',
      input: { path: 'src/a.ts' },
      status: 'ok',
      result: 'a\nb\nc',
    });
    const okLines = plain(ok.render(60));
    expect(okLines[0]).toContain('read_file');
    expect(okLines[0]).toContain('src/a.ts');
    expect(okLines.join('\n')).toContain('3 行');

    const diff = new ItemBlock({
      kind: 'tool',
      id: 't2',
      name: 'edit_file',
      input: { path: 'src/a.ts' },
      status: 'ok',
      result: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new',
    });
    const diffLines = plain(diff.render(60)).join('\n');
    expect(diffLines).toContain('-old');
    expect(diffLines).toContain('+new');
  });

  it('错误输出只预览前 4 行，其余折叠计数', () => {
    const err = new ItemBlock({
      kind: 'tool',
      id: 't3',
      name: 'bash',
      input: { command: 'npm test' },
      status: 'error',
      result: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'].join('\n'),
    });
    const lines = plain(err.render(60)).join('\n');
    expect(lines).toContain('e4');
    expect(lines).not.toContain('e5');
    expect(lines).toContain('还有 2 行');
  });

  it('内容未变时复用缓存数组（同一引用），换内容后失效', () => {
    const b = new ItemBlock({ kind: 'assistant', text: 'x' });
    const first = b.render(40);
    expect(b.render(40)).toBe(first);
    b.setItem({ kind: 'assistant', text: 'xy' });
    expect(b.render(40)).not.toBe(first);
  });
});

describe('Transcript 安全阀裁剪', () => {
  function pushTurns(t: Transcript, turns: number): void {
    for (let i = 0; i < turns; i++) {
      t.push({ kind: 'user', text: `u${i}` });
      t.push({ kind: 'assistant', text: `a${i}` });
    }
  }

  it('默认不裁剪：几百轮历史全部保留（裁剪代价见下方 scrollback 用例）', () => {
    const t = new Transcript();
    pushTurns(t, 300);
    expect(t.size()).toBe(600);
    expect(plain(t.render(40)).join('\n')).not.toContain('已从屏幕折叠');
  });

  it('显式设低阈值时才裁剪，超过 maxTurns + 迟滞后保留最近若干轮并给出折叠提示', () => {
    const t = new Transcript({ maxTurns: 15 });
    pushTurns(t, 66);
    // 15 + 50 迟滞 = 65，第 66 轮触发：丢最老 51 轮，保留 15 轮 × 2 块
    expect(t.size()).toBe(30);
    const out = plain(t.render(40)).join('\n');
    expect(out).toContain('更早的 51 轮已从屏幕折叠');
    expect(out).not.toContain('u0');
    expect(out).toContain('u65');
  });

  it('单轮内块数超上限时丢弃靠前的块，保留 user 本体', () => {
    const t = new Transcript({ maxBlocksPerTurn: 40 });
    t.push({ kind: 'user', text: '一个长回合' });
    for (let i = 0; i < 45; i++) {
      t.push({ kind: 'tool', id: `t${i}`, name: 'bash', input: {}, status: 'ok', result: 'x' });
    }
    const out = plain(t.render(60)).join('\n');
    expect(out).toContain('一个长回合');
    expect(out).toContain('个条目已折叠');
    expect(t.size()).toBeLessThanOrEqual(41);
  });

  it('updateLastWhere 回填工具状态', () => {
    const t = new Transcript();
    t.push({ kind: 'tool', id: 'x1', name: 'bash', input: {}, status: 'running' });
    const hit = t.updateLastWhere(
      (it) => it.kind === 'tool' && it.id === 'x1',
      (it) => ({ ...(it as Extract<DisplayItem, { kind: 'tool' }>), status: 'ok', result: 'done' }),
    );
    expect(hit).toBe(true);
    expect(plain(t.render(60)).join('\n')).toContain('✓');
  });
});

describe('StatusLine', () => {
  it('两行式：徽章在前，context 贴右', () => {
    const s = new StatusLine({
      mode: 'manual',
      planMode: false,
      model: 'step-3.5-flash',
      busy: false,
      cwd: '/tmp/project',
      usedTokens: 1234,
      maxContextSize: 128000,
      hints: 'Enter 发送',
      backgroundCount: 0,
      queueLen: 0,
    });
    const [line1, line2] = plain(s.render(80));
    expect(line1).toContain('manual');
    expect(line1).toContain('step-3.5-flash');
    expect(line1).toContain('ready');
    expect(line2?.endsWith('context: 1% (1.2k/128k)')).toBe(true);
    expect(line2!.length).toBeLessThanOrEqual(80);
  });

  it('busy 与队列状态进徽章', () => {
    const s = new StatusLine({
      mode: 'auto',
      planMode: false,
      model: 'm',
      busy: true,
      cwd: '/x',
      usedTokens: 0,
      maxContextSize: 1000,
      hints: '',
      backgroundCount: 2,
      queueLen: 3,
    });
    const line1 = plain(s.render(80))[0]!;
    expect(line1).toContain('busy');
    expect(line1).toContain('bg:2');
    expect(line1).toContain('queue:3');
  });

  it('bg 徽章带最近任务命令名，超 20 列截断', () => {
    const base = {
      mode: 'manual' as const,
      planMode: false,
      model: 'm',
      busy: false,
      cwd: '/x',
      usedTokens: 0,
      maxContextSize: 1000,
      hints: '',
      queueLen: 0,
    };
    const s = new StatusLine({ ...base, backgroundCount: 1, latestBgTask: 'npm run build' });
    expect(plain(s.render(80))[0]!).toContain('bg:1 npm run build');
    const long = new StatusLine({
      ...base,
      backgroundCount: 1,
      latestBgTask: 'node scripts/very-long-command-name.mjs --flag',
    });
    const line = plain(long.render(120))[0]!;
    expect(line).toContain('bg:1 node scripts/very');
    expect(line).not.toContain('--flag');
  });

  it('goal 徽章：圆点按状态着色，显示用时与轮次/预算', () => {
    const base = {
      mode: 'manual' as const,
      planMode: false,
      model: 'm',
      busy: false,
      cwd: '/x',
      usedTokens: 0,
      maxContextSize: 1000,
      hints: '',
      backgroundCount: 0,
      queueLen: 0,
    };
    // 无预算：只显示已用轮次
    const active = new StatusLine({ ...base, goal: { status: 'active', turnsUsed: 3, elapsedMs: 65_000 } });
    expect(plain(active.render(80))[0]!).toContain('goal ● 1m05s · 3');
    // 有预算：轮次显示为 已用/预算
    const budgeted = new StatusLine({
      ...base,
      goal: { status: 'active', turnsUsed: 3, turnBudget: 10, elapsedMs: 5_000 },
    });
    expect(plain(budgeted.render(80))[0]!).toContain('goal ● 5s · 3/10');
    // paused / blocked 同样显示（用户不该因为暂停就看不到目标还在）
    const paused = new StatusLine({ ...base, goal: { status: 'paused', turnsUsed: 1, elapsedMs: 1_000 } });
    expect(plain(paused.render(80))[0]!).toContain('goal ●');
    // 无 goal 时不占位
    const none = new StatusLine(base);
    expect(plain(none.render(80))[0]!).not.toContain('goal');
  });

  it('goal 圆点着色区分三态（绿 active / 黄 blocked / 灰 paused）', () => {
    const prev = chalk.level;
    chalk.level = 3;
    try {
      const base = {
        mode: 'manual' as const,
        planMode: false,
        model: 'm',
        busy: false,
        cwd: '/x',
        usedTokens: 0,
        maxContextSize: 1000,
        hints: '',
        backgroundCount: 0,
        queueLen: 0,
      };
      const colorOf = (status: 'active' | 'paused' | 'blocked'): string => {
        const line = new StatusLine({ ...base, goal: { status, turnsUsed: 0, elapsedMs: 0 } }).render(80)[0]!;
        const m = /\x1b\[(\d+)m●/.exec(line);
        return m?.[1] ?? '';
      };
      const active = colorOf('active');
      const blocked = colorOf('blocked');
      const paused = colorOf('paused');
      expect(new Set([active, blocked, paused]).size).toBe(3);
      expect(active).toBe('32'); // green
      expect(blocked).toBe('33'); // yellow
    } finally {
      chalk.level = prev;
    }
  });

  it('窄终端下路径先被牺牲，context 不被截断', () => {
    const s = new StatusLine({
      mode: 'manual',
      planMode: false,
      model: 'step-3.5-flash',
      busy: false,
      cwd: '/very/long/path/that/keeps/going/on',
      usedTokens: 500,
      maxContextSize: 1000,
      hints: '一些提示文案',
      backgroundCount: 0,
      queueLen: 0,
    });
    const [line1, line2] = plain(s.render(40));
    expect(line1!.length).toBeLessThanOrEqual(40);
    expect(line2).toContain('context: 50%');
  });

  it('shortenPath 与 formatCount', () => {
    expect(shortenPath('/a/b/c/d/e')).toBe('…/c/d/e');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1500)).toBe('1.5k');
    expect(formatCount(150000)).toBe('150k');
  });
});

describe('ActivityLine', () => {
  it('idle 时不占行；busy 时显示 spinner 与中断提示', () => {
    const a = new ActivityLine();
    expect(a.render(60)).toEqual([]);
    a.setBusy(true, Date.now());
    const out = plain(a.render(60)).join('\n');
    expect(out).toContain('Esc 中断');
  });

  it('思考预览取尾部单行', () => {
    const a = new ActivityLine();
    a.setBusy(true, Date.now());
    a.setThinking(true, 'aaa\nbbb\nccc');
    const out = plain(a.render(60));
    expect(out.length).toBe(2);
    expect(out[0]).toContain('思考中');
    expect(out[1]).toContain('ccc');
  });
});

describe('ChatEditor 的 Esc / Ctrl+C 路由', () => {
  function mk(): { term: FakeTerminal; tui: TuiMainScreen; ed: ChatEditor } {
    const term = new FakeTerminal();
    const tui = new TuiMainScreen(term);
    const ed = new ChatEditor(tui, {
      borderColor: (s) => s,
      selectList: {
        selectedPrefix: (s) => s,
        selectedText: (s) => s,
        description: (s) => s,
        scrollInfo: (s) => s,
        noMatch: (s) => s,
      },
    });
    return { term, tui, ed };
  }

  it('控制器消费 Esc 时不下传给编辑器', () => {
    const { ed } = mk();
    ed.setText('abc');
    let called = 0;
    ed.onEscapeKey = () => {
      called += 1;
      return true;
    };
    ed.handleInput('\x1b');
    expect(called).toBe(1);
    expect(ed.getText()).toBe('abc');
  });

  it('补全菜单打开时 Esc 归编辑器，控制器不介入', () => {
    const { ed } = mk();
    ed.autocompleteOpen = true;
    let called = 0;
    ed.onEscapeKey = () => {
      called += 1;
      return true;
    };
    ed.handleInput('\x1b');
    expect(called).toBe(0);
  });

  it('Ctrl+C 交给控制器', () => {
    const { ed } = mk();
    let called = 0;
    ed.onCtrlC = () => {
      called += 1;
      return true;
    };
    ed.handleInput('\x03');
    expect(called).toBe(1);
  });
});

/**
 * 贴图键位路由。用户实测反馈「pi 版不支持 Alt+V 贴图」：Ink 版主仓的键位是 Alt+V
 * （`App.tsx` 的 `meta.meta && key === 'v'`），迁移时只接了 Ctrl+V，而 i18n 文案
 * （`app.image.bannerHint`）里一直写着「Alt+V 继续添加」——文案与行为分叉，
 * 按提示操作反而没反应。
 *
 * 这里用真实字节序列驱动真实 ChatEditor，同时覆盖两种键盘协议：legacy 下 Alt+V 是
 * `ESC` + `v`，kitty 下是 `\x1b[118;3u`。核心风险是 legacy 序列与 Esc 同以 \x1b 开头，
 * 所以必须钉住「Alt+V 不会走成 Esc（中断回合）」这一条。
 */
describe('贴图键位：Alt+V 与 Ctrl+V 双入口', () => {
  function mk(): ChatEditor {
    const term = new FakeTerminal();
    const tui = new TuiMainScreen(term);
    return new ChatEditor(tui, {
      borderColor: (s) => s,
      selectList: {
        selectedPrefix: (s) => s,
        selectedText: (s) => s,
        description: (s) => s,
        scrollInfo: (s) => s,
        noMatch: (s) => s,
      },
    });
  }

  it('legacy 序列（ESC+v）触发 onAltV，且不落进输入框', () => {
    const ed = mk();
    let alt = 0;
    ed.onAltV = () => {
      alt += 1;
      return true;
    };
    ed.handleInput('\x1bv');
    expect(alt).toBe(1);
    expect(ed.getText(), 'v 不应被当普通字符插入').toBe('');
  });

  it('kitty 序列（CSI 118;3u）同样触发 onAltV', () => {
    const ed = mk();
    let alt = 0;
    ed.onAltV = () => {
      alt += 1;
      return true;
    };
    ed.handleInput('\x1b[118;3u');
    expect(alt).toBe(1);
  });

  it('Alt+V 不触发 Esc 路由（否则按贴图会中断回合）', () => {
    const ed = mk();
    let esc = 0;
    let alt = 0;
    ed.onEscapeKey = () => {
      esc += 1;
      return true;
    };
    ed.onAltV = () => {
      alt += 1;
      return true;
    };
    ed.handleInput('\x1bv');
    expect(esc, 'ESC+v 必须解析为 alt+v，不能当成 escape').toBe(0);
    expect(alt).toBe(1);
  });

  it('单独的 ESC 仍走 Esc 路由，不误触贴图', () => {
    const ed = mk();
    let esc = 0;
    let alt = 0;
    ed.onEscapeKey = () => {
      esc += 1;
      return true;
    };
    ed.onAltV = () => {
      alt += 1;
      return true;
    };
    ed.handleInput('\x1b');
    expect(esc).toBe(1);
    expect(alt).toBe(0);
  });

  it('Ctrl+V 仍然可用（Alt 被终端吃掉时的兜底入口）', () => {
    const ed = mk();
    let ctrl = 0;
    ed.onCtrlV = () => {
      ctrl += 1;
      return true;
    };
    ed.handleInput('\x16');
    expect(ctrl).toBe(1);
  });

  it('钩子返回 false 时按键下传，不吞键', () => {
    const ed = mk();
    ed.onAltV = () => false;
    ed.handleInput('\x1bv');
    // 下传到父类：alt+v 不是 Editor 的默认键位，父类忽略它，不应插入字符
    expect(ed.getText()).toBe('');
  });
});

/**
 * 输入提示符 `› `。对齐 Ink 版 PromptInput（同一个符号、busy 黄空闲灰）。
 *
 * 实现依赖两条 pi-tui 的实测事实，测试要把它们钉住，否则升级 pi-tui 时会静默坏掉：
 * 1. 光标是父类用反显字符画进行内容的，不是终端真实光标 —— 所以覆盖行首字符不错位；
 * 2. `paddingX` 只给内容行加缩进，边框行宽度不受影响，且续行同样缩进。
 */
describe('输入框提示符', () => {
  function mk(): ChatEditor {
    const term = new FakeTerminal();
    const tui = new TuiMainScreen(term);
    return new ChatEditor(tui, {
      borderColor: (s) => s,
      selectList: {
        selectedPrefix: (s) => s,
        selectedText: (s) => s,
        description: (s) => s,
        scrollInfo: (s) => s,
        noMatch: (s) => s,
      },
    });
  }
  /** 剥 ANSI，便于按可见字符断言。 */
  const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

  it('首个内容行以 “› ” 开头', () => {
    const ed = mk();
    ed.setText('hello');
    const lines = ed.render(40);
    expect(plain(lines[1]!).startsWith('› ')).toBe(true);
    expect(plain(lines[1]!)).toContain('hello');
  });

  it('空输入时也有提示符（不是只在有内容时出现）', () => {
    const ed = mk();
    const lines = ed.render(40);
    expect(plain(lines[1]!).startsWith('› ')).toBe(true);
  });

  it('边框行宽度不受提示符影响（与转录区同宽）', () => {
    const ed = mk();
    ed.setText('hello');
    const lines = ed.render(40);
    expect(plain(lines[0]!).length, '上边框').toBe(40);
    expect(plain(lines[lines.length - 1]!).length, '下边框').toBe(40);
    expect(plain(lines[1]!).length, '内容行').toBe(40);
  });

  it('多行输入只有首行带提示符，续行缩进对齐', () => {
    const ed = mk();
    ed.setText('line1\nline2');
    const lines = ed.render(40);
    expect(plain(lines[1]!).startsWith('› line1')).toBe(true);
    expect(plain(lines[2]!).startsWith('  line2'), '续行留空两列，与首行内容左边缘对齐').toBe(true);
  });

  it('折行的续行同样缩进（宽字符按显示宽度算）', () => {
    const ed = mk();
    ed.setText('这是一段很长的中文文本用来测试折行时的缩进');
    const lines = ed.render(20);
    expect(plain(lines[1]!).startsWith('› 这是')).toBe(true);
    // 至少折出一条续行，且续行以两个空格开头
    const cont = lines.slice(2, -1).map(plain);
    expect(cont.length).toBeGreaterThan(0);
    for (const l of cont) expect(l.startsWith('  ')).toBe(true);
  });

  it('promptStyle 只作用于提示符，不污染输入内容', () => {
    const ed = mk();
    ed.promptStyle = (s) => `<${s}>`;
    ed.setText('abc');
    const line = ed.render(40)[1]!;
    expect(line.startsWith('<› >')).toBe(true);
    expect(line).toContain('abc');
  });
});

/**
 * 空输入占位文案。Ink 版一直有这两句（busy 时「输入将加入发送队列」是行为说明，
 * 不是装饰），pi 版迁移时没接。
 *
 * 实现要插在 pi-tui 的反显光标序列之后、并从行尾等宽裁空白，所以「行宽不变」是这里
 * 最该守的不变量：差分渲染按行比对，行宽变了会牵连边框对齐。
 */
describe('输入框占位文案', () => {
  function mk(): ChatEditor {
    const term = new FakeTerminal();
    const tui = new TuiMainScreen(term);
    return new ChatEditor(tui, {
      borderColor: (s) => s,
      selectList: {
        selectedPrefix: (s) => s,
        selectedText: (s) => s,
        description: (s) => s,
        scrollInfo: (s) => s,
        noMatch: (s) => s,
      },
    });
  }
  const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

  it('空输入时显示，且排在光标之后', () => {
    const ed = mk();
    ed.placeholderText = () => '输入指令，回车发送';
    const line = plain(ed.render(60)[1]!);
    expect(line.startsWith('› ')).toBe(true);
    expect(line).toContain('输入指令，回车发送');
    // 光标（反显空格剥色后是一个空格）在提示符与文案之间
    expect(line.indexOf('输入指令')).toBeGreaterThan(2);
  });

  it('有输入内容时不显示（不会与已输入文本叠在一起）', () => {
    const ed = mk();
    ed.placeholderText = () => '输入指令，回车发送';
    ed.setText('已经打了字');
    const line = plain(ed.render(60)[1]!);
    expect(line).toContain('已经打了字');
    expect(line).not.toContain('输入指令');
  });

  it('行宽与边框宽度不因文案改变（差分渲染的前提）', () => {
    const ed = mk();
    const bare = ed.render(60);
    ed.placeholderText = () => '思考中…输入将加入发送队列';
    const withPh = ed.render(60);
    // 必须按**显示宽度**断言而不是 .length：中文一个字符占两列，字符数与列数不等，
    // 用 .length 会把「宽度正确」误判成变短（第一版就栽在这里）。
    expect(visibleWidth(plain(withPh[1]!)), '内容行宽度应与无文案时相同').toBe(visibleWidth(plain(bare[1]!)));
    expect(visibleWidth(plain(withPh[1]!))).toBe(60);
    expect(visibleWidth(plain(withPh[0]!))).toBe(60);
    expect(visibleWidth(plain(withPh[withPh.length - 1]!))).toBe(60);
  });

  it('窄终端下截断而不是撑破行宽', () => {
    const ed = mk();
    ed.placeholderText = () => '这是一句很长很长的占位提示文案不可能放得下';
    const line = plain(ed.render(20)[1]!);
    expect(visibleWidth(line), '行宽必须仍等于终端宽').toBe(20);
    expect(line).toContain('…');
  });

  it('返回空串时不画任何东西', () => {
    const ed = mk();
    ed.placeholderText = () => '';
    const line = plain(ed.render(40)[1]!);
    expect(line.trim()).toBe('›');
  });

  it('placeholderStyle 只包文案', () => {
    const ed = mk();
    ed.placeholderText = () => 'PH';
    ed.placeholderStyle = (s) => `[${s}]`;
    const line = ed.render(40)[1]!;
    expect(line).toContain('[PH]');
  });
});

/**
 * 迁移要回答的核心问题：pi-tui 的差分渲染在「历史只追加」时会不会清 scrollback。
 * Ink 版三类渲染病害（滚动跳顶、Static 冻结、动态区顶出屏幕）全部源于整帧重绘 +
 * clearTerminal，这组用例就是验证换框架之后那个前提是否真的消失了。
 */
describe('差分渲染不清 scrollback（迁移核心验证）', () => {
  function mount(): { term: FakeTerminal; tui: TuiMainScreen; t: Transcript } {
    const term = new FakeTerminal();
    const tui = new TuiMainScreen(term);
    tui.setClearOnShrink(false);
    const t = new Transcript();
    tui.addChild(t);
    return { term, tui, t };
  }

  it('首帧不清屏（假定终端干净）', () => {
    const { term, tui, t } = mount();
    t.push({ kind: 'assistant', text: 'hello' });
    tui.renderNow();
    expect(term.allOutput()).not.toContain(CLEAR_SCROLLBACK);
  });

  it('尾部追加内容（含超屏长历史）不触发清 scrollback', () => {
    const { term, tui, t } = mount();
    for (let i = 0; i < 5; i++) t.push({ kind: 'assistant', text: `line ${i}` });
    tui.renderNow();
    term.reset();
    const redrawsBefore = tui.fullRedraws;
    // 追加到远超终端高度（rows=24）为止，全程只在尾部长内容
    for (let i = 0; i < 60; i++) {
      t.push({ kind: 'user', text: `u${i}` });
      t.push({ kind: 'assistant', text: `a${i}` });
      tui.renderNow();
    }
    expect(term.allOutput()).not.toContain(CLEAR_SCROLLBACK);
    expect(tui.fullRedraws).toBe(redrawsBefore);
  });

  it('流式追加：反复改写末块只重绘尾部，不清 scrollback', () => {
    const { term, tui, t } = mount();
    for (let i = 0; i < 40; i++) t.push({ kind: 'note', text: `history ${i}` });
    t.push({ kind: 'assistant', text: '' });
    tui.renderNow();
    term.reset();
    const redrawsBefore = tui.fullRedraws;
    let acc = '';
    for (const chunk of ['流', '式', '输', '出', '一', '直', '追', '加']) {
      acc += chunk;
      t.update(-1, { kind: 'assistant', text: acc });
      tui.renderNow();
    }
    expect(term.allOutput()).not.toContain(CLEAR_SCROLLBACK);
    expect(tui.fullRedraws).toBe(redrawsBefore);
  });

  /**
   * 这条不是「期望的行为」，是把实测到的代价钉住：裁剪必然清一次 scrollback。
   * 它是 Transcript 默认不裁剪的直接依据——真到了要裁的量级，这个代价无法规避，
   * 只能靠不裁来避免。行为哪天变了（上游改实现或我们换策略），这条会红，正是要它红。
   */
  it('裁剪（内容整体上移）必然触发全量重绘并清 scrollback：默认不裁剪的依据', () => {
    const { term, tui, t } = mount();
    for (let i = 0; i < 30; i++) t.push({ kind: 'assistant', text: `x${i}` });
    tui.renderNow();
    term.reset();
    const redrawsBefore = tui.fullRedraws;
    // 模拟裁剪：整体替换成更短的内容（clearOnShrink 已关，挡不住这条路径）
    t.reset([{ kind: 'note', text: '裁剪后' }], 12);
    tui.renderNow();
    expect(term.allOutput()).toContain(CLEAR_SCROLLBACK);
    expect(tui.fullRedraws).toBe(redrawsBefore + 1);
  });

  it('对照：宽度变化确实会走全量重绘（说明检测手段有效，不是永远测不出来）', () => {
    const { term, tui, t } = mount();
    t.push({ kind: 'assistant', text: 'hello' });
    tui.renderNow();
    term.reset();
    term.columns = 60;
    t.push({ kind: 'assistant', text: 'world' });
    tui.renderNow();
    expect(term.allOutput()).toContain(CLEAR_SCROLLBACK);
    expect(tui.fullRedraws).toBeGreaterThan(0);
  });
});

describe('子 agent 进度（对标 Ink 版 AgentGroup，改为条目内嵌）', () => {
  const spawn = (over: Record<string, unknown> = {}): DisplayItem =>
    ({
      kind: 'tool',
      id: 's1',
      name: 'spawn_agent',
      input: { description: '查文档' },
      status: 'running',
      startedAt: 1_000,
      subagentType: 'explore',
      description: '查文档',
      ...over,
    }) as DisplayItem;

  it('统计段：tools 计数 · 时长 · tok（tok 为 0 时不显示）', () => {
    const s = subagentStats(spawn({ subagentToolEvents: [{ name: 'grep', status: 'ok' }, { name: 'read_file', status: 'running' }] }) as never, 4_000);
    expect(s).toContain('2 tools');
    expect(s).toContain('3s');
    expect(s).not.toContain('tok');
    const withTok = subagentStats(spawn({ subagentTokens: 12_345 }) as never, 2_000);
    expect(withTok).toContain('12.3k tok');
  });

  it('终态用 runner 回传的定格值，不再现算', () => {
    const s = subagentStats(
      spawn({ status: 'ok', subagentToolUses: 7, subagentDurationMs: 65_000, startedAt: 1_000 }) as never,
      999_999,
    );
    expect(s).toContain('7 tools');
    expect(s).toContain('1m 5s'); // formatDuration 的分秒之间有空格（与 formatElapsed 不同口径）
  });

  it('非 spawn_agent 工具没有统计段', () => {
    expect(subagentStats({ kind: 'tool', id: 'b', name: 'bash', input: {}, status: 'ok' } as never)).toBe('');
  });

  it('运行中渲染最近 3 条子工具，终态折叠成计数', () => {
    const events = [
      { name: 'grep', status: 'ok' as const },
      { name: 'read_file', status: 'ok' as const },
      { name: 'glob', status: 'ok' as const },
      { name: 'web_fetch', status: 'running' as const },
    ];
    const running = plain(new ItemBlock(spawn({ subagentToolEvents: events })).render(70));
    expect(running.join('\n')).toContain('web_fetch');
    expect(running.join('\n')).not.toContain('grep'); // 只留最近 3 条
    const done = plain(new ItemBlock(spawn({ status: 'ok', subagentToolEvents: events })).render(70));
    expect(done.join('\n')).toContain('4 个子工具调用');
  });
});

describe('dynamic_workflow 阶段渲染', () => {
  const wf = (phases: { title: string; status: 'running' | 'done' }[], status: 'running' | 'ok' = 'running'): DisplayItem =>
    ({
      kind: 'tool',
      id: 'w1',
      name: 'dynamic_workflow',
      input: { description: '批量调研' },
      status,
      dynamicWorkflow: { name: '批量调研', phases },
    }) as DisplayItem;

  it('运行中逐个列出阶段：● 当前 / ✓ 已完成', () => {
    const lines = plain(
      new ItemBlock(wf([
        { title: '收集资料', status: 'done' },
        { title: '交叉验证', status: 'running' },
      ])).render(70),
    );
    const text = lines.join('\n');
    expect(text).toContain('✓ 收集资料');
    expect(text).toContain('● 交叉验证');
  });

  it('终态坍缩成一行阶段计数', () => {
    const lines = plain(
      new ItemBlock(wf([{ title: 'a', status: 'done' }, { title: 'b', status: 'done' }], 'ok')).render(70),
    );
    expect(lines.join('\n')).toContain('2 个阶段');
    expect(lines.join('\n')).not.toContain('✓ a');
  });

  it('无阶段数据时不占行', () => {
    const bare = plain(new ItemBlock({ kind: 'tool', id: 'w2', name: 'dynamic_workflow', input: {}, status: 'running' } as DisplayItem).render(70));
    expect(bare.join('\n')).not.toContain('阶段');
  });
});
