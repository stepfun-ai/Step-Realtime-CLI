import React from 'react';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { OffsetViewport } from '../../src/tui/OffsetViewport.js';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const settle = async (): Promise<void> => {
  await tick();
  await tick();
};

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

const rows10 = Array.from({ length: 10 }, (_, i) => `r${String(i + 1).padStart(2, '0')}`);

const renderRows = (offset: number, maxRows: number, onNaturalHeight: (h: number) => void = () => {}) =>
  render(
    <OffsetViewport offset={offset} maxRows={maxRows} onNaturalHeight={onNaturalHeight}>
      {rows10.map((r) => (
        <Text key={r} wrap="truncate">
          {r}
        </Text>
      ))}
    </OffsetViewport>,
  );

describe('OffsetViewport 偏移窗口', () => {
  it('offset=0：露出前 maxRows 行，自然高经回调上报', async () => {
    let natural = -1;
    const { lastFrame } = renderRows(0, 3, (h) => {
      natural = h;
    });
    await settle();
    const lines = frameLines(lastFrame() ?? '');
    expect(lines).toEqual(['r01', 'r02', 'r03']);
    expect(natural).toBe(10);
  });

  it('offset=3：负 margin 平移，窗口露出 [offset, offset+maxRows)', async () => {
    const { lastFrame } = renderRows(3, 3);
    await settle();
    const lines = frameLines(lastFrame() ?? '');
    expect(lines).toEqual(['r04', 'r05', 'r06']);
  });

  it('offset 变化（rerender）：窗口同步平移，帧高恒 ≤ 预算', async () => {
    const { lastFrame, rerender } = renderRows(0, 3);
    await settle();
    const viewport = (o: number): React.ReactElement => (
      <OffsetViewport offset={o} maxRows={3} onNaturalHeight={() => {}}>
        {rows10.map((r) => (
          <Text key={r} wrap="truncate">
            {r}
          </Text>
        ))}
      </OffsetViewport>
    );
    rerender(viewport(7));
    await settle();
    const lines = frameLines(lastFrame() ?? '');
    expect(lines).toEqual(['r08', 'r09', 'r10']);
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it('带 marginTop 的子块：行级裁剪落在块内部（不是整块丢弃）', async () => {
    // 自然高 7：sep 1 + margin 1 + blk 3 + margin 1 + tail 1；offset 2 → 窗口 [2, 6)
    const { lastFrame } = render(
      <OffsetViewport offset={2} maxRows={4} onNaturalHeight={() => {}}>
        <Box flexDirection="column">
          <Text wrap="truncate">sep</Text>
          <Box marginTop={1}>
            <Text>blk1{'\n'}blk2{'\n'}blk3</Text>
          </Box>
          <Box marginTop={1}>
            <Text>tail</Text>
          </Box>
        </Box>
      </OffsetViewport>,
    );
    await settle();
    const lines = frameLines(lastFrame() ?? '');
    expect(lines).toContain('blk1');
    expect(lines).toContain('blk3');
    expect(lines).not.toContain('sep');
    expect(lines).not.toContain('tail');
  });

  it('内容不超预算：offset 0 原样渲染，无裁剪', async () => {
    const { lastFrame } = render(
      <OffsetViewport offset={0} maxRows={10} onNaturalHeight={() => {}}>
        <Text wrap="truncate">only-line</Text>
      </OffsetViewport>,
    );
    await settle();
    expect(frameLines(lastFrame() ?? '')).toEqual(['only-line']);
  });
});
