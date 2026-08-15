/**
 * markdownPrep.softenBreaks：段落软换行合并（对齐 Ink 版 softenBreaks 语义）。
 * 钉住：CJK 直接、拉丁补空格、词内标点保护 URL、结构行不合并。
 */
import { describe, expect, it } from 'vitest';
import { softenBreaks } from '../../src/chat/markdownPrep.js';

describe('softenBreaks 软换行合并', () => {
  it('CJK 相邻直接接，不加空格', () => {
    expect(softenBreaks('这是第一行\n接着第二行')).toBe('这是第一行接着第二行');
  });

  it('拉丁两侧补一个空格', () => {
    expect(softenBreaks('hello world\nnext line')).toBe('hello world next line');
  });

  it('一侧 CJK 一侧拉丁也直接接', () => {
    expect(softenBreaks('中文\nenglish')).toBe('中文english');
    expect(softenBreaks('english\n中文')).toBe('english中文');
  });

  it('词内标点 + 小写/数字续接直接接（URL/路径不断行）', () => {
    expect(softenBreaks('见 https://example.com/\ndocs 说明')).toBe('见 https://example.com/docs 说明');
    expect(softenBreaks('src/tui-\npi 目录')).toBe('src/tui-pi 目录');
  });

  it('空行是段落边界，不跨段合并', () => {
    expect(softenBreaks('第一段\n\n第二段')).toBe('第一段\n\n第二段');
  });

  it('结构行不参与合并：标题/列表/表格/引用/分割线', () => {
    expect(softenBreaks('# 标题\n正文')).toBe('# 标题\n正文');
    expect(softenBreaks('正文\n- 列表项')).toBe('正文\n- 列表项');
    expect(softenBreaks('| a | b |\n| c | d |')).toBe('| a | b |\n| c | d |');
    expect(softenBreaks('> 引用\n第二行')).toBe('> 引用\n第二行');
    expect(softenBreaks('上文\n---\n下文')).toBe('上文\n---\n下文');
    expect(softenBreaks('1. 第一\n2. 第二')).toBe('1. 第一\n2. 第二');
  });

  it('围栏代码块内一个字都不动', () => {
    const src = '```ts\nconst a =\n1;\nconst b = 2;\n```\n段落一\n段落二';
    expect(softenBreaks(src)).toBe('```ts\nconst a =\n1;\nconst b = 2;\n```\n段落一段落二');
  });

  it('列表项内的续行不合并进列表项（保守方向）', () => {
    expect(softenBreaks('- 第一项\n- 第二项')).toBe('- 第一项\n- 第二项');
  });

  it('连续多行段落逐行合并成一行', () => {
    expect(softenBreaks('甲\n乙\n丙')).toBe('甲乙丙');
  });
});
