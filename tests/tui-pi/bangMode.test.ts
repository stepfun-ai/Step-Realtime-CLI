/**
 * `!` bash 输入模式的接线防漂移测试。
 *
 * PiChat 本体无法实例化（构造函数摸真实 tty，见 wiring.test.ts 头注），
 * 这里用读源码断言把关键接线钉住：
 * - 提交分流：! 前缀走 runBangCommand 而不是 runTurn（发去模型就完了）
 * - goal steer 豁免：bash 命令不能被当留言拼进自主轮注入
 * - 执行复用 bashTool.execute（shell 解析/超时与模型侧同语义），且不过审批
 * - 上下文注入带 bash-input/bash-output 标签（模型后续回合可见）
 * - 视觉信号：提示符变色 + footer 提示（用户必须一眼看出这条不会发给模型）
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const piChat = readFileSync(join(repoRoot, 'src', 'tui-pi', 'PiChat.ts'), 'utf8');

describe('! bash 输入模式接线', () => {
  it('dispatchText：! 前缀走 runBangCommand，其余走 runTurn', () => {
    const start = piChat.indexOf('private async dispatchText');
    expect(start).toBeGreaterThan(-1);
    const body = piChat.slice(start, start + 600);
    expect(body).toContain("text.startsWith('!')");
    expect(body).toContain('this.runBangCommand(');
    expect(body).toContain('this.runTurn(text)');
  });

  it('onSubmit 与 finishTurn 的队列续发都走 dispatchText（排队路径不分叉）', () => {
    const submit = piChat.slice(piChat.indexOf('private async onSubmit'), piChat.indexOf('private async dispatchText'));
    expect(submit).toContain('await this.dispatchText(text)');
    const finish = piChat.slice(piChat.indexOf('private async finishTurn'));
    expect(finish).toContain('await this.dispatchText(text)');
  });

  it('goal active 时 bash 命令不走 steer（本地执行不能当留言拼给模型）', () => {
    const submit = piChat.slice(piChat.indexOf('private async onSubmit'), piChat.indexOf('private async dispatchText'));
    expect(submit).toContain('!isBang && this.goal.get()');
  });

  it('bash 命令不进提示词历史（历史隔离）', () => {
    const submit = piChat.slice(piChat.indexOf('private async onSubmit'), piChat.indexOf('private async dispatchText'));
    expect(submit).toContain('if (!isBang) this.editor.addToHistory(text)');
  });

  it('执行复用 bashTool.execute 且注入带标签的上下文', () => {
    const start = piChat.indexOf('private async runBangCommand');
    expect(start).toBeGreaterThan(-1);
    const body = piChat.slice(start, start + 2000);
    expect(body).toContain('bashTool.execute({ command }, this.deps.ctx)');
    expect(body).toContain('<bash-input>');
    expect(body).toContain('<bash-output>');
    // 直接调 execute，不过 decide/审批——亲手敲命令就是授权
    expect(body).not.toContain('decide(');
  });

  it('视觉信号：! 开头时提示符变色 + footer 提示', () => {
    expect(piChat).toContain("this.editor.getText().startsWith('!')");
    expect(piChat).toContain("t('input.bangHint')");
  });

  it('i18n 键存在（zh/en 两侧）', () => {
    const i18n = readFileSync(join(repoRoot, 'src', 'i18n.ts'), 'utf8');
    expect(i18n).toContain("'input.bangHint': 'bash 模式：命令在本地执行，输出会注入上下文'");
    expect(i18n).toContain("'input.bangHint': 'bash mode: runs locally, output is injected into context'");
  });
});
