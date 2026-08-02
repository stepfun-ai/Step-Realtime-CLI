import React from 'react';
import { Box, Static, Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../../src/tui/Markdown.js';
import { MessageItem, MessageList, countSettledItems } from '../../src/tui/MessageList.js';
import type { DisplayItem } from '../../src/tui/types.js';

/** 去掉 ANSI 颜色码，便于对纯文本内容断言。 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** 线上复现样本：标题渲染了，但标题下方的正文、列表、分隔线在 TUI 中缺失。 */
const SAMPLE = [
  '## v9 结果',
  '',
  '---',
  '',
  '### 关键发现：实验 2 等了 51.6 秒',
  '',
  '实验 2 不是"超时"，而是等了 51.6 秒后被限流了。这意味着：',
  '',
  '- 请求发出去了',
  '- 服务端**确实在处理**',
  '',
  '所以结论很明确：',
  '',
  '1. **step-explore 能处理这些请求，但需要 60-120 秒**',
  '',
].join('\n');

describe('assistant markdown 正文缺失复现', () => {
  it('标题下方的正文、列表、分隔线全部渲染', () => {
    const { lastFrame } = render(React.createElement(Markdown, { text: SAMPLE }));
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('v9 结果');
    expect(out).toContain('关键发现');
    expect(out).toContain('─'); // hr 分隔线
    expect(out).toContain('实验 2 不是"超时"');
    expect(out).toContain('请求发出去了');
    expect(out).toContain('确实在处理');
    expect(out).toContain('所以结论很明确');
    expect(out).toContain('step-explore 能处理这些请求');
  });

  it('经 MessageList（assistant 条目）渲染，正文同样完整', () => {
    const items: DisplayItem[] = [{ kind: 'assistant', text: SAMPLE }];
    const { lastFrame } = render(<MessageList items={items} />);
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('v9 结果');
    expect(out).toContain('实验 2 不是"超时"');
    expect(out).toContain('请求发出去了');
    expect(out).toContain('step-explore 能处理这些请求');
  });

  it('经 MessageList 尾部锚定窗口（maxRows 足够大时）正文不丢失', async () => {
    const items: DisplayItem[] = [{ kind: 'assistant', text: SAMPLE }];
    const { lastFrame } = render(<MessageList items={items} busy={false} maxRows={40} />);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).not.toContain('已隐藏');
    expect(out).toContain('v9 结果');
    expect(out).toContain('实验 2 不是"超时"');
    expect(out).toContain('请求发出去了');
    expect(out).toContain('step-explore 能处理这些请求');
  });
});

/** 等测量 effect 落盘（measureElement 在 commit 后跑，隐藏指示晚一帧出现）。 */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** 模拟 App 根布局：单 <Static>（定稿前缀）+ 动态区 MessageList（尾部锚定窗口）。 */
function Harness({
  items,
  busy,
  maxRows,
}: {
  items: DisplayItem[];
  busy: boolean;
  maxRows?: number;
}): React.ReactElement {
  const settledCount = countSettledItems(items, busy);
  const staticEntries: Array<{ kind: 'welcome' } | DisplayItem> = [
    { kind: 'welcome' },
    ...items.slice(0, settledCount),
  ];
  return (
    <Box flexDirection="column">
      <Static items={staticEntries}>
        {(entry, i) =>
          entry.kind === 'welcome' ? (
            <Text key="welcome">WELCOME-BANNER</Text>
          ) : (
            <MessageItem key={i} item={entry} expanded={false} />
          )
        }
      </Static>
      <MessageList items={items.slice(settledCount)} busy={busy} maxRows={maxRows} />
    </Box>
  );
}

