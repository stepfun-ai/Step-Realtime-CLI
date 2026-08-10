import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageList } from '../../src/tui/MessageList.js';
import { computeLiveMaxRows, INPUT_AREA_ROWS, STATUS_BAR_ROWS } from '../../src/tui/LiveViewport.js';
import { setLocale } from '../../src/i18n.js';
import type { DisplayItem } from '../../src/tui/types.js';

const assistant = (text: string): DisplayItem => ({ kind: 'assistant', text });
const note = (text: string): DisplayItem => ({ kind: 'note', text });
const toolOk = (id: string, result: string): DisplayItem => ({
  kind: 'tool',
  id,
  name: 'bash',
  input: {},
  status: 'ok',
  result,
});

/** 等测量 effect 落盘（measureElement 在 commit 后跑，隐藏指示晚一帧出现）。 */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const settle = async (): Promise<void> => {
  await tick();
  await tick();
};

/** 去掉 ANSI 颜色码，便于对纯文本内容断言。 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** 帧输出拆成逐行 trim 后的纯文本行（Ink 输出按宽度补空格，比较前必须 trim）。 */
function frameLines(out: string): string[] {
  return stripAnsi(out)
    .trimEnd()
    .split('\n')
    .map((l) => l.trimEnd());
}

describe('computeLiveMaxRows 高度预算', () => {
  it('预算 = 终端行数 − chrome 行数', () => {
    expect(computeLiveMaxRows(30, STATUS_BAR_ROWS + INPUT_AREA_ROWS)).toBe(24);
    expect(computeLiveMaxRows(10, 6)).toBe(4);
  });

  it('终端比 chrome 还矮时保底 1 行（不为 0/负数）', () => {
    expect(computeLiveMaxRows(6, 6)).toBe(1);
    expect(computeLiveMaxRows(3, 6)).toBe(1);
  });

  it('终端行数未知（非 TTY / 测试 mock）时不窗口化', () => {
    expect(computeLiveMaxRows(undefined, 6)).toBeUndefined();
  });

  it('resize 重算：纯函数无状态，rows 变小预算同步变小', () => {
    const chrome = 6;
    const before = computeLiveMaxRows(30, chrome);
    const after = computeLiveMaxRows(20, chrome);
    expect(before).toBe(24);
    expect(after).toBe(14);
  });
});

