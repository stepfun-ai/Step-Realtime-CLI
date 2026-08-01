import { describe, expect, it } from 'vitest';
import { estimateChromeRows as estimateQuestionRows } from '../../src/tui/QuestionPrompt.js';
import { estimateChromeRows as estimateApprovalRows } from '../../src/tui/ApprovalPrompt.js';
import { displayWidth, wrappedRows } from '../../src/tui/liveBudget.js';
import type { AskUserRequest } from '../../src/tools/askUser.js';

describe('wrappedRows / displayWidth（预算层折行原语）', () => {
  it('宽度未知退化为 1 行；短文本 1 行；超宽按列数上取整', () => {
    expect(wrappedRows('anything', undefined)).toBe(1);
    expect(wrappedRows('abc', 10)).toBe(1);
    expect(wrappedRows('x'.repeat(25), 10)).toBe(3);
  });

  it('宽字符按 2 列（CJK 与 ASCII 混合）', () => {
    expect(displayWidth('移动ab')).toBe(6);
    expect(wrappedRows('移动移动移动', 5)).toBe(3); // 12 列 / 5 = 2.4 → 3 行
  });
});

/**
 * 弹层行数估算的折行精确性（滚动跳顶修复：预算下溢 → 动态帧超高 → Ink 清屏抹 scrollback）。
 * 不变量：无 termCols 时退化为旧结构估算（每逻辑行 1 行）；有 termCols 时长题干/长选项描述/
 * 长预览行的折行必须计入，估算不得小于实际渲染行数。
 */

describe('QuestionPrompt 行数估算', () => {
  const shortReq: AskUserRequest = {
    questions: [{ question: '短问题', options: [{ label: 'A' }, { label: 'B' }] }],
  };

  it('无 termCols：退化为结构估算 6 + 最多选项数', () => {
    expect(estimateQuestionRows(shortReq)).toBe(8); // 1 margin + 2 border + 题干1 + 选项2 + Other1 + 提示1
  });

  it('termCols 足够宽：短内容与结构估算一致（无折行）', () => {
    expect(estimateQuestionRows(shortReq, 200)).toBe(8);
  });

  it('窄终端 + 长选项描述：折行被精确计入', () => {
    const req: AskUserRequest = {
      questions: [
        { question: '短问题', options: [{ label: 'A' }, { label: 'B', description: 'x'.repeat(100) }] },
      ],
    };
    // 内宽 36：选项 B 行 '→ [2] B  — ' + 100x = 111 列 → 4 行；提示行 44 列 → 2 行
    // body = 题干1 + A1 + B4 + Other1 + 提示2 = 9 → 总 1+2+9 = 12
    expect(estimateQuestionRows(req, 40)).toBe(12);
    expect(estimateQuestionRows(req, 40)).toBeGreaterThan(estimateQuestionRows(req));
  });

  it('多题：预算取最高一题（换题时 App 不重算）', () => {
    const req: AskUserRequest = {
      questions: [
        { question: '短问题', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }] },
        { question: '短问题', options: [{ label: 'A' }, { label: 'B', description: 'y'.repeat(200) }] },
      ],
    };
    // 第二题更高：题干（含计数）1 + A1 + B(211列→6行) + Other1 + 提示2 = 11 → 总 14
    expect(estimateQuestionRows(req, 40)).toBe(14);
    // 无 termCols 时按最多选项数（4）退化：6 + 4 = 10
    expect(estimateQuestionRows(req)).toBe(10);
  });
});

describe('ApprovalPrompt 行数估算', () => {
  it('无 termCols：与旧结构估算等价', () => {
    expect(estimateApprovalRows({ name: 'bash', input: { command: 'ls' } })).toBe(10);
    // write_file 3 行预览（无 path/command/pattern → 无摘要行）
    expect(estimateApprovalRows({ name: 'write_file', input: { content: 'a\nb\nc' } })).toBe(12);
  });

  it('长 bash 命令摘要折行计入（121 列摘要在内宽 76 下为 2 行）', () => {
    const req = { name: 'bash', input: { command: 'x'.repeat(200) } };
    expect(estimateApprovalRows(req, 80)).toBe(11); // 比退化估算多 1 行
  });

  it('write_file 长行预览折行计入', () => {
    const req = { name: 'write_file', input: { content: 'x'.repeat(150) } };
    // 预览行 '  1 │ ' + 150x = 156 列，内宽 76 → 3 行；退化估算只算 1 行
    expect(estimateApprovalRows(req, 80)).toBe(12);
    expect(estimateApprovalRows(req)).toBe(10);
  });

  it('宽终端短命令：与结构估算一致', () => {
    expect(estimateApprovalRows({ name: 'bash', input: { command: 'ls -la' } }, 200)).toBe(10);
  });
});
