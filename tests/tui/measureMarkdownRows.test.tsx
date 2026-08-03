import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Markdown, measureMarkdownRows } from '../../src/tui/Markdown.js';

/**
 * measureMarkdownRows 的核心不变量：**测量值 ≥ 实际渲染行数**。
 *
 * 这是个单向断言，不是相等断言。允许高估（代价：动态区少用一行），禁止低估
 * （代价：动态帧超过终端高度 → Ink 走全量清屏分支 → 清空 scrollback、历史输出丢失）。
 *
 * 低估的典型来源是表格：一条数据行在单元格折行时渲染成多行，外框另占若干行，
 * 用 `text.split('\n').length` 估算必然不够。qwen-code#6170 踩过同一个坑
 * （按源行数限制 live markdown，表格每数据行实际约 2 行，CJK 折行进一步放大）。
 */

/** 实测渲染行数：真渲染一遍数行，作为断言的右侧。 */
function actualRows(text: string, width?: number): number {
  const { lastFrame } = render(<Markdown text={text} width={width} />);
  const frame = lastFrame() ?? '';
  // 末尾换行不算一行内容
  return frame === '' ? 0 : frame.replace(/\n$/, '').split('\n').length;
}

/** 断言不变量，失败时把两边行数都打出来便于定位。 */
function expectNotUnderCounted(text: string, width?: number): void {
  const measured = measureMarkdownRows(text, width);
  const actual = actualRows(text, width);
  expect(
    measured,
    `低估了渲染行数：测量 ${measured} < 实际 ${actual}（width=${String(width)}）\n---\n${text}\n---`,
  ).toBeGreaterThanOrEqual(actual);
}

describe('measureMarkdownRows 不低估实际渲染行数', () => {
  it('纯段落（基线）', () => {
    expectNotUnderCounted('这是一段普通的说明文字。', 80);
  });

  it('长段落触发折行', () => {
    expectNotUnderCounted('很长的一段话，'.repeat(30), 40);
  });

  it('各级标题', () => {
    expectNotUnderCounted('# 一级\n\n## 二级\n\n### 三级\n\n#### 四级', 80);
  });

  it('无序列表与有序列表', () => {
    expectNotUnderCounted('- 第一项\n- 第二项\n- 第三项', 80);
    expectNotUnderCounted('1. 第一步\n2. 第二步\n3. 第三步', 80);
  });

  it('列表项长文本触发折行（marker 占宽）', () => {
    expectNotUnderCounted(`- ${'列表项内容很长'.repeat(20)}\n- 短项`, 40);
  });

  it('任务列表（checkbox 前缀）', () => {
    expectNotUnderCounted('- [x] 已完成的事\n- [ ] 未完成的事', 80);
  });

  it('代码块（含语言标记，有边框）', () => {
    expectNotUnderCounted('```ts\nconst a = 1;\nconst b = 2;\n```', 80);
  });

  it('代码块无语言标记', () => {
    expectNotUnderCounted('```\nplain code\n```', 80);
  });

  it('代码块超宽代码行折行', () => {
    expectNotUnderCounted('```ts\nconst x = "'.concat('y'.repeat(200), '";\n```'), 40);
  });

  it('引用块与分隔线', () => {
    expectNotUnderCounted('> 引用的一句话\n\n---\n\n后续段落', 80);
  });

  it('ASCII 三列表格', () => {
    const t = ['| a | b | c |', '| --- | --- | --- |', '| 1 | 2 | 3 |', '| 4 | 5 | 6 |'].join('\n');
    expectNotUnderCounted(t, 80);
  });

  it('CJK 表格（宽字符列宽）', () => {
    const t = [
      '| 阶段 | 说明 | 负责人 |',
      '| --- | --- | --- |',
      '| 设计 | 画出组件结构 | 甲 |',
      '| 实现 | 写代码并自测 | 乙 |',
    ].join('\n');
    expectNotUnderCounted(t, 80);
  });

  it('表格单元格超长触发折行（一条数据行占多行）', () => {
    const long = '这个单元格的内容特别长'.repeat(8);
    const t = ['| 项目 | 描述 |', '| --- | --- |', `| 甲 | ${long} |`, '| 乙 | 短 |'].join('\n');
    expectNotUnderCounted(t, 60);
  });

  it('窄宽度触发列宽回退路径', () => {
    const t = ['| 很长的表头一 | 很长的表头二 | 很长的表头三 |', '| --- | --- | --- |', '| aaa | bbb | ccc |'].join('\n');
    // 宽度小到 computeColumnWidths 放弃分配，renderBlock 回退渲染 raw 文本
    expectNotUnderCounted(t, 12);
  });

  it('无 width 时的自然宽度表格', () => {
    const t = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n');
    expectNotUnderCounted(t);
  });

  it('混合文档（标题+段落+列表+表格+代码块）', () => {
    const doc = [
      '# 执行计划',
      '',
      '先说明背景，这一段有一定长度用于观察折行行为。',
      '',
      '## 步骤',
      '',
      '1. 第一步：改造组件',
      '2. 第二步：补充测试',
      '',
      '## 影响文件',
      '',
      '| 文件 | 改动 |',
      '| --- | --- |',
      '| PlanBox.tsx | 新建 |',
      '| App.tsx | 改两处 |',
      '',
      '```ts',
      'export function PlanBox() {}',
      '```',
      '',
      '> 注意：行数估算不得低估。',
    ].join('\n');
    expectNotUnderCounted(doc, 80);
    expectNotUnderCounted(doc, 50);
    expectNotUnderCounted(doc, 120);
  });

  it('多种宽度下均不低估（含窄屏）', () => {
    const doc = ['## 小标题', '', '- 项目一', '- 项目二', '', '| k | v |', '| --- | --- |', '| 甲 | 乙 |'].join('\n');
    for (const w of [20, 30, 40, 60, 80, 100, 160]) expectNotUnderCounted(doc, w);
  });

  it('空文本返回 0 行', () => {
    expect(measureMarkdownRows('', 80)).toBe(0);
  });

  it('估算不过度膨胀（上界合理，不是靠返回巨大值蒙过断言）', () => {
    const doc = ['# 标题', '', '一段话。', '', '- a', '- b'].join('\n');
    const measured = measureMarkdownRows(doc, 80);
    const actual = actualRows(doc, 80);
    // 允许高估，但不该超过实际的 2 倍——否则动态区可用高度被白白吃掉
    expect(measured).toBeLessThanOrEqual(actual * 2);
  });
});
