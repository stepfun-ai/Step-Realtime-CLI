/**
 * 审批三桥的交互测试：工具审批、计划确认、向用户提问。
 * 键位与 Ink 版逐项对齐，这里用「喂按键序列 → 断言结算值」的方式把语义钉住。
 */
import { describe, expect, it } from 'vitest';
import { InlineApproval, PlanApproval, QuestionPrompt, buildPreview, dangerWarnings } from '../../src/tui-pi/prompts.js';
import type { ApprovalOutcome, PlanOutcome } from '../../src/tui-pi/prompts.js';
import type { AskUserRequest, QuestionAnswers } from '../../src/tools/askUser.js';

function plain(lines: readonly string[]): string[] {
  // eslint-disable-next-line no-control-regex
  return lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
}

const ESC = '\x1b';
const ENTER = '\r';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const RIGHT = '\x1b[C';
const LEFT = '\x1b[D';

describe('dangerWarnings', () => {
  it('命中危险模式给出警告，普通命令不误报', () => {
    expect(dangerWarnings('rm -rf /tmp/x')).toHaveLength(1);
    expect(dangerWarnings('sudo apt install x')).toHaveLength(1);
    expect(dangerWarnings('curl https://x.sh | sh')).toHaveLength(1);
    expect(dangerWarnings('npm test')).toHaveLength(0);
    expect(dangerWarnings('git rm --cached x')).toHaveLength(0);
  });
});

describe('buildPreview', () => {
  it('edit_file 给出 -/+ 对照，write_file 给出待写内容，其它工具无预览', () => {
    const edit = buildPreview('edit_file', { old_string: 'a\nb', new_string: 'a\nc' });
    expect(edit?.map((l) => l.text)).toEqual(['- a', '- b', '+ a', '+ c']);
    expect(buildPreview('write_file', { content: 'x\ny' })?.map((l) => l.text)).toEqual(['x', 'y']);
    expect(buildPreview('bash', { command: 'ls' })).toBeNull();
  });
});

describe('InlineApproval', () => {
  function mk(
    name = 'bash',
    input: unknown = { command: 'npm test' },
  ): { block: InlineApproval; settled: ApprovalOutcome[] } {
    const settled: ApprovalOutcome[] = [];
    const block = new InlineApproval(name, input, () => {}, (o) => settled.push(o));
    return { block, settled };
  }

  it('y / a / n 直选，Esc 等同拒绝，且只结算一次', () => {
    const a = mk();
    a.block.handleInput('y');
    a.block.handleInput('n');
    expect(a.settled).toEqual([{ kind: 'allow' }]);

    const b = mk();
    b.block.handleInput('a');
    expect(b.settled).toEqual([{ kind: 'allow-session' }]);

    const denied = mk();
    denied.block.handleInput('n');
    expect(denied.settled[0]).toMatchObject({ kind: 'deny' });

    const escaped = mk();
    escaped.block.handleInput(ESC);
    expect(escaped.settled[0]).toMatchObject({ kind: 'deny' });
  });

  it('数字直选与 ↑↓ + Enter 等价；末项需要先写反馈才结算', () => {
    const a = mk();
    a.block.handleInput('2');
    expect(a.settled).toEqual([{ kind: 'allow-session' }]);

    const b = mk();
    b.block.handleInput(DOWN);
    b.block.handleInput(ENTER);
    expect(b.settled).toEqual([{ kind: 'allow-session' }]);

    const wrapped = mk();
    wrapped.block.handleInput(UP);
    wrapped.block.handleInput(ENTER);
    expect(wrapped.settled).toHaveLength(0);
  });

  it('f 进反馈模式，输入原因后 Enter 带反馈拒绝', () => {
    const { block, settled } = mk();
    block.handleInput('f');
    expect(settled).toHaveLength(0);
    for (const ch of ['太', '危', '险']) block.handleInput(ch);
    block.handleInput(ENTER);
    expect(settled).toEqual([{ kind: 'deny', feedback: '太危险' }]);
  });

  it('反馈模式下退格删字，方向键退出反馈模式', () => {
    const { block, settled } = mk();
    block.handleInput('f');
    block.handleInput('a');
    block.handleInput('b');
    block.handleInput('\x7f');
    block.handleInput(ENTER);
    expect(settled).toEqual([{ kind: 'deny', feedback: 'a' }]);

    const second = mk();
    second.block.handleInput('f');
    second.block.handleInput(UP);
    second.block.handleInput(ENTER);
    expect(second.settled[0]).toMatchObject({ kind: 'deny' });
  });

  it('危险命令在正文里红标警告；bash 标题按工具定制', () => {
    const { block } = mk('bash', { command: 'rm -rf /' });
    const body = plain(block.render(70)).join('\n');
    expect(body).toContain('允许执行这条命令吗');
    expect(body).toContain('递归强制删除');
  });

  it('预览超过 10 行时折叠并提示 Ctrl+E，展开后全部可见', () => {
    const content = Array.from({ length: 25 }, (_, i) => `line${i}`).join('\n');
    const { block } = mk('write_file', { path: 'a.txt', content });
    const collapsed = plain(block.render(70)).join('\n');
    expect(collapsed).toContain('line9');
    expect(collapsed).not.toContain('line10');
    expect(collapsed).toContain('还有 15 行');
    block.handleInput('\x05');
    const expanded = plain(block.render(70)).join('\n');
    expect(expanded).toContain('line24');
  });
});