describe('MessageList 尾部锚定窗口（maxRows）', () => {
  afterEach(() => {
    setLocale('zh');
  });

  it('单 item 超长：行级截尾（不是整 item 丢弃）+ 隐藏行数指示', async () => {
    const text = Array.from({ length: 20 }, (_, i) => `l${String(i + 1).padStart(2, '0')}`).join('\n');
    // 自然高度 = marginTop 1 + 正文 20 = 21；maxRows 6 → 指示 1 行 + 可见 4 行
    const { lastFrame } = render(<MessageList items={[assistant(text)]} maxRows={6} />);
    await settle();
    const out = lastFrame() ?? '';
    const lines = frameLines(out);
    // 隐藏 21 − 5 = 16 行（空白 margin + l01..l15），可见 l16..l20
    expect(out).toContain('已隐藏 16 行早期输出');
    expect(lines).toContain('l16');
    expect(lines).toContain('l20');
    expect(lines).not.toContain('l15');
    // 帧高恒 ≤ 预算（动态帧 < 一屏的不变量）
    expect(lines.length).toBeLessThanOrEqual(6);
  });

  it('多 item 超预算：从尾部累计裁剪，顶部 item 先被隐藏', async () => {
    const items = [
      ...Array.from({ length: 10 }, (_, i) => note(`n${String(i + 1).padStart(2, '0')}`)),
      assistant(['a1', 'a2', 'a3', 'a4', 'a5'].join('\n')),
    ];
    // 自然高度 = 10 个 note × 2（margin 1 + 正文 1）+ assistant 6（margin 1 + 5 行）= 26
    // maxRows 8 → 指示 1 行 + 可见 7 行（assistant 6 行 + n10 正文 1 行）
    const { lastFrame } = render(<MessageList items={items} maxRows={8} />);
    await settle();
    const out = lastFrame() ?? '';
    const lines = frameLines(out);
    expect(out).toContain('已隐藏 19 行早期输出');
    expect(lines).toContain('· n10');
    expect(lines).toContain('a5');
    expect(lines).not.toContain('· n09');
    expect(lines.length).toBeLessThanOrEqual(8);
  });

  it('不超预算时原样渲染：无指示、内容完整、帧高不变', async () => {
    const items = [note('n1'), note('n2'), note('n3')];
    const windowed = render(<MessageList items={items} maxRows={10} />);
    await settle();
    const out = windowed.lastFrame() ?? '';
    expect(out).not.toContain('已隐藏');
    const lines = frameLines(out);
    expect(lines).toContain('· n1');
    expect(lines).toContain('· n3');
    // 3 个 note × 2 行（margin + 正文）= 6 行，与不传 maxRows 完全一致
    const plain = render(<MessageList items={items} />);
    expect(frameLines(plain.lastFrame() ?? '')).toEqual(lines);
  });

  it('不传 maxRows：长内容原样渲染，无窗口化（回归保护）', async () => {
    const text = Array.from({ length: 30 }, (_, i) => `x${i + 1}`).join('\n');
    const { lastFrame } = render(<MessageList items={[assistant(text)]} />);
    await settle();
    const out = lastFrame() ?? '';
    expect(out).not.toContain('已隐藏');
    expect(frameLines(out)).toContain('x1');
    expect(frameLines(out)).toContain('x30');
  });

  it('预算收紧（模拟 resize）：窗口收缩，隐藏行数指示随之变大', async () => {
    const text = Array.from({ length: 20 }, (_, i) => `l${String(i + 1).padStart(2, '0')}`).join('\n');
    const { lastFrame, rerender } = render(
      <MessageList items={[assistant(text)]} maxRows={15} />,
    );
    await settle();
    // 自然 21 行 > 15 → 指示 1 + 可见 14，隐藏 7
    expect(lastFrame() ?? '').toContain('已隐藏 7 行早期输出');
    rerender(<MessageList items={[assistant(text)]} maxRows={6} />);
    await settle();
    const out = lastFrame() ?? '';
    expect(out).toContain('已隐藏 16 行早期输出');
    expect(frameLines(out).length).toBeLessThanOrEqual(6);
  });

  it('英文 locale：隐藏指示走 i18n 英文文案', async () => {
    setLocale('en');
    const text = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n');
    const { lastFrame } = render(<MessageList items={[assistant(text)]} maxRows={6} />);
    await settle();
    expect(lastFrame() ?? '').toContain('↑ 16 earlier lines hidden');
  });

  it('集成：长流式 assistant + 折叠长工具输出，动态帧高恒 ≤ 预算', async () => {
    const streamText = Array.from({ length: 15 }, (_, i) => `s${String(i + 1).padStart(2, '0')}`).join('\n');
    const result = Array.from({ length: 50 }, (_, i) => `r${String(i + 1).padStart(2, '0')}`).join('\n');
    const items = [assistant(streamText), toolOk('t1', result)];
    // 动态区工具恒折叠（完整输出走 Ctrl+O 全屏查看器）：tool 块 = margin 1 + 头 1 + 折叠提示 1 = 3 行
    // 自然高度 = assistant 16 + tool 3 = 19；maxRows 8 → 指示 1 + 可见 7，隐藏 12
    const { lastFrame } = render(<MessageList items={items} busy={true} maxRows={8} />);
    await settle();
    const out = lastFrame() ?? '';
    const lines = frameLines(out);
    expect(out).toContain('已隐藏 12 行早期输出');
    // 工具输出正文不进动态区，只有折叠提示
    expect(out).toContain('50 行输出');
    expect(lines).not.toContain('  r50');
    // 尾部锚定：工具尾部可见，流式开头被裁
    expect(lines).toContain('s15');
    expect(lines).not.toContain('s01');
    expect(lines.length).toBeLessThanOrEqual(8);
  });

  it('流式逐拍增长回归：高频 commit 下测量 dispatch 不得累积成嵌套更新级联（线上闪退复现）', async () => {
    // 线上事故：流式期间 token 更新合并进测量触发的嵌套渲染，级联自持触顶 React 嵌套上限，
    // 整进程抛 Maximum update depth exceeded 闪退。逐拍推送 + 帧高恒超预算是最接近的现场。
    const { rerender, lastFrame } = render(
      <MessageList items={[assistant('s00')]} busy={true} maxRows={6} />,
    );
    const lines = ['s00'];
    let threw: unknown;
    try {
      for (let i = 1; i <= 40; i++) {
        lines.push(`s${String(i).padStart(2, '0')}`);
        rerender(
          <MessageList items={[assistant(lines.join('\n'))]} busy={true} maxRows={6} />,
        );
        await tick();
      }
    } catch (e) {
      threw = e;
    }
    await settle();
    expect(threw).toBeUndefined();
    const out = lastFrame() ?? '';
    expect(out).toContain('s40');
    expect(out).toContain('已隐藏');
    expect(frameLines(out).length).toBeLessThanOrEqual(6);
    // timeout 60s（2026-08-03 从 30s 提高）：本例单跑约 5.5s，但它是全套件里最重的一个
    // ——40 次 rerender，每次都要真实渲染 + 触发测量 dispatch + 等异步 flush。满负载
    // 并发下实测放大约 5.5 倍（一次全量跑到 30514ms，顶穿自己原本的 30s 上限），三次
    // 全量里挂 2 次、且**不跨文件漂移**，所以不是调度抖动型 flake，是这个用例稳定贴线。
    //
    // 选择加时间而不是减循环次数：40 拍是最接近线上闪退现场的强度，降下来等于削弱这道
    // 回归防护。若后续再次顶穿，应改为限制并发度（vitest poolOptions）而不是继续加时间
    // ——那时问题已经是「套件总负载」而不是「本例太慢」。
  }, 60000);
});
