/**
 * 审批三桥的交互测试：工具审批、计划确认、向用户提问。
 * 键位与 Ink 版逐项对齐，这里用「喂按键序列 → 断言结算值」的方式把语义钉住。
 */
import { describe, expect, it } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
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
    expect(buildPreview('write_file', { content: 'x\ny' })?.map((l) => l.text)).toEqual(['  1 │ x', '  2 │ y']);
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

  it('c 允许并附言：进反馈模式，Enter 带回 allow + 附言（附言由调用方排队送达模型）', () => {
    const { block, settled } = mk();
    block.handleInput('c');
    expect(settled).toHaveLength(0); // requiresFeedback：先收附言
    for (const ch of ['下', '次', '先', '跑', '测', '试']) block.handleInput(ch);
    block.handleInput(ENTER);
    expect(settled).toEqual([{ kind: 'allow', feedback: '下次先跑测试' }]);
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

  it('短计划不折叠，底部无折叠提示', () => {
    const { block } = mk('# 计划\n\n- 第一步');
    const body = plain(block.render(70)).join('\n');
    expect(body).toContain('计划');
    expect(body).toContain('第一步');
    expect(body).not.toContain('Ctrl+E');
  });

  it('超长计划默认折叠到前 10 行，Ctrl+E 展开', () => {
    const longPlan = '# 计划\n\n' + Array.from({ length: 20 }, (_, i) => `- 步骤 ${i + 1}`).join('\n');
    const { block } = mk(longPlan);
    const collapsed = plain(block.render(70)).join('\n');
    expect(collapsed).toContain('步骤 1');
    expect(collapsed).not.toContain('步骤 11');
    expect(collapsed).toContain('Ctrl+E');

    block.handleInput('\x05'); // Ctrl+E
    const expanded = plain(block.render(70)).join('\n');
    expect(expanded).toContain('步骤 11');
    expect(expanded).toContain('步骤 20');
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
    block.handleInput(ENTER); // 进入编辑态
    for (const ch of ['C', '方', '案']) block.handleInput(ch);
    block.handleInput(ENTER); // 提交
    expect(settled).toEqual([{ 用哪个方案: 'C方案' }]);
  });

  it('自由输入为空时 Enter 不放行（不记空答案）', () => {
    const { block, settled } = mk();
    block.handleInput(UP);
    block.handleInput(ENTER);
    expect(settled).toHaveLength(0);
  });

  it('Other 行上 ←→ 移动文本光标而非切题（编辑态下渲染画了 ▌ 光标就必须移得动）', () => {
    // ink 版模式：导航态 ←→ 切题，编辑态（单题）←→ 移动文本光标。
    const { block, settled } = mk({
      questions: [
        { question: '第一题', options: [{ label: 'A1' }, { label: 'B1' }] },
      ],
    });
    block.handleInput(UP); // 光标到 Other 行
    block.handleInput(ENTER); // 进入编辑态
    for (const ch of ['a', 'b', 'c']) block.handleInput(ch);
    block.handleInput(LEFT); // 文本光标左移一格
    block.handleInput(RIGHT); // 移回文本末尾
    expect(plain(block.render(60)).join('\n')).toContain('第一题'); // 没切走
    block.handleInput('X'); // 光标回到末尾 → abcX
    block.handleInput(ENTER); // 提交
    expect(settled).toEqual([{ 第一题: 'abcX' }]);
  });

  it('自由输入行渲染成 [n] 其他 标签，而不是 [？] 问号（否则用户看不出这是个可选入口）', () => {
    // 缺口：此前 pi 版把自由输入项画成 [?] 一个问号，选项是 [1][2]，突然冒出 [?] 像个
    // 提示符而非选项。对齐 ink 版（[n] 其他）与某 pi-tui 对照实现（❯ 粗光标）。
    const { block } = mk();
    const lines = plain(block.render(80));
    const otherLine = lines.find((l) => l.includes('Other'));
    expect(otherLine, '自由输入行应带 Other 标签').toBeDefined();
    expect(otherLine!).toMatch(/\[\d+\]\s+Other/);
    expect(lines.some((l) => l.includes('[?]')), '不应再用 [?] 问号占位').toBe(false);
  });

  it('Other 编辑态超长输入不截断成省略号、光标始终在可视区（横向滚动）', () => {
    // 缺口：此前 Other 编辑态把整段输入拼一行后 truncateToWidth，长文本末尾被砍成 …，
    // 光标 ▌ 第一个被吃掉。修复后横向滚动，行不超宽、末尾字符可见、无省略号。
    const { block } = mk({
      questions: [{ question: '输入点什么', options: [{ label: 'A' }] }],
    });
    block.handleInput(DOWN); // 光标到 Other 行
    block.handleInput(ENTER); // 进入编辑态
    const long = '需要一段超过终端宽度的自由输入内容来触发横向滚动'.repeat(2);
    for (const ch of long) block.handleInput(ch); // 逐字符输入，光标停在末尾
    const width = 40;
    const lines = block.render(width);
    for (const l of lines) {
      expect(visibleWidth(l), `行超宽: ${plain([l]).join('')}`).toBeLessThanOrEqual(width);
    }
    const otherLine = lines.find((l) => plain([l]).join('').includes('Other'));
    expect(otherLine, '应找到 Other 行').toBeDefined();
    expect(plain([otherLine!]).join('')).not.toContain('...'); // 无省略号截断
    expect(plain([otherLine!]).join('')).toContain(long.slice(-1)); // 末尾字符可见
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

  it('3 题：答完 Q1/Q2 → ← 回退改 Q1 → Enter 应跳过已答的 Q2 直接到 Q3', () => {
    const { block, settled } = mk({
      questions: [
        { question: 'Q1', options: [{ label: 'a1' }, { label: 'b1' }] },
        { question: 'Q2', options: [{ label: 'a2' }, { label: 'b2' }] },
        { question: 'Q3', options: [{ label: 'a3' }, { label: 'b3' }] },
      ],
    });
    // 顺序答 Q1=A1, Q2=B2
    block.handleInput('1'); // Q1 → a1，自动跳到 Q2
    block.handleInput('2'); // Q2 → b2，自动跳到 Q3
    expect(plain(block.render(60)).join('\n')).toContain('Q3');
    // ← 回退到 Q1 改答案
    block.handleInput(LEFT); // Q3 → Q2
    block.handleInput(LEFT); // Q2 → Q1
    expect(plain(block.render(60)).join('\n')).toContain('Q1');
    // 改答案为 b1，Enter → 应跳过已答的 Q2，直接到 Q3（而非机械 +1 回到 Q2）
    block.handleInput('2'); // Q1 → b1
    expect(plain(block.render(60)).join('\n')).toContain('Q3');
    expect(settled).toHaveLength(0); // 还没答完
    // 答 Q3，全部答完 → settle
    block.handleInput('1'); // Q3 → a3
    expect(settled).toEqual([{ Q1: 'b1', Q2: 'b2', Q3: 'a3' }]);
  });

  it('3 题全答完后再回退改一题，Enter 不重复 settle（settled 守卫）', () => {
    const { block, settled } = mk({
      questions: [
        { question: 'Q1', options: [{ label: 'a1' }, { label: 'b1' }] },
        { question: 'Q2', options: [{ label: 'a2' }, { label: 'b2' }] },
        { question: 'Q3', options: [{ label: 'a3' }, { label: 'b3' }] },
      ],
    });
    block.handleInput('1'); // Q1 → a1
    block.handleInput('1'); // Q2 → a2
    block.handleInput('1'); // Q3 → a3 → settle（全答完）
    expect(settled).toEqual([{ Q1: 'a1', Q2: 'a2', Q3: 'a3' }]);
    // 回退改 Q2（settle 后 settled 守卫阻止重复提交）
    block.handleInput(LEFT); // → Q2
    block.handleInput(LEFT); // → Q1
    block.handleInput(RIGHT); // → Q2
    block.handleInput('2'); // Q2 → b2，但 settled 已为 true，不重复 settle
    expect(settled).toHaveLength(1);
  });
});

describe('ChoiceBlock render 出口宽度安全', () => {
  // pi-tui doRender 对 visibleWidth 超终端宽的行直接 throw 崩溃。render 出口必须对每一行
  // （含 renderBody 的题干/警告、renderChoices 的选项）截断——基类 render 统一负责。
  it('窄终端下渲染出的每一行 visibleWidth 都不超 width（ask_user/审批/计划共用基类）', () => {
    const longReq: AskUserRequest = {
      questions: [
        {
          question: '这是一段非常长的题干，用来验证窄终端下 render 出口是否对每一行都做了截断，否则会撑超宽度触发 pi-tui doRender 断言崩溃',
          header: 'Width',
          options: [
            { label: '一个超级长的选项标签，用来验证 renderChoices 与 renderBody 两条路径都被出口截断覆盖' },
            { label: 'B 方案', description: '描述也尽量长一点，覆盖 renderChoices 内逐行截断与 renderBody 题干截断' },
          ],
        },
      ],
    };
    const settled: QuestionAnswers[] = [];
    const block = new QuestionPrompt(longReq, () => {}, (a) => settled.push(a));
    for (const w of [40, 50, 67]) {
      const lines = plain(block.render(w));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(visibleWidth(line), `width=${w} 出现超宽行`).toBeLessThanOrEqual(w);
      }
    }
  });
});
