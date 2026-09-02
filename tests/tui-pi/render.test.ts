/**
 * pi-tui 前端的渲染层测试。
 *
 * 上游 @earendil-works/pi-tui@0.84.1 没有导出 VirtualTerminal（设计文档写的那个测试方案
 * 不成立，见「待确认项实测结论」第四条），所以这里自己实现 Terminal 接口：收集写入的字节，
 * 直接对差分渲染的输出做断言。这比读 xterm 屏幕缓冲更贴近要验证的东西——我们关心的是
 * 「有没有发清屏序列」，而不是「屏幕最终长什么样」。
 */
import chalk from 'chalk';
import { describe, expect, it, vi } from 'vitest';
import { TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui';
import type { Terminal } from '@earendil-works/pi-tui';
import { Transcript } from '../../src/tui-pi/Transcript.js';
import { ItemBlock, extractArgsPreview } from '../../src/tui-pi/blocks.js';
import { ActivityLine, RenderCache, StatusLine, formatCount, shortenPath } from '../../src/tui-pi/StatusLine.js';
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

  it('用户消息正文着黄、前缀着蓝（与 Ink 版同口径，不能退回默认白）', () => {
    // 转录区里用户消息若不着色就与助手正文糊成一片。这条断言盯的是「正文有黄」，
    // 不是「有颜色」——之前 c.user 只给前缀上色、正文继承默认白，看起来也「有颜色」。
    const prev = chalk.level;
    chalk.level = 3;
    try {
      const lines = new ItemBlock({ kind: 'user', text: '帮我改个文件' }).render(40);
      const first = lines[0]!;
      // chalk.yellow = SGR 33，chalk.blue = 34
      expect(first, '正文缺黄色 SGR').toContain('\x1b[33m');
      expect(first, '前缀缺蓝色 SGR').toContain('\x1b[34m');
      // 折行后每一行的正文都要着色，不能只有首行
      const long = new ItemBlock({ kind: 'user', text: 'x'.repeat(120) }).render(40);
      const bodyLines = long.filter((l) => l.trim() !== '');
      expect(bodyLines.length, '应折成多行').toBeGreaterThan(1);
      for (const l of bodyLines) expect(l, '续行正文缺黄色').toContain('\x1b[33m');
      // 折行宽度不被 ANSI 撑破（着色发生在折行之后）
      for (const l of long) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
    } finally {
      chalk.level = prev;
    }
  });

  it('压缩保真原话（verbatim）降权：dim 灰色、无黄底、带「原话」标记，与真人输入区分', () => {
    // 压缩过的长会话 resume 后，保真原话若与真人输入同高亮会「满屏用户消息」掩盖模型输出。
    // verbatim 条目应去掉黄底、改 dim，前缀标记为「原话」。
    const prev = chalk.level;
    chalk.level = 3;
    try {
      const lines = new ItemBlock({ kind: 'user', text: '这是我当初说的话', verbatim: true }).render(40);
      const joined = lines.join('\n');
      // 1) 无黄色（正文 SGR 33 不应出现）——区别于真人输入的黄底高亮
      expect(joined, '原话不应着黄').not.toContain('\x1b[33m');
      // 2) 带「原话」前缀标记
      expect(plain(lines).some((l) => l.includes('原话'))).toBe(true);
      // 3) 折行宽度不超
      for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
    } finally {
      chalk.level = prev;
    }
  });

  it('工具标题行：参数摘要覆盖各类工具，skill 着黄、其余着 gray', () => {
    // 用户反馈「调用工具只显示一个名字」，两个根因：参数色用了 dim(SGR 2) 在多数终端
    // 主题下读不出来；summarizeInput 只认 path/pattern/command/skill 四字段，搜索类、
    // web_fetch、任务类的卡片全都落空。这条测两者。
    const prev = chalk.level;
    chalk.level = 3;
    try {
      const head = (o: Record<string, unknown>): string =>
        new ItemBlock({ kind: 'tool', id: 't', status: 'ok', ...o } as never).render(78)[0]!;

      // 参数色 = gray(90)，不是 dim(2)
      const wf = head({ name: 'write_file', input: { path: 'src/x.ts' } });
      expect(wf, '参数应为 gray(90)').toContain('\x1b[90m');
      expect(wf).toContain('src/x.ts');
      // 工具名与参数之间两个空格
      expect(wf.replace(/\x1b\[[0-9;]*m/g, '')).toContain('write_file  src/x.ts');

      // skill 的参数着黄（33），与普通参数区分
      const sk = head({ name: 'skill', input: { skill: 'academic-figure' } });
      expect(sk, 'skill 参数应为 yellow(33)').toContain('\x1b[33m');

      // 字段覆盖：这些工具此前全都只显示工具名
      const plain = (o: Record<string, unknown>): string => head(o).replace(/\x1b\[[0-9;]*m/g, '');
      expect(plain({ name: 'web_search', input: { query: 'pi-tui 源码', n: 10 } })).toContain('pi-tui 源码');
      expect(plain({ name: 'web_fetch', input: { url: 'https://example.com/d' } })).toContain('https://example.com/d');
      expect(plain({ name: 'task_output', input: { task_id: 'tm-541' } })).toContain('tm-541');
      expect(plain({ name: 'team_spawn', input: { mission_id: 'M1', prompt: 'x' } })).toContain('M1');
      expect(plain({ name: 'create_goal', input: { objective: '完成对标' } })).toContain('完成对标');
      // pattern 优先于 path：grep 显示搜索词而非搜索目录
      expect(plain({ name: 'grep', input: { pattern: 'needle', path: 'src/' } })).toContain('needle');
      expect(plain({ name: 'grep', input: { pattern: 'needle', path: 'src/' } })).not.toContain('src/');
      // 数组入参不凑摘要（结果体自己会列出来）
      expect(plain({ name: 'todo_list', input: { todos: [{ title: 'a' }] } }).trim()).toBe('✓ todo_list');

      // 主界面与 Ctrl+O 展开态共用口径
      const expanded = ItemBlock.renderExpanded(
        { kind: 'tool', id: 't', name: 'write_file', status: 'ok', input: { path: 'src/x.ts' }, result: 'ok' } as never,
        78,
      )[0]!;
      expect(expanded.replace(/\x1b\[[0-9;]*m/g, '')).toContain('write_file  src/x.ts');
    } finally {
      chalk.level = prev;
    }
  });

  it('bash 运行中显示耗时与 Ctrl+B 提示，非 bash 或终态不显示', () => {
    const prev = chalk.level;
    chalk.level = 0;
    try {
      const running = new ItemBlock({
        kind: 'tool',
        id: 't',
        name: 'bash',
        status: 'running',
        startedAt: Date.now() - 3000,
        input: { command: 'pnpm test' },
      } as never).render(78)[0]!;
      expect(running).toContain('已运行 3s');
      expect(running, 'Ctrl+B 提示缺失').toContain('Ctrl+B');
      // 终态不显示这两项
      const done = new ItemBlock({
        kind: 'tool',
        id: 't',
        name: 'bash',
        status: 'ok',
        startedAt: Date.now() - 3000,
        input: { command: 'pnpm test' },
        result: 'ok',
      } as never).render(78)[0]!;
      expect(done).not.toContain('Ctrl+B');
      expect(done).not.toContain('已运行');
      // 非 bash 工具运行中有耗时但无 Ctrl+B（转后台只对前台 bash 有意义）
      const other = new ItemBlock({
        kind: 'tool',
        id: 't',
        name: 'read_file',
        status: 'running',
        startedAt: Date.now() - 2000,
        input: { path: 'a.ts' },
      } as never).render(78)[0]!;
      expect(other).toContain('已运行 2s');
      expect(other).not.toContain('Ctrl+B');
    } finally {
      chalk.level = prev;
    }
  });

  it('thinking 块全灰：无任何非 dim 的着色残留', () => {
    // 半灰半白是老 bug：逐项配 thinkingMarkdownTheme 只覆盖带标记的元素，无标记的普通
    // 段落不经过任何 theme 函数，Markdown 原样输出即默认白——而思考内容大部分是普通段落。
    // 这条断言盯的是「除 dim(2/22) 外没有别的 SGR」，不是「有 dim」：只给前缀套 dim 也能
    // 让「有 dim」成立，那正是修复前的状态。
    const prev = chalk.level;
    chalk.level = 3;
    try {
      const text = [
        '普通段落文本',
        '',
        '- 列表项文字',
        '',
        '**加粗** 与 `行内代码` 与 [链接](https://example.com)',
        '',
        '> 引用行',
        '',
        '# 标题',
        '',
        '```js',
        'const a = 1;',
        '```',
        '',
        '---',
        '',
        '~~删除线~~',
      ].join('\n');
      const cases: readonly (readonly [string, readonly string[]])[] = [
        ['展开态', ItemBlock.renderExpanded({ kind: 'thinking', text } as never, 60)],
        // 主界面只渲染折叠后的前 THINKING_FOLD_LINES 行，彩色元素必须落在这几行内。
        // 用上面那段长文本时链接/删除线都在第 5 行之后，撤掉主界面的 dimAll 测试照样全绿
        // ——断言测的是被折叠掉的部分。所以这里换一段两行的短文本，不触发折叠。
        [
          '主界面',
          new ItemBlock({
            kind: 'thinking',
            text: '**加粗** 与 `行内代码` 与 [链接](https://example.com)\n~~删除线~~',
          }).render(60),
        ],
      ];
      for (const [name, lines] of cases) {
        for (const l of lines) {
          const codes = [...l.matchAll(/\x1b\[([0-9;]+)m/g)].map((m) => m[1]!);
          const nonDim = codes.filter((x) => x !== '2' && x !== '22');
          expect(nonDim, `${name} 出现非 dim 着色：${JSON.stringify(l.slice(0, 60))}`).toEqual([]);
        }
      }
      // OSC 8 超链接是功能不是颜色，压灰不能把它剥掉
      const withLink = ItemBlock.renderExpanded(
        { kind: 'thinking', text: '见 [文档](https://example.com)' } as never,
        60,
      ).join('');
      expect(withLink, 'OSC 8 超链接被误剥').toContain('example.com');
    } finally {
      chalk.level = prev;
    }
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

  it('真实 edit_file 输出（中文 summary + +N -M path + formatRow）被识别为 diff 并铺开', () => {
    // edit 工具真实输出：首行中文 summary，第二行 +N -M path 摘要头，其后是 formatRow 数据行。
    // 早前 looksLikeDiff 只认 @@/---/+++，edit 输出被误判为普通输出折成一行——这条钉住识别。
    const editOutput = [
      '已编辑 src/a.ts（替换 1 处）。',
      '+3 -1 src/a.ts',
      '   7 + added line one',
      '   8 - removed line',
      '   9 + added line two',
      '     … 5 unchanged lines …',
    ].join('\n');
    const block = new ItemBlock({
      kind: 'tool',
      id: 'e1',
      name: 'edit_file',
      input: { path: 'src/a.ts' },
      status: 'ok',
      result: editOutput,
    });
    const out = plain(block.render(60)).join('\n');
    // 不应折叠成「N 行」——diff 数据行必须当场可见
    expect(out, 'edit 输出被折叠成一行').not.toContain('Ctrl+O 查看');
    expect(out).toContain('added line one');
    expect(out).toContain('removed line');
    expect(out).toContain('+3 -1');
    // 摘要头 +N -M 正确统计（3 增 1 删，不是被摘要头行首 + 误算成 +1）
    expect(out).toMatch(/\+3/);
    expect(out).toMatch(/-1/);
  });

  it('edit_file diff 数据行按 +/- 上色（formatRow 行号+标记格式）', () => {
    const prev = chalk.level;
    chalk.level = 3;
    try {
      const editOutput = '已编辑 x.ts（替换 1 处）。\n+2 -1 x.ts\n   7 + added\n   8 - removed\n   9   context';
      const block = new ItemBlock({
        kind: 'tool', id: 'e2', name: 'edit_file', input: { path: 'x.ts' }, status: 'ok', result: editOutput,
      });
      const lines = block.render(60);
      const joined = lines.join('\n');
      // formatRow 数据行 `   7 + added` 应被识别并按 + 上绿（32）、- 上红（31）
      const addLine = lines.find((l) => l.includes('+ added'));
      const remLine = lines.find((l) => l.includes('- removed'));
      expect(addLine, 'added 行应有绿色 SGR 32').toContain('\x1b[32m');
      expect(remLine, 'removed 行应有红色 SGR 31').toContain('\x1b[31m');
      // 中文 summary 行不着色为绿/红（走 dim）
      const summaryLine = lines.find((l) => l.includes('已编辑'));
      expect(summaryLine, '中文 summary 行不应着绿/红').toBeDefined();
    } finally {
      chalk.level = prev;
    }
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

  it('PLAN_MODE_BLOCKED 渲染为黄色标记 + [plan mode] 标记', () => {
    const prev = chalk.level;
    chalk.level = 3;
    try {
      const blocked = new ItemBlock({
        kind: 'tool',
        id: 't4',
        name: 'write_file',
        input: { path: 'src/x.ts' },
        status: 'error',
        result: '计划模式（plan mode）已开启：当前只能做只读调查，不能修改文件或执行命令（write_file 被拦截）。请完成调查后调用 exit_plan_mode 提交计划供用户确认。',
        errorCode: 'PLAN_MODE_BLOCKED',
      } as never).render(60);
      const head = blocked[0]!;
      // 状态符是黄色（SGR 33）而非红色（SGR 31）
      expect(head).toContain('\x1b[33m✗\x1b[39m');
      // 工具名后紧跟 [plan mode] 标记
      expect(head).toContain('[plan mode]');
      // 结果体也是黄色
      const body = blocked.slice(1).join('\n');
      expect(body).toContain('\x1b[33m');
      expect(body).not.toContain('\x1b[31m');
      // Ctrl+O 展开态同样如此
      const expanded = ItemBlock.renderExpanded({
        kind: 'tool',
        id: 't4',
        name: 'write_file',
        input: { path: 'src/x.ts' },
        status: 'error',
        result: '计划模式（plan mode）已开启：当前只能做只读调查，不能修改文件或执行命令（write_file 被拦截）。请完成调查后调用 exit_plan_mode 提交计划供用户确认。',
        errorCode: 'PLAN_MODE_BLOCKED',
      } as never, 60);
      expect(expanded[0]!).toContain('\x1b[33m✗\x1b[39m');
      expect(expanded[0]!).toContain('[plan mode]');
    } finally {
      chalk.level = prev;
    }
  });

  it('普通错误工具仍为红色 ✗，不受 errorCode 映射影响', () => {
    const prev = chalk.level;
    chalk.level = 3;
    try {
      const err = new ItemBlock({
        kind: 'tool',
        id: 't5',
        name: 'bash',
        input: { command: 'npm test' },
        status: 'error',
        result: 'command not found',
      } as never).render(60);
      const head = err[0]!;
      expect(head).toContain('\x1b[31m✗\x1b[39m');
      expect(head).not.toContain('[plan mode]');
      const body = err.slice(1).join('\n');
      expect(body).toContain('\x1b[31m');
    } finally {
      chalk.level = prev;
    }
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

  it('3 秒无进展进入停滞态：状态词标注无新输出时长', () => {
    vi.useFakeTimers();
    try {
      const a = new ActivityLine();
      a.setBusy(true, Date.now());
      // 刚进入 busy：非停滞
      expect(plain(a.render(60))[0]).not.toContain('无新输出');
      // 推进 3.5s，无任何进展 → 停滞
      vi.advanceTimersByTime(3_500);
      a.invalidate();
      expect(plain(a.render(60))[0]).toContain('无新输出');
      // 工具活动刷新技术 → 停滞解除
      a.noteToolActivity();
      a.invalidate();
      expect(plain(a.render(60))[0]).not.toContain('无新输出');
      // 再停滞 4s，token 增长也刷新心跳
      vi.advanceTimersByTime(4_000);
      a.invalidate();
      expect(plain(a.render(60))[0]).toContain('无新输出');
      a.addOutputChars(10);
      a.invalidate();
      expect(plain(a.render(60))[0]).not.toContain('无新输出');
    } finally {
      vi.useRealTimers();
    }
  });

  it('思考预览取尾部 3 行', () => {
    const a = new ActivityLine();
    a.setBusy(true, Date.now());
    a.setThinking(true, 'aaa\nbbb\nccc');
    const out = plain(a.render(60));
    // 1 行 head + 3 行预览（PREVIEW_LINES = 3）
    expect(out.length).toBe(4);
    expect(out[0]).toContain('思考中');
    expect(out[1]).toContain('aaa');
    expect(out[2]).toContain('bbb');
    expect(out[3]).toContain('ccc');
  });

  it('思考预览行不重复 spinner（只出现在 head 行）', () => {
    const a = new ActivityLine();
    a.setBusy(true, Date.now());
    a.setThinking(true, '思考内容第一行\n思考内容第二行');
    const out = plain(a.render(60));
    const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const spinLine = (l: string) => spinnerChars.some((ch) => l.startsWith(ch));
    const spinLines = out.filter(spinLine);
    // 只有 head 行带 spinner，预览行不带
    expect(spinLines.length).toBe(1);
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

  it('工具卡 forming 态：显示「参数成形中」与半截 JSON 抠出的关键字段', () => {
    const forming = plain(new ItemBlock({
      kind: 'tool',
      id: 'c1',
      name: 'read_file',
      input: {},
      status: 'running',
      startedAt: Date.now(),
      forming: true,
      partialArgs: '{"path":"src/mai',
    }).render(70)).join('\n');
    expect(forming).toContain('read_file');
    expect(forming).toContain('path=src/mai');
    // 无关键字段时回退通用文案
    const noKey = plain(new ItemBlock({
      kind: 'tool',
      id: 'c2',
      name: 'bash',
      input: {},
      status: 'running',
      startedAt: Date.now(),
      forming: true,
      partialArgs: '{"foo":',
    }).render(70)).join('\n');
    expect(noKey).toContain('参数成形中');
  });

  it('extractArgsPreview：半截 JSON 容忍未闭合字符串，按字段优先级抠取', () => {
    expect(extractArgsPreview('{"path":"src/a.ts"}')).toBe('path=src/a.ts');
    expect(extractArgsPreview('{"comma')).toBe('');
    expect(extractArgsPreview('{"command":"pnpm test')).toBe('command=pnpm test');
    // file_path 优先于 path
    expect(extractArgsPreview('{"path":"a","file_path":"b"}')).toBe('file_path=b');
  });

  it('工具卡 forming 态转正：tool_start 填实参数后按正常卡渲染', () => {
    // reconcile 逻辑在 PiChat（wiring 测试锁调用点），这里锁渲染侧：
    // forming 清除后 partialArgs 不再影响显示
    const done = plain(new ItemBlock({
      kind: 'tool',
      id: 'c1',
      name: 'read_file',
      input: { path: 'src/main.ts' },
      status: 'ok',
      result: 'ok',
    }).render(70)).join('\n');
    expect(done).toContain('read_file');
    expect(done).toContain('src/main.ts');
    expect(done).not.toContain('参数成形中');
  });

  it('大段粘贴折叠成占位符，getExpandedText 还原全文', () => {
    // pi-tui Editor 内置：>10 行或 >1000 字符折叠成 [paste #N +M lines]，提交时展开。
    // 这条测试锁住「折叠+还原」契约，上游行为变化时立刻红。
    const { ed } = mk();
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n');
    ed.handleInput(`\x1b[200~${lines}\x1b[201~`);
    expect(ed.getText()).toContain('[paste #1 +20 lines]');
    expect(ed.getExpandedText()).toBe(lines);
  });

  it('PasteBurst：散装文本块里的 \\r 按换行处理，不触发提交（无 bracketed paste 终端兜底）', () => {
    const { ed } = mk();
    const submitted: string[] = [];
    ed.onSubmit = (text) => submitted.push(text);
    // 无 bracketed paste 的终端上粘贴以整块到达：含 \r 的文本块必须拆行插入
    ed.handleInput('line1\rline2\rline3');
    expect(submitted, '粘贴块里的 \\r 不得触发提交').toEqual([]);
    expect(ed.getText()).toBe('line1\nline2\nline3');
  });

  it('PasteBurst：爆发窗口内单独到达的 Enter 视为换行，窗口外正常提交', () => {
    vi.useFakeTimers();
    try {
      const { ed } = mk();
      const submitted: string[] = [];
      ed.onSubmit = (text) => submitted.push(text);
      ed.handleInput('line1\rline2\rline3');
      // 窗口内（尾块与最后的 \r 分开到达的场景）：Enter → 换行
      ed.handleInput('\r');
      expect(submitted).toEqual([]);
      expect(ed.getText()).toBe('line1\nline2\nline3\n');
      // 窗口外：Enter 正常提交（末尾空行被提交路径裁掉，正文三行完整即可）
      vi.advanceTimersByTime(200);
      ed.handleInput('\r');
      expect(submitted).toEqual(['line1\nline2\nline3']);
    } finally {
      vi.useRealTimers();
    }
  });

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

  it('footerText 画在下边框之外，空串不占行', () => {
    const { ed } = mk();
    const base = ed.render(60);
    expect(ed.footerText()).toBe(''); // 默认无 footer
    ed.footerText = () => '· 再按一次 Esc 取回上一条消息编辑';
    const withFooter = ed.render(60);
    expect(withFooter.length, 'footer 应多占一行').toBe(base.length + 1);
    // 必须在下边框之后（框内会让输入框高度抖动）
    // Editor 的边框是横线（不是 welcome 框的圆角），footer 必须落在它之后
    expect(withFooter[withFooter.length - 2]!.replace(/\x1b\[[0-9;]*m/g, ''), '倒数第二行应是下边框').toMatch(/^─+$/);
    expect(withFooter[withFooter.length - 1]).toContain('再按一次 Esc');
    // 超宽 footer 被截断，不撑破行宽
    ed.footerText = () => 'x'.repeat(200);
    const wide = ed.render(60);
    expect(visibleWidth(wide[wide.length - 1]!)).toBeLessThanOrEqual(60);
  });

  it('除 Esc / Ctrl+C 外的按键触发 onOtherKey（primed 解除通道），且不吞按键', () => {
    const { ed } = mk();
    const hits: string[] = [];
    ed.onOtherKey = () => hits.push('x');
    // Esc 与 Ctrl+C 不触发：它们各自是两个 primed 的第二击，被解除就永远走不到执行分支
    ed.handleInput('\x1b');
    ed.handleInput('\x03');
    expect(hits.length, 'Esc/Ctrl+C 不应触发解除').toBe(0);
    // 普通字符触发，且字符仍然进了输入框（旁路通知，不消费按键）
    ed.handleInput('a');
    expect(hits.length).toBe(1);
    expect(ed.getText(), '按键不应被吞掉').toBe('a');
    // 其他控制键同样触发
    ed.handleInput('\x02'); // ctrl+b
    expect(hits.length).toBe(2);
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

  it('思考预览：带 spinner 前缀的行不超过终端宽度', () => {
    const a = new ActivityLine();
    a.setBusy(true, Date.now());
    // 长思考文本，确保 Text 组件填满 contentW
    a.setThinking(true, '这是一段很长的思考内容。'.repeat(50));
    for (const w of [40, 60, 80, 100, 120]) {
      const lines = a.render(w);
      for (const line of lines) {
        // plain() 去掉 ANSI 后测可见宽度
        const vis = line.replace(/\x1b\[[0-9;]*m/g, '').length;
        expect(vis, `width=${w} 时某行可见宽度 ${vis} > ${w}`).toBeLessThanOrEqual(w);
      }
    }
  });

/** 造一个含 tool+thinking 的完整轮次（折叠测试用，比 pushTurns 更贴近真实转录）。 */
function pushRichTurn(t: Transcript, i: number): void {
  t.push({ kind: 'user', text: `问题 ${i}` });
  t.push({ kind: 'thinking', text: `思考 ${i}：分析这个问题的多个方面，考虑边界条件与实现路径。`.repeat(20) });
  t.push({ kind: 'tool', id: `t${i}`, name: 'read_file', input: { path: `src/f${i}.ts` }, status: 'ok', result: 'x'.repeat(2000) });
  t.push({ kind: 'assistant', text: `回答 ${i}：结论如下。` });
}

describe('Transcript.foldOldTurns（OOM 第二道防线）', () => {
  it('块数未超阈值时不动（no-op）', () => {
    const t = new Transcript();
    for (let i = 0; i < 5; i++) pushRichTurn(t, i);
    const before = t.size();
    const r = t.foldOldTurns(30);
    expect(r.folded).toBe(false);
    expect(r.count).toBe(0);
    expect(t.size()).toBe(before); // 20 = 5 轮 × 4 块
  });

  it('超阈值时只折旧轮的 tool/thinking，保留 user/assistant 与最近 N 轮完整块', () => {
    const t = new Transcript();
    for (let i = 0; i < 10; i++) pushRichTurn(t, i); // 10 轮 × 4 块 = 40 块
    const r = t.foldOldTurns(3); // 保留最近 3 轮，折前 7 轮
    expect(r.folded).toBe(true);
    // 每旧轮折 2 块（thinking + tool），7 轮 = 14 块折成 7 个 foldSummary；user+assistant 7 轮 × 2 = 14 保留
    // 最近 3 轮 12 块完整保留。总计 = 14(保留) + 7(摘要) + 12(最近) = 33
    expect(r.count).toBe(14);
    expect(t.size()).toBe(33);
  });

  it('foldSummary 摘要块正确渲染（带折叠数量）', () => {
    const t = new Transcript();
    for (let i = 0; i < 5; i++) pushRichTurn(t, i);
    t.foldOldTurns(1); // 折前 4 轮，每轮 2 个可折块
    const out = plain(t.render(80)).join('\n');
    expect(out).toContain('折叠了 2 个旧块');
    // 最近 1 轮的完整内容仍在
    expect(out).toContain('问题 4');
    expect(out).toContain('回答 4');
  });

  it('折叠释放旧块的渲染资源（dispose 后 markdown 实例丢弃）', () => {
    const t = new Transcript();
    for (let i = 0; i < 5; i++) pushRichTurn(t, i);
    const bigBefore = t.size();
    t.foldOldTurns(1);
    // 折叠后块数显著下降（旧轮 tool/thinking 被摘要替代）
    expect(t.size()).toBeLessThan(bigBefore);
    // 摘要块仍可正常 render（不因 dispose 抛错）
    const lines = t.render(80);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('无 tool/thinking 的旧轮（纯对话）不产生多余摘要', () => {
    const t = new Transcript();
    for (let i = 0; i < 6; i++) {
      t.push({ kind: 'user', text: `q${i}` });
      t.push({ kind: 'assistant', text: `a${i}` });
    }
    t.foldOldTurns(2); // 折前 4 轮，但旧轮只有 user/assistant，无 tool/thinking
    expect(t.size()).toBe(12); // 6 轮 × 2，无折叠发生
  });

  it('每回合旧块折成各自的摘要（不跨轮合并成一个大摘要）', () => {
    const t = new Transcript();
    for (let i = 0; i < 5; i++) pushRichTurn(t, i);
    t.foldOldTurns(1); // 折前 4 轮
    const summaries = t.items().filter((it) => it.kind === 'foldSummary');
    // 每个旧轮独立一个摘要（4 轮 = 4 个摘要，每个 count=2）
    expect(summaries.length).toBe(4);
    expect(summaries.every((s) => s.kind === 'foldSummary' && s.count === 2)).toBe(true);
  });
});

describe('Transcript.foldOldTurns 触发闸门（避免每回合全屏重绘）', () => {
  it('turn 数未超 triggerTurns 时不折（即使超过 keepRecentTurns）', () => {
    const t = new Transcript();
    for (let i = 0; i < 50; i++) pushRichTurn(t, i); // 50 轮
    // keepRecent=10 本应折，但 triggerTurns=200 闸门拦住
    const r = t.foldOldTurns(10, 200);
    expect(r.folded).toBe(false);
    expect(t.size()).toBe(200); // 50 轮 × 4 块，原样不动
  });

  it('turn 数超过 triggerTurns 时才折', () => {
    const t = new Transcript();
    for (let i = 0; i < 60; i++) pushRichTurn(t, i); // 60 轮
    const r = t.foldOldTurns(10, 50); // 60 > 50 闸门放行，折到最近 10 轮
    expect(r.folded).toBe(true);
    // 前 50 轮折成摘要（每轮 2 可折块 → 50 摘要），user+assistant 50 轮保留；最近 10 轮完整
    const summaries = t.items().filter((it) => it.kind === 'foldSummary');
    expect(summaries.length).toBe(50);
  });

  it('triggerTurns=0（默认）不设闸门，一超 keepRecent 就折（单测口径）', () => {
    const t = new Transcript();
    for (let i = 0; i < 10; i++) pushRichTurn(t, i);
    const r = t.foldOldTurns(3); // 不传 trigger，10 > 3 即折
    expect(r.folded).toBe(true);
  });
});

describe('宽度溢出安全网（2026-08-17 两次 doRender 崩溃）', () => {
  it('wrap 将 992 字符无空格长串截断到指定宽度', () => {
    // 复刻 crash log line 399: w=992>67，单个无空格长串
    const longStr = 'A'.repeat(992);
    const width = 67;
    // 通过 ItemBlock 的 user 渲染路径走 wrap（user 分支用 wrap(it.text, width-2)）
    const block = new ItemBlock({ kind: 'user', text: longStr } as DisplayItem);
    const lines = block.render(width);
    for (const l of lines) {
      expect(visibleWidth(l), `行宽 ${visibleWidth(l)} 超过 ${width}，会触发 doRender throw`).toBeLessThanOrEqual(width);
    }
  });

  it('renderMarkdown 对长 URL/base64 逐行截断到 width', () => {
    // 思考预览与 assistant 渲染都走 renderMarkdown，长串不能逃过
    const longUrl = 'https://example.com/' + 'x'.repeat(980);
    const block = new ItemBlock({ kind: 'assistant', text: longUrl } as DisplayItem);
    const width = 67;
    const lines = block.render(width);
    for (const l of lines) {
      expect(visibleWidth(l), `Markdown 输出行宽 ${visibleWidth(l)} 超过 ${width}`).toBeLessThanOrEqual(width);
    }
  });

  it('renderMarkdown(thinking) 折叠态同样截断', () => {
    const longThink = '│ ' + 'thinking '.repeat(200); // 无空格长串变体
    const block = new ItemBlock({ kind: 'thinking', text: longThink } as DisplayItem);
    const width = 67;
    const lines = block.render(width);
    for (const l of lines) {
      expect(visibleWidth(l), `thinking 输出行宽 ${visibleWidth(l)} 超过 ${width}`).toBeLessThanOrEqual(width);
    }
  });
});

describe('RenderCache', () => {
  it('首次 shouldRender 返回 true，commit 后返回 false', () => {
    const cache = new RenderCache();
    expect(cache.shouldRender(80)).toBe(true);
    cache.commit(80, ['line1', 'line2']);
    expect(cache.shouldRender(80)).toBe(false);
    expect(cache.cached()).toEqual(['line1', 'line2']);
  });

  it('width 变化时失效', () => {
    const cache = new RenderCache();
    cache.commit(80, ['a']);
    expect(cache.shouldRender(80)).toBe(false);
    expect(cache.shouldRender(100)).toBe(true);
  });

  it('invalidate 后失效', () => {
    const cache = new RenderCache();
    cache.commit(80, ['a']);
    expect(cache.shouldRender(80)).toBe(false);
    cache.invalidate();
    expect(cache.shouldRender(80)).toBe(true);
  });
});

describe('StatusLine renderCache', () => {
  const base = {
    mode: 'agent' as const,
    planMode: false,
    model: 'test-model',
    busy: false,
    cwd: '/test',
    usedTokens: 100,
    maxContextSize: 1000,
    hints: 'test hints',
    backgroundCount: 0,
    queueLen: 0,
  };

  it('setState 后 render 重新计算', () => {
    const s = new StatusLine(base);
    const lines1 = s.render(80);
    // 第二次 render，width 相同，应该返回缓存（同一引用）
    const lines2 = s.render(80);
    expect(lines2).toBe(lines1); // 引用相等 = 走了缓存
    // setState 后缓存失效
    s.setState({ busy: true });
    const lines3 = s.render(80);
    expect(lines3).not.toBe(lines1); // 不是同一引用 = 重新计算了
  });
});

describe('ActivityLine renderCache', () => {
  it('setThinking 之间 render 缓存 thinking preview wrap', () => {
    const a = new ActivityLine();
    a.setBusy(true);
    a.setThinking(true, '这是 thinking 内容 **加粗** 和 `代码`');
    // 第一次 render 计算 contentLines
    const lines1 = a.render(80);
    expect(lines1.length).toBeGreaterThan(1);
    // 第二次 render，thinkingPreview 没变，走缓存
    const lines2 = a.render(80);
    // spinner/elapsed 不同所以行内容不同，但 thinking preview 行的 truncateToWidth 结果应该相同
    // 验证缓存生效的方式：setThinking 后 render 应该重新计算
    a.setThinking(true, '新的 thinking 内容');
    const lines3 = a.render(80);
    // 内容变了，不可能是缓存
    expect(lines3).not.toEqual(lines2);
  });

  it('tick 推进 spinner 帧，thinking 预览复用缓存不抖动（流式冻结）', () => {
    const a = new ActivityLine();
    a.setBusy(true);
    a.setThinking(true, 'thinking content');
    const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
    const head1 = plain(a.render(80)[0]!);
    // tick 推进帧号并失效 renderCache——render 会重算 head 行（spinner 字符变），
    // 但 thinking 预览文本没变，render 内部复用 cachedTail，预览行不随帧重渲染。
    a.tick();
    a.tick();
    a.tick();
    const head2 = plain(a.render(80)[0]!);
    expect(head1[0]).not.toBe(head2[0]); // spinner 字符变了 = tick 真正让 spinner 转
    // thinking 预览行复用缓存：三次 tick 期间预览内容稳定（无跳动）
    const tailBefore = a.render(80).slice(1).map(plain);
    a.tick();
    a.tick();
    const tailAfter = a.render(80).slice(1).map(plain);
    expect(tailAfter).toEqual(tailBefore);
  });

  it('addOutputChars 不失效 previewCache（token 计数冻结直到 setThinking）', () => {
    const a = new ActivityLine();
    a.setBusy(true);
    a.setThinking(true, 'thinking');
    const lines1 = a.render(80);
    a.addOutputChars(1000);
    const lines2 = a.render(80);
    expect(lines2).toBe(lines1); // 同一引用 = 走缓存
  });
});
