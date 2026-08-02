import { describe, expect, it } from 'vitest';
import { askUserTool, type AskUserRequest, type QuestionAnswers } from '../../src/tools/askUser.js';

const validReq: AskUserRequest = {
  questions: [
    {
      question: '选哪个方案？',
      options: [{ label: 'A (Recommended)' }, { label: 'B' }],
    },
  ],
};

describe('ask_user 工具', () => {
  it('schema 校验：合法请求通过', () => {
    const r = askUserTool.schema.safeParse(validReq);
    expect(r.success).toBe(true);
  });

  it('schema 校验：选项少于 2 个被拒', () => {
    const r = askUserTool.schema.safeParse({
      questions: [{ question: 'x', options: [{ label: '只有一个' }] }],
    });
    expect(r.success).toBe(false);
  });

  it('schema 校验：选项多于 4 个被拒', () => {
    const r = askUserTool.schema.safeParse({
      questions: [
        {
          question: 'x',
          options: [{ label: '1' }, { label: '2' }, { label: '3' }, { label: '4' }, { label: '5' }],
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('schema 校验：问题为空数组被拒，超过 4 题被拒', () => {
    expect(askUserTool.schema.safeParse({ questions: [] }).success).toBe(false);
    const five = Array.from({ length: 5 }, () => ({
      question: 'x',
      options: [{ label: 'a' }, { label: 'b' }],
    }));
    expect(askUserTool.schema.safeParse({ questions: five }).success).toBe(false);
  });

  it('ctx 无 askUser → fallback 返回不支持（isError）', async () => {
    const r = await askUserTool.execute(validReq, { cwd: process.cwd() });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('不支持');
  });

  it('答案回传：非空答案以 JSON { answers } 返回', async () => {
    const answers: QuestionAnswers = { '选哪个方案？': 'A (Recommended)' };
    const r = await askUserTool.execute(validReq, {
      cwd: process.cwd(),
      askUser: async () => answers,
    });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content)).toEqual({ answers });
  });

  it('答案回传：多选值为数组，原样进 JSON', async () => {
    const answers: QuestionAnswers = { '选哪个方案？': ['A (Recommended)', 'B'] };
    const r = await askUserTool.execute(validReq, {
      cwd: process.cwd(),
      askUser: async () => answers,
    });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content).answers['选哪个方案？']).toEqual(['A (Recommended)', 'B']);
  });

  it('取消（空字典）→ 非 error 的用户取消结果', async () => {
    const r = await askUserTool.execute(validReq, {
      cwd: process.cwd(),
      askUser: async () => ({}),
    });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('取消');
  });
});