describe('assistant markdown 正文缺失复现（App 组合路径）', () => {
  it('busy 流式中渲染样本：动态区尾部锚定，正文尾部可见', async () => {
    const items: DisplayItem[] = [{ kind: 'assistant', text: SAMPLE }];
    const { lastFrame } = render(<Harness items={items} busy={true} maxRows={10} />);
    await tick();
    await tick();
    const out = stripAnsi(lastFrame() ?? '');
    // 尾部锚定：窗口较小时顶部被裁、保留尾部——与「只剩标题」症状相反
    expect(out).toContain('step-explore 能处理这些请求');
  });

  it('流式结束（busy 转 false）样本整体定稿进 Static：正文完整保留', async () => {
    const streaming: DisplayItem[] = [{ kind: 'assistant', text: SAMPLE }];
    const { lastFrame, rerender } = render(<Harness items={streaming} busy={true} maxRows={10} />);
    await tick();
    rerender(<Harness items={streaming} busy={false} maxRows={10} />);
    await tick();
    await tick();
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('v9 结果');
    expect(out).toContain('实验 2 不是"超时"');
    expect(out).toContain('请求发出去了');
    expect(out).toContain('step-explore 能处理这些请求');
  });

  it('逐块流式追加（模拟 text 事件分块到达）后定稿：正文完整保留', async () => {
    // 把样本切成多块模拟流式增量，逐拍 push 进 assistant 条目
    const chunks = [
      '## v9 结果\n\n---\n\n',
      '### 关键发现：实验 2 等了 51.6 秒\n\n',
      '实验 2 不是"超时"，而是等了 51.6 秒后被限流了。这意味着：\n\n',
      '- 请求发出去了\n- 服务端**确实在处理**\n\n',
      '所以结论很明确：\n\n',
      '1. **step-explore 能处理这些请求，但需要 60-120 秒**\n',
    ];
    let text = '';
    const inst = render(<Harness items={[{ kind: 'assistant', text }]} busy={true} maxRows={10} />);
    for (const c of chunks) {
      text += c;
      inst.rerender(<Harness items={[{ kind: 'assistant', text }]} busy={true} maxRows={10} />);
      await tick();
    }
    inst.rerender(<Harness items={[{ kind: 'assistant', text }]} busy={false} maxRows={10} />);
    await tick();
    await tick();
    const out = stripAnsi(inst.lastFrame() ?? '');
    expect(out).toContain('v9 结果');
    expect(out).toContain('实验 2 不是"超时"');
    expect(out).toContain('请求发出去了');
    expect(out).toContain('step-explore 能处理这些请求');
  });
});

/**
 * 贴近线上环境的复现：ink 原生 render + 带 rows/columns 的模拟 TTY，
 * 走真实的 Static 写盘 / 帧擦写 / 清屏分支（ink-testing-library 的 mock stdout 没有 rows，
 * 触发不到这些路径）。拼接所有写入字节，断言正文进入过 stdout。
 */
describe('assistant markdown 正文缺失复现（真实 ink 渲染路径）', () => {
  it('带 rows 的 TTY：流式追加后定稿进 Static，正文全部写入 stdout', async () => {
    const { EventEmitter } = await import('node:events');
    const { render: inkRender } = await import('ink');

    class FakeStdout extends EventEmitter {
      isTTY = true;
      columns = 80;
      rows = 24;
      chunks: string[] = [];
      write(data: string): boolean {
        this.chunks.push(data);
        return true;
      }
      written(): string {
        return this.chunks.join('');
      }
    }
    class FakeStdin extends EventEmitter {
      isTTY = true;
      setRawMode(): void {}
      resume(): void {}
      pause(): void {}
      ref(): void {}
      unref(): void {}
      read(): null {
        return null;
      }
      setEncoding(): void {}
    }
    class FakeStderr extends EventEmitter {
      chunks: string[] = [];
      write(data: string): boolean {
        this.chunks.push(data);
        return true;
      }
    }

    const stdout = new FakeStdout();
    const inst = inkRender(
      <Harness items={[{ kind: 'assistant', text: '' }]} busy={true} maxRows={18} />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
        stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
        debug: false,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    try {
      const chunks = [
        '## v9 结果\n\n---\n\n',
        '### 关键发现：实验 2 等了 51.6 秒\n\n',
        '实验 2 不是"超时"，而是等了 51.6 秒后被限流了。这意味着：\n\n',
        '- 请求发出去了\n- 服务端**确实在处理**\n\n',
        '所以结论很明确：\n\n',
        '1. **step-explore 能处理这些请求，但需要 60-120 秒**\n',
      ];
      let text = '';
      for (const c of chunks) {
        text += c;
        inst.rerender(<Harness items={[{ kind: 'assistant', text }]} busy={true} maxRows={18} />);
        await tick();
      }
      // 定稿：条目从动态区移入 <Static>，全文一次性写入 scrollback
      inst.rerender(<Harness items={[{ kind: 'assistant', text }]} busy={false} maxRows={18} />);
      await tick();
      await tick();
      const all = stripAnsi(stdout.written());
      expect(all).toContain('v9 结果');
      expect(all).toContain('实验 2 不是"超时"');
      expect(all).toContain('请求发出去了');
      expect(all).toContain('step-explore 能处理这些请求');
    } finally {
      inst.unmount();
    }
  });
});
