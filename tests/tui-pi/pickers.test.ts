/**
 * 选择器（M3）的候选项构造与交互测试。
 *
 * 列表交互本身（↑↓/过滤/滚动跟随）是 pi-tui SelectList 的职责，不重复测；
 * 这里测的是我们自己的部分：候选项怎么组织、过滤串怎么收、Esc/Enter 怎么结算。
 */
import chalk from 'chalk';
import { describe, expect, it } from 'vitest';
import { TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui';
import type { Terminal } from '@earendil-works/pi-tui';
import { PickerOverlay, askLine, askValidated, modelItems, relativeTime, sessionItems, thinkItems } from '../../src/tui-pi/pickers.js';
import type { SessionMeta } from '../../src/session/store.js';
import type { StepCodeConfig } from '../../src/config/config.js';

function plain(lines: readonly string[]): string[] {
  // eslint-disable-next-line no-control-regex
  return lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
}

const ESC = '\x1b';
const ENTER = '\r';
const DOWN = '\x1b[B';

describe('relativeTime', () => {
  const now = Date.parse('2026-08-14T12:00:00Z');
  it('按秒/分/小时/天分档，超过 30 天给日期', () => {
    expect(relativeTime('2026-08-14T11:59:30Z', now)).toBe('30 秒前');
    expect(relativeTime('2026-08-14T11:30:00Z', now)).toBe('30 分钟前');
    expect(relativeTime('2026-08-14T09:00:00Z', now)).toBe('3 小时前');
    expect(relativeTime('2026-08-10T12:00:00Z', now)).toBe('4 天前');
    expect(relativeTime('2026-01-01T12:00:00Z', now)).toBe('2026-01-01');
    expect(relativeTime('不是时间', now)).toBe('');
  });
});

describe('sessionItems', () => {
  const now = Date.parse('2026-08-14T12:00:00Z');
  const metas: SessionMeta[] = [
    {
      id: 'abcdef1234',
      cwd: '/x',
      model: 'm',
      createdAt: '2026-08-14T10:00:00Z',
      updatedAt: '2026-08-14T11:00:00Z',
      messageCount: 12,
      title: '从标题来的',
    },
    {
      id: 'zzz',
      cwd: '/x',
      model: 'm',
      createdAt: '2026-08-14T10:00:00Z',
      updatedAt: '2026-08-14T11:00:00Z',
      messageCount: 3,
      name: '我改的名字',
      title: '标题',
    },
  ];

  it('展示口径是 name ?? title，描述带相对时间与消息数', () => {
    const items = sessionItems(metas, now);
    expect(items[0]!.label).toBe('从标题来的');
    expect(items[1]!.label).toBe('我改的名字');
    expect(items[0]!.description).toContain('1 小时前');
    expect(items[0]!.description).toContain('12 条');
    expect(items[0]!.description).toContain('abcdef12');
  });

  it('当前会话标绿色圆点前缀 + 描述尾注"当前"', () => {
    const items = sessionItems(metas, now, 'zzz');
    expect(items[1]!.label).toContain('●');
    expect(items[1]!.label).toContain('我改的名字');
    expect(items[1]!.description).toContain('当前');
    // 非当前会话不带标记
    expect(items[0]!.label).not.toContain('●');
    expect(items[0]!.description).not.toContain('当前');
  });
});

describe('modelItems', () => {
  const config = {
    provider: 'stepfun',
    providers: { stepfun: { type: 'openai' }, kimi: { type: 'anthropic' } },
    models: {
      step35: { model: 'step-3.5-flash', provider: 'stepfun', maxContextSize: 262000, displayName: 'Step 3.5' },
      k3: { model: 'k3', provider: 'kimi', maxContextSize: 400000 },
    },
  } as unknown as StepCodeConfig;

  it('按渠道分组，描述带渠道与真实 id 与窗口，当前别名标点', () => {
    const items = modelItems(config, 'k3');
    // 渠道按配置首现顺序：step35（stepfun）在 k3（kimi）之前——与 Ink 版一致，不再按字典序
    expect(items[0]!.value).toBe('step35');
    expect(items[1]!.value).toBe('k3');
    expect(items[1]!.label).toContain('← 当前');
    expect(items[1]!.description).toBe('kimi · k3 · 400k');
    expect(items[0]!.label).toBe('Step 3.5');
    expect(items[0]!.description).toBe('stepfun · step-3.5-flash · 262k');
  });

  it('没有别名时返回空列表（调用方据此提示直切）', () => {
    expect(modelItems({} as StepCodeConfig)).toEqual([]);
  });
});

describe('thinkItems', () => {
  it('四档 + 跟随默认，当前项标点', () => {
    const items = thinkItems('high');
    expect(items.map((i) => i.value)).toEqual(['high', 'medium', 'low', 'off', '__default__']);
    expect(items[0]!.label).toContain('← 当前');
    const none = thinkItems(undefined);
    expect(none[4]!.label).toContain('← 当前');
  });
});

describe('PickerOverlay', () => {
  function mk(): { overlay: PickerOverlay; picked: string[]; cancelled: number[] } {
    const picked: string[] = [];
    const cancelled: number[] = [];
    const overlay = new PickerOverlay({
      title: '选择模型',
      items: [
        { value: 'alpha', label: 'alpha', description: 'A' },
        { value: 'beta', label: 'beta', description: 'B' },
        { value: 'gamma', label: 'gamma', description: 'C' },
      ],
      requestRender: () => {},
      onSelect: (item) => picked.push(item.value),
      onCancel: () => cancelled.push(1),
    });
    return { overlay, picked, cancelled };
  }

  /**
   * 2026-08-19 实测：width=67 的窄终端上 /model 弹出，底部 hint 行
   * 「↑↓ 选择 · Enter 确认 · … · Esc 取消」visibleWidth=78 > 67，
   * pi-tui doRender 直接 throw 崩溃（crash log line 17）。
   *
   * 根因是 render 出口少了对含 ANSI 样式行的逐行截断：dim 包裹的 hint
   * visibleWidth 仍计真实宽，只截「裸文本行」会漏掉它。防线落在 render 出口的
   * `truncateToWidth(l, width)`——这条测试锁死它，截断一旦被删，这里立刻红。
   */
  it('render 出口逐行截断：窄终端(width=67)下无任何行超宽', () => {
    const { overlay } = mk();
    for (const w of [67, 60, 40]) {
      const lines = overlay.render(w);
      for (const l of lines) {
        expect(visibleWidth(l), `width=${w} 行超宽: ${JSON.stringify(plain([l])[0])}`).toBeLessThanOrEqual(w);
      }
    }
  });

  it('标题与提示行在列表上下，Enter 选中当前项', () => {
    const { overlay, picked } = mk();
    const lines = plain(overlay.render(60));
    expect(lines[0]).toContain('选择模型');
    expect(lines.join('\n')).toContain('alpha');
    expect(lines[lines.length - 1]).toContain('Enter 确认');
    overlay.handleInput(ENTER);
    expect(picked).toEqual(['alpha']);
  });

  /**
   * subtitle 与 hint 必须各占一行，不能互相顶掉。
   *
   * 这是首次运行向导踩出来的：业务说明当时被传进 hint，于是底部那行操作键提示
   * （↑↓/Enter/Esc）整条消失——新用户见到的第一个界面上没有任何键位说明。
   */
  it('subtitle 在标题下方，且不挤掉底部的操作键提示', () => {
    const overlay = new PickerOverlay({
      title: '选择模型',
      subtitle: '未检测到 API key。请配置后继续使用：',
      items: [{ value: 'alpha', label: 'alpha' }],
      requestRender: () => {},
      onSelect: () => {},
      onCancel: () => {},
    });
    const lines = plain(overlay.render(60));
    expect(lines[0]).toContain('选择模型');
    expect(lines[1]).toContain('未检测到 API key');
    // 底部仍是操作键提示：subtitle 占的是标题下一行，不是 hint 的位置
    expect(lines[lines.length - 1]).toContain('Enter 确认');
    expect(lines[lines.length - 1]).not.toContain('未检测到 API key');
  });

  it('↓ 移动后 Enter 选中第二项', () => {
    const { overlay, picked } = mk();
    overlay.handleInput(DOWN);
    overlay.handleInput(ENTER);
    expect(picked).toEqual(['beta']);
  });

  it('Windows 终端的 Enter 变体均可确认：\\r / \\n / \\r\\n / SS3-OM', () => {
    const cases: string[] = ['\r', '\n', '\x1bOM'];
    for (const key of cases) {
      const { overlay, picked } = mk();
      overlay.handleInput(key);
      expect(picked, `Enter variant ${JSON.stringify(key)}`).toEqual(['alpha']);
    }
    // CRLF 序列整体送入时也应确认
    const crlf = mk();
    crlf.overlay.handleInput('\r\n');
    expect(crlf.picked).toEqual(['alpha']);
  });

  it('可打印字符进过滤串并显示在标题行，退格删字', () => {
    const { overlay, picked } = mk();
    overlay.handleInput('g');
    expect(plain(overlay.render(60))[0]).toContain('过滤：g');
    overlay.handleInput(ENTER);
    expect(picked).toEqual(['gamma']);

    const second = mk();
    second.overlay.handleInput('g');
    second.overlay.handleInput('\x7f');
    expect(plain(second.overlay.render(60))[0]).not.toContain('过滤');
    second.overlay.handleInput(ENTER);
    expect(second.picked).toEqual(['alpha']);
  });

  it('Esc 取消', () => {
    const { overlay, cancelled } = mk();
    overlay.handleInput(ESC);
    expect(cancelled).toEqual([1]);
  });
});

describe('PickerOverlay 渠道 tab（对标 Ink 版 ModelPicker）', () => {
  const CH_A = [
    { value: 'a1', label: 'a-one', description: 'chA' },
    { value: 'a2', label: 'a-two', description: 'chA' },
  ];
  const CH_B = [{ value: 'b1', label: 'b-one', description: 'chB' }];
  const ALL = [...CH_A, ...CH_B];
  const tabs = [
    { id: 'all', label: '全部' },
    { id: 'chA', label: 'chA' },
    { id: 'chB', label: 'chB' },
  ];
  const itemsForTab = (id: string) => (id === 'chA' ? CH_A : id === 'chB' ? CH_B : ALL);

  function mkTabs() {
    const picked: string[] = [];
    const shifted: string[] = [];
    const overlay = new PickerOverlay({
      title: '选择模型',
      items: ALL,
      requestRender: () => {},
      onSelect: (item) => picked.push(item.value),
      onCancel: () => {},
      onShiftSelect: (item) => shifted.push(item.value),
      tabs,
      itemsForTab,
    });
    return { overlay, picked, shifted };
  }

  it('tab 条渲染在标题行下，active 反色', () => {
    // chalk 在非 TTY 测试进程里 level=0 不出色码，这里显式打开验证反色
    const prev = chalk.level;
    chalk.level = 3;
    try {
      const { overlay } = mkTabs();
      const lines = overlay.render(60);
      expect(lines[1]).toContain('全部');
      expect(lines[1]).toContain('\x1b[7m'); // active 反色
      expect(plain(lines).join('\n')).toContain('b-one');
    } finally {
      chalk.level = prev;
    }
  });

  it('Tab 切渠道后候选只剩该渠道，Shift+Tab 回卷', () => {
    const { overlay, picked } = mkTabs();
    overlay.handleInput('\t'); // → chA
    let text = plain(overlay.render(60)).join('\n');
    expect(text).toContain('a-one');
    expect(text).not.toContain('b-one');
    overlay.handleInput('\t'); // → chB
    text = plain(overlay.render(60)).join('\n');
    expect(text).toContain('b-one');
    expect(text).not.toContain('a-one');
    overlay.handleInput(ENTER);
    expect(picked).toEqual(['b1']);
    // Shift+Tab 与 Tab 方向相反：chA 回卷到「全部」
    const second = mkTabs();
    second.overlay.handleInput('\t'); // all → chA
    second.overlay.handleInput('\x1b[Z'); // chA → all
    const t2 = plain(second.overlay.render(60)).join('\n');
    expect(t2).toContain('a-one');
    expect(t2).toContain('b-one');
  });

  it('每个 tab 独立记忆过滤词与选中项', () => {
    const { overlay } = mkTabs();
    overlay.handleInput('\t'); // → chA
    overlay.handleInput(DOWN); // 选中 a2
    overlay.handleInput('\t'); // → chB
    overlay.handleInput('\x1b[Z'); // ← 回 chA
    // 回到 chA 时选中项恢复为 a2
    expect(overlay.getSelected()?.value).toBe('a2');
  });

  it('Esc 有过滤词先清词，再按才取消', () => {
    const cancelled: number[] = [];
    const overlay = new PickerOverlay({
      title: 't',
      items: ALL,
      requestRender: () => {},
      onSelect: () => {},
      onCancel: () => cancelled.push(1),
    });
    overlay.handleInput('b');
    overlay.handleInput(ESC);
    expect(cancelled).toEqual([]);
    expect(plain(overlay.render(60))[0]).not.toContain('过滤');
    overlay.handleInput(ESC);
    expect(cancelled).toEqual([1]);
  });

  it('Shift+Enter 走 onShiftSelect 而非普通确认', () => {
    const { overlay, picked, shifted } = mkTabs();
    overlay.handleInput('\x1b[13;2u'); // Kitty CSI-u 的 shift+enter（legacy \x1b\r 需 kitty 模式激活才识别）
    expect(shifted).toEqual(['a1']);
    expect(picked).toEqual([]);
  });

  it('单渠道（tabs 只有一个）时 Tab 不消费、无 tab 条', () => {
    const overlay = new PickerOverlay({
      title: 't',
      items: CH_A,
      requestRender: () => {},
      onSelect: () => {},
      onCancel: () => {},
      tabs: [{ id: 'all', label: '全部' }],
      itemsForTab,
    });
    const before = plain(overlay.render(60));
    overlay.handleInput('\t');
    expect(plain(overlay.render(60))).toEqual(before);
    expect(before[1]).not.toContain('全部'); // 无 tab 条
  });

  it('tab 超宽时滚动窗口保证 activeTab 可见，两端加 ‹ / … 指示符', () => {
    // 造很多 tab 强制触发滚动窗口
    const manyTabs = Array.from({ length: 12 }, (_, i) => ({
      id: `ch${i}`,
      label: `渠道${i}`,
    }));
    const overlay = new PickerOverlay({
      title: 't',
      items: [{ value: 'x', label: 'x' }],
      requestRender: () => {},
      onSelect: () => {},
      onCancel: () => {},
      tabs: manyTabs,
      itemsForTab: () => [{ value: 'x', label: 'x' }],
    });
    // 切到最后几个 tab——高亮 tab 必须在渲染行里可见
    for (let i = 0; i < 10; i++) overlay.handleInput('\t');
    const lines = plain(overlay.render(40));
    const tabLine = lines[1]!;
    expect(tabLine, 'active tab 高亮应可见').toContain('渠道9');
    // 左侧有隐藏 → 应有 ‹ 指示符
    expect(tabLine).toContain('‹');
  });
});

describe('PickerOverlay 额外键位与 setItems（会话选择器的删除/重命名基础）', () => {
  it('onKey 消费自定义键位，未消费的键仍走过滤/列表', () => {
    const seen: string[] = [];
    const overlay = new PickerOverlay({
      title: 't',
      items: [
        { value: 's1', label: '会话一', description: '' },
        { value: 's2', label: '会话二', description: '' },
      ],
      requestRender: () => {},
      onSelect: () => {},
      onCancel: () => {},
      onKey: (data, selected) => {
        if (data === 'd' || data === 'r') {
          seen.push(`${data}:${selected?.value ?? ''}`);
          return true;
        }
        return false;
      },
    });
    overlay.handleInput('d');
    expect(seen).toEqual(['d:s1']);
    // 未被 onKey 消费的可打印字符仍进过滤串
    overlay.handleInput('会');
    expect(plain(overlay.render(60))[0]).toContain('过滤：会');
  });

  it('setItems 换候选后保留当前过滤串', () => {
    const overlay = new PickerOverlay({
      title: 't',
      items: [{ value: 'a', label: 'alpha', description: '' }],
      requestRender: () => {},
      onSelect: () => {},
      onCancel: () => {},
    });
    overlay.handleInput('a');
    overlay.setItems([
      { value: 'a', label: 'alpha', description: '' },
      { value: 'b', label: 'beta', description: '' },
    ]);
    const lines = plain(overlay.render(60));
    expect(lines[0]).toContain('过滤：a');
    // 子串 AND 匹配：'a' 命中 alpha（value）和 beta（label 含 a）
    expect(lines.join('\n')).toContain('alpha');
    expect(lines.join('\n')).toContain('beta');
  });
});

/** 驱动 askValidated 需要一个能收输出、能喂输入的终端。 */
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

describe('askValidated（带校验的单行输入）', () => {
  function mk(): { term: FakeTerminal; tui: TuiMainScreen } {
    const term = new FakeTerminal();
    const tui = new TuiMainScreen(term);
    tui.start();
    return { term, tui };
  }
  /** 等一个宏任务，让 askLine 内部的 Promise 与渲染跑完。 */
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('合法值直接返回（trim 后）', async () => {
    const { term, tui } = mk();
    const p = askValidated(tui, '渠道 id', () => null);
    await tick();
    term.send('  my-gw  ');
    term.send(ENTER);
    await expect(p).resolves.toBe('my-gw');
  });

  /**
   * 这条是本函数存在的理由：非法值不能推进流程，也不能清掉用户已经打的内容。
   * Ink 版 ProviderWizard 的 submitText 就是「只置行内错误、不清输入现场」，
   * pi 版的 askLine 是一次性 Promise，靠回填 initial 还原现场。
   */
  it('非法值：报错并重问，且保留上次输入（不用整条重打）', async () => {
    const { term, tui } = mk();
    const seen: string[] = [];
    const p = askValidated(tui, 'base_url', (v) => {
      seen.push(v);
      return /^https?:\/\//.test(v) ? null : 'base_url 需以 http:// 或 https:// 开头';
    });
    await tick();
    term.send('ftp://x');
    term.send(ENTER);
    await tick();
    // 错误已经画出来
    expect(term.allOutput()).toContain('需以 http://');
    // 现场还在：上次输入被回填，只补前缀即可
    expect(term.allOutput()).toContain('ftp://x');
    term.reset();
    // 第二次输入合法 → 返回
    term.send('\x15'); // Ctrl+U 清行，模拟用户改写
    term.send('https://ok.example');
    term.send(ENTER);
    await expect(p).resolves.toBe('https://ok.example');
    // validate 被调用两次，说明第一次真的没放行
    expect(seen).toEqual(['ftp://x', 'https://ok.example']);
  });

  it('Esc 返回 null（校验循环不吞取消）', async () => {
    const { term, tui } = mk();
    const p = askValidated(tui, '渠道 id', () => '永远不合法');
    await tick();
    term.send('whatever');
    term.send(ENTER);
    await tick();
    term.send(ESC);
    await expect(p).resolves.toBeNull();
  });
});

describe('askLine 焦点恢复（2026-08-18 /rename 卡死修复）', () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  function mk(): { term: FakeTerminal; tui: TuiMainScreen } {
    const term = new FakeTerminal();
    const tui = new TuiMainScreen(term);
    tui.start();
    return { term, tui };
  }
  it('askLine Enter 结束后焦点恢复到调用前的组件', async () => {
    const { term, tui } = mk();
    const editor = new PickerOverlay({ title: 'test', items: [], onSelect: () => {} });
    tui.addChild(editor);
    tui.setFocus(editor);
    expect(tui.getFocusedComponent()).toBe(editor);
    const p = askLine(tui, '输入名称');
    await tick();
    expect(tui.getFocusedComponent()).not.toBe(editor);
    term.send('新名字');
    term.send(ENTER);
    await expect(p).resolves.toBe('新名字');
    expect(tui.getFocusedComponent()).toBe(editor);
  });
  it('askLine Esc 取消后焦点也恢复', async () => {
    const { term, tui } = mk();
    const editor = new PickerOverlay({ title: 'test', items: [], onSelect: () => {} });
    tui.addChild(editor);
    tui.setFocus(editor);
    expect(tui.getFocusedComponent()).toBe(editor);
    const p = askLine(tui, '输入名称');
    await tick();
    term.send(ESC);
    await expect(p).resolves.toBeNull();
    expect(tui.getFocusedComponent()).toBe(editor);
  });
});
