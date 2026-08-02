import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { QuestionPrompt } from '../../src/tui/QuestionPrompt.js';
import type { AskUserRequest, QuestionAnswers } from '../../src/tools/askUser.js';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const singleReq: AskUserRequest = {
  questions: [
    {
      question: '选哪个部署方案？',
      header: 'Deploy',
      options: [{ label: 'Vercel (Recommended)', description: '零配置' }, { label: '自建服务器' }],
    },
  ],
};

const multiReq: AskUserRequest = {
  questions: [
    {
      question: '要包含哪些模块？',
      options: [{ label: '认证' }, { label: '支付' }, { label: '通知' }],
      multi_select: true,
    },
  ],
};

describe('QuestionPrompt 渲染', () => {
  it('单选：渲染问题、header、选项与自动追加的 Other 项', () => {
    const { lastFrame } = render(
      React.createElement(QuestionPrompt, { req: singleReq, onSubmit: () => {}, onCancel: () => {} }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('选哪个部署方案？');
    expect(out).toContain('Deploy');
    expect(out).toContain('Vercel (Recommended)');
    expect(out).toContain('自建服务器');
    expect(out).toContain('Other');
  });

  it('多选：每项前带复选框，且提示多选', () => {
    const { lastFrame } = render(
      React.createElement(QuestionPrompt, { req: multiReq, onSubmit: () => {}, onCancel: () => {} }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('[ ]');
    expect(out).toContain('多选');
  });

  it('多题：显示进度 (第 1/2 题)', () => {
    const two: AskUserRequest = {
      questions: [
        { question: '问题一', options: [{ label: 'a' }, { label: 'b' }] },
        { question: '问题二', options: [{ label: 'c' }, { label: 'd' }] },
      ],
    };
    const { lastFrame } = render(
      React.createElement(QuestionPrompt, { req: two, onSubmit: () => {}, onCancel: () => {} }),
    );
    expect(lastFrame() ?? '').toContain('第 1/2 题');
  });
});

describe('QuestionPrompt 键盘交互', () => {
  it('单选：数字键 2 直选第二项并回传答案', async () => {
    const onSubmit = vi.fn<(a: QuestionAnswers) => void>();
    const { stdin } = render(
      React.createElement(QuestionPrompt, { req: singleReq, onSubmit, onCancel: () => {} }),
    );
    await delay(20);
    stdin.write('2');
    await delay(20);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toEqual({ '选哪个部署方案？': '自建服务器' });
  });

  it('多选：空格切换勾选后 Enter 提交为数组', async () => {
    const onSubmit = vi.fn<(a: QuestionAnswers) => void>();
    const { stdin, lastFrame } = render(
      React.createElement(QuestionPrompt, { req: multiReq, onSubmit, onCancel: () => {} }),
    );
    await delay(20);
    stdin.write(' '); // 切换当前光标项（认证）
    await delay(20);
    expect(lastFrame() ?? '').toContain('[✓]');
    stdin.write('\r'); // 提交本题
    await delay(20);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toEqual({ '要包含哪些模块？': ['认证'] });
  });

  it('Esc 取消触发 onCancel', async () => {
    const onCancel = vi.fn();
    const { stdin } = render(
      React.createElement(QuestionPrompt, { req: singleReq, onSubmit: () => {}, onCancel }),
    );
    await delay(20);
    stdin.write('\x1B'); // Esc
    await delay(20);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('多题：逐题回答后一次性汇总回传', async () => {
    const two: AskUserRequest = {
      questions: [
        { question: '问题一', options: [{ label: 'a' }, { label: 'b' }] },
        { question: '问题二', options: [{ label: 'c' }, { label: 'd' }] },
      ],
    };
    const onSubmit = vi.fn<(a: QuestionAnswers) => void>();
    const { stdin } = render(
      React.createElement(QuestionPrompt, { req: two, onSubmit, onCancel: () => {} }),
    );
    await delay(20);
    stdin.write('1'); // 第一题选 a
    await delay(20);
    stdin.write('2'); // 第二题选 d
    await delay(20);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toEqual({ 问题一: 'a', 问题二: 'd' });
  });

  it('← 回退上一题并恢复现场，重新回答覆盖旧答案', async () => {
    const two: AskUserRequest = {
      questions: [
        { question: '问题一', options: [{ label: 'a' }, { label: 'b' }] },
        { question: '问题二', options: [{ label: 'c' }, { label: 'd' }] },
      ],
    };
    const onSubmit = vi.fn<(a: QuestionAnswers) => void>();
    const { stdin, lastFrame } = render(
      React.createElement(QuestionPrompt, { req: two, onSubmit, onCancel: () => {} }),
    );
    await delay(20);
    stdin.write('2'); // 问题一选 b
    await delay(20);
    expect(lastFrame() ?? '').toContain('第 2/2 题');
    stdin.write('\x1B[D'); // ← 回退到问题一
    await delay(20);
    const back = lastFrame() ?? '';
    expect(back).toContain('第 1/2 题');
    // 现场恢复：光标停在上次选择的 b 上
    expect(back).toContain('→ [2] b');
    stdin.write('1'); // 改选 a → 跳到未答的问题二（不重走已答）
    await delay(20);
    expect(lastFrame() ?? '').toContain('第 2/2 题');
    stdin.write('1'); // 问题二选 c → 全部答完提交
    await delay(20);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toEqual({ 问题一: 'a', 问题二: 'c' });
  });

  it('回退改题后自动跳到第一题未答题（跳过中间已答题）', async () => {
    const three: AskUserRequest = {
      questions: [
        { question: '问题一', options: [{ label: 'a' }, { label: 'b' }] },
        { question: '问题二', options: [{ label: 'c' }, { label: 'd' }] },
        { question: '问题三', options: [{ label: 'e' }, { label: 'f' }] },
      ],
    };
    const onSubmit = vi.fn<(a: QuestionAnswers) => void>();
    const { stdin, lastFrame } = render(
      React.createElement(QuestionPrompt, { req: three, onSubmit, onCancel: () => {} }),
    );
    await delay(20);
    stdin.write('1'); // 问题一 a
    await delay(20);
    stdin.write('1'); // 问题二 c → 进到问题三
    await delay(20);
    stdin.write('\x1B[D'); // ← 回问题二
    await delay(20);
    stdin.write('\x1B[D'); // ← 回问题一
    await delay(20);
    expect(lastFrame() ?? '').toContain('第 1/3 题');
    stdin.write('2'); // 改选 b → 应直达未答的问题三，不是问题二
    await delay(20);
    expect(lastFrame() ?? '').toContain('第 3/3 题');
    stdin.write('1'); // 问题三 e → 提交
    await delay(20);
    expect(onSubmit.mock.calls[0]![0]).toEqual({ 问题一: 'b', 问题二: 'c', 问题三: 'e' });
  });

  it('多选：回退后勾选态原样恢复', async () => {
    const twoMulti: AskUserRequest = {
      questions: [
        { question: '多选一', options: [{ label: 'x' }, { label: 'y' }], multi_select: true },
        { question: '单选二', options: [{ label: 'p' }, { label: 'q' }] },
      ],
    };
    const { stdin, lastFrame } = render(
      React.createElement(QuestionPrompt, { req: twoMulti, onSubmit: () => {}, onCancel: () => {} }),
    );
    await delay(20);
    stdin.write(' '); // 勾选 x
    await delay(20);
    stdin.write('\r'); // 提交本题 → 进单选二
    await delay(20);
    stdin.write('\x1B[D'); // ← 回多选一
    await delay(20);
    expect(lastFrame() ?? '').toContain('[✓] [1] x');
  });

  it('→ 前进允许先看后面的题；提交闸：答完最后一题先回第一题未答题', async () => {
    const two: AskUserRequest = {
      questions: [
        { question: '问题一', options: [{ label: 'a' }, { label: 'b' }] },
        { question: '问题二', options: [{ label: 'c' }, { label: 'd' }] },
      ],
    };
    const onSubmit = vi.fn<(a: QuestionAnswers) => void>();
    const { stdin, lastFrame } = render(
      React.createElement(QuestionPrompt, { req: two, onSubmit, onCancel: () => {} }),
    );
    await delay(20);
    stdin.write('\x1B[C'); // → 跳到问题二（问题一未答）
    await delay(20);
    expect(lastFrame() ?? '').toContain('第 2/2 题');
    stdin.write('1'); // 答问题二 → 问题一仍未答，跳回问题一而不是提交
    await delay(20);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain('第 1/2 题');
    stdin.write('1'); // 答问题一 → 全部答完提交
    await delay(20);
    expect(onSubmit.mock.calls[0]![0]).toEqual({ 问题一: 'a', 问题二: 'c' });
  });
});

describe('QuestionPrompt Other 自由输入编辑态', () => {
  it('Enter 进入 Other 编辑态后输入文本，Enter 提交为答案', async () => {
    const onSubmit = vi.fn<(a: QuestionAnswers) => void>();
    const { stdin, lastFrame } = render(
      React.createElement(QuestionPrompt, { req: singleReq, onSubmit, onCancel: () => {} }),
    );
    await delay(20);
    stdin.write('\x1B[B'); await delay(15); // ↓ 选项二
    stdin.write('\x1B[B'); await delay(15); // ↓ Other
    stdin.write('\r'); await delay(15);     // Enter 进编辑态
    for (const ch of 'zeabur') { stdin.write(ch); await delay(10); }
    expect(lastFrame() ?? '').toContain('zeabur');
    stdin.write('\r'); await delay(15);     // Enter 提交
    expect(onSubmit.mock.calls[0]![0]).toEqual({ '选哪个部署方案？': 'zeabur' });
  });

  it('↑ 退出 Other 编辑态回导航（草稿保留），可改选预设项', async () => {
    const onSubmit = vi.fn<(a: QuestionAnswers) => void>();
    const { stdin, lastFrame } = render(
      React.createElement(QuestionPrompt, { req: singleReq, onSubmit, onCancel: () => {} }),
    );
    await delay(20);
    stdin.write('\x1B[B'); await delay(15); // ↓ 选项二
    stdin.write('\x1B[B'); await delay(15); // ↓ Other
    stdin.write('\r'); await delay(15);     // 进编辑态
    for (const ch of 'draft') { stdin.write(ch); await delay(10); }
    stdin.write('\x1B[A'); await delay(20); // ↑ 退出编辑态
    // 退出后 Other 行回到未编辑态标签，且能直选预设项
    expect(lastFrame() ?? '').toContain('Other');
    stdin.write('1'); await delay(15);      // 直选选项一
    expect(onSubmit.mock.calls[0]![0]).toEqual({ '选哪个部署方案？': 'Vercel (Recommended)' });
  }, 10000);

  it('Other 编辑态退出后再进入，草稿原样恢复', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(QuestionPrompt, { req: singleReq, onSubmit: () => {}, onCancel: () => {} }),
    );
    await delay(20);
    stdin.write('\x1B[B'); await delay(15);
    stdin.write('\x1B[B'); await delay(15);
    stdin.write('\r'); await delay(15);
    for (const ch of 'keep') { stdin.write(ch); await delay(10); }
    stdin.write('\x1B[A'); await delay(20); // ↑ 退出（草稿 keep 保留在槽位）
    stdin.write('\x1B[B'); await delay(20); // ↓ 回到 Other
    stdin.write('\r'); await delay(15);     // 再进编辑态
    expect(lastFrame() ?? '').toContain('keep');
  }, 10000);

  it('Other 编辑态里 Backspace 删字符', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(QuestionPrompt, { req: singleReq, onSubmit: () => {}, onCancel: () => {} }),
    );
    await delay(20);
    stdin.write('\x1B[B'); await delay(15);
    stdin.write('\x1B[B'); await delay(15);
    stdin.write('\r'); await delay(15);
    for (const ch of 'abcx') { stdin.write(ch); await delay(10); }
    stdin.write('\x7F'); await delay(20); // Backspace 删掉 x
    const out = lastFrame() ?? '';
    expect(out).toContain('abc');
    expect(out).not.toContain('abcx');
  });

  it('Other 编辑态里 Esc 取消整个提问框', async () => {
    const onCancel = vi.fn();
    const { stdin } = render(
      React.createElement(QuestionPrompt, { req: singleReq, onSubmit: () => {}, onCancel }),
    );
    await delay(20);
    stdin.write('\x1B[B'); await delay(15);
    stdin.write('\x1B[B'); await delay(15);
    stdin.write('\r'); await delay(15);     // 进编辑态
    stdin.write('hi'); await delay(15);
    stdin.write('\x1B'); await delay(20);   // Esc
    expect(onCancel).toHaveBeenCalled();
  });
});