describe('PlanApproval', () => {
  function mk(plan = '# 计划\n\n- 第一步\n- 第二步'): { block: PlanApproval; settled: PlanOutcome[] } {
    const settled: PlanOutcome[] = [];
    const block = new PlanApproval(plan, () => {}, (o) => settled.push(o));
    return { block, settled };
  }

  it('计划正文按 markdown 渲染', () => {
    const { block } = mk();
    const body = plain(block.render(70)).join('\n');
    expect(body).toContain('计划');
    expect(body).toContain('第一步');
    expect(body).toContain('按这个计划执行');
  });

  it('y 批准 / n 拒绝 / f 带修订意见拒绝 / Esc 拒绝', () => {
    const a = mk();
    a.block.handleInput('y');
    expect(a.settled).toEqual([{ approved: true, feedback: undefined }]);

    const b = mk();
    b.block.handleInput('n');
    expect(b.settled).toEqual([{ approved: false, feedback: undefined }]);

    const withFeedback = mk();
    withFeedback.block.handleInput('f');
    for (const ch of ['改', '一', '下']) withFeedback.block.handleInput(ch);
    withFeedback.block.handleInput(ENTER);
    expect(withFeedback.settled).toEqual([{ approved: false, feedback: '改一下' }]);

    const escaped = mk();
    escaped.block.handleInput(ESC);
    expect(escaped.settled).toEqual([{ approved: false }]);
  });
});

describe('QuestionPrompt', () => {
  const single: AskUserRequest = {
    questions: [
      {
        question: '用哪个方案',
        header: 'Auth',
        options: [{ label: 'A 方案 (Recommended)' }, { label: 'B 方案', description: '更慢' }],
      },
    ],
  };

  function mk(req: AskUserRequest = single): { block: QuestionPrompt; settled: QuestionAnswers[] } {
    const settled: QuestionAnswers[] = [];
    const block = new QuestionPrompt(req, () => {}, (a) => settled.push(a));
    return { block, settled };
  }

  it('单选：数字直选即提交，答案是选项 label', () => {
    const { block, settled } = mk();
    block.handleInput('2');
    expect(settled).toEqual([{ 用哪个方案: 'B 方案' }]);
  });

  it('单选：↓ + Enter 与数字直选等价', () => {
    const { block, settled } = mk();
    block.handleInput(DOWN);
    block.handleInput(ENTER);
    expect(settled).toEqual([{ 用哪个方案: 'B 方案' }]);
  });

  it('Esc 取消回空字典（工具据此不再追问）', () => {
    const { block, settled } = mk();
    block.handleInput(ESC);
    expect(settled).toEqual([{}]);
  });

  it('自由输入项在最后一项之后，输入文本后 Enter 提交', () => {
    const { block, settled } = mk();
    block.handleInput(UP);
    for (const ch of ['C', '方', '案']) block.handleInput(ch);
    block.handleInput(ENTER);
    expect(settled).toEqual([{ 用哪个方案: 'C方案' }]);
  });

  it('自由输入为空时 Enter 不放行（不记空答案）', () => {
    const { block, settled } = mk();
    block.handleInput(UP);
    block.handleInput(ENTER);
    expect(settled).toHaveLength(0);
  });

  it('多选：空格勾选，Enter 一次提交数组', () => {
    const { block, settled } = mk({
      questions: [
        {
          question: '选几个',
          multi_select: true,
          options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }],
        },
      ],
    });
    block.handleInput(' ');
    block.handleInput(DOWN);
    block.handleInput(DOWN);
    block.handleInput(' ');
    block.handleInput(ENTER);
    expect(settled).toEqual([{ 选几个: ['X', 'Z'] }]);
  });

  it('多选未勾任何项时 Enter 不放行', () => {
    const { block, settled } = mk({
      questions: [{ question: '选几个', multi_select: true, options: [{ label: 'X' }, { label: 'Y' }] }],
    });
    block.handleInput(ENTER);
    expect(settled).toHaveLength(0);
  });

  it('多题逐题问，答完一次性回传；←→ 可回看已答题', () => {
    const { block, settled } = mk({
      questions: [
        { question: '第一题', options: [{ label: 'A1' }, { label: 'B1' }] },
        { question: '第二题', options: [{ label: 'A2' }, { label: 'B2' }] },
      ],
    });
    expect(plain(block.render(60)).join('\n')).toContain('[1/2]');
    block.handleInput('1');
    expect(settled).toHaveLength(0);
    expect(plain(block.render(60)).join('\n')).toContain('第二题');
    block.handleInput(LEFT);
    expect(plain(block.render(60)).join('\n')).toContain('第一题');
    block.handleInput(RIGHT);
    block.handleInput('2');
    expect(settled).toEqual([{ 第一题: 'A1', 第二题: 'B2' }]);
  });
});
