/**
 * pi-tui 前端的渲染层测试。
 *
 * 上游 @earendil-works/pi-tui@0.84.1 没有导出 VirtualTerminal（设计文档写的那个测试方案
 * 不成立，见「待确认项实测结论」第四条），所以这里自己实现 Terminal 接口：收集写入的字节，
 * 直接对差分渲染的输出做断言。这比读 xterm 屏幕缓冲更贴近要验证的东西——我们关心的是
 * 「有没有发清屏序列」，而不是「屏幕最终长什么样」。
 */
import { describe, expect, it } from 'vitest';
import { TuiMainScreen } from '@earendil-works/pi-tui';
import type { Terminal } from '@earendil-works/pi-tui';
import { Transcript } from '../../src/tui-pi/Transcript.js';
import { ItemBlock } from '../../src/tui-pi/blocks.js';
import { ActivityLine, StatusLine, formatCount, shortenPath } from '../../src/tui-pi/StatusLine.js';
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
