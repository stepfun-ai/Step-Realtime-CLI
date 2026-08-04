import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/loop.js';
import { detectToolCallLeak } from '../../src/agent/runTurn.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { collect, makeFakeProvider, textBlock, thinkingBlock, toolUseBlock } from '../helpers/fakeProvider.js';

function sm(text: string): StoredMessage {
  return stored({ role: 'user', content: text }, { kind: 'user' });
}

/** 造一个只含 text 块的响应消息（检测器只关心 content 形态）。 */
function msgWithText(...texts: string[]): Anthropic.Message {
  return { content: texts.map((t) => textBlock(t)) } as unknown as Anthropic.Message;
}

// 分片拼接：避免本文件自身的字面量在被 agent 读取复述时命中检测（同时也是对判据的诚实用法）。
const LT = '<';
const leakAntml = `${LT}antml:invoke name="bash">\n${LT}antml:parameter name="command">ls${LT}/antml:parameter>`;
const leakPlain = `${LT}invoke name="read_file">\n${LT}parameter name="path">a.ts${LT}/parameter>`;
const leakFnCalls = `${LT}function_calls>\n${LT}invoke name="grep">`;

describe('工具调用通道退化检测（detectToolCallLeak）', () => {
  it('命中真实泄漏的三种形态：antml 前缀 / 裸标签 / function_calls 包裹', () => {
    expect(detectToolCallLeak(msgWithText(leakAntml))).toBe(true);
    expect(detectToolCallLeak(msgWithText(leakPlain))).toBe(true);
    expect(detectToolCallLeak(msgWithText(leakFnCalls))).toBe(true);
  });

  it('泄漏夹在正常叙述中间也命中（真实样本是一屏 XML 混在解释文字里）', () => {
    expect(detectToolCallLeak(msgWithText(`我来看一下这个文件。\n\n${leakPlain}\n\n看完再说。`))).toBe(true);
  });

  it('多个 text 块时任一命中即算（流式可能切成多块）', () => {
    expect(detectToolCallLeak(msgWithText('前言', leakAntml, '后记'))).toBe(true);
  });

  it('判据要求尖括号开启：文档里讨论这些裸词不误报', () => {
    // 本项目文档与设计稿里的真实写法——追踪器第 10 条、健壮性设计 P0.5 节都有这些字面。
    // 裸词判据会让「在本仓库工作的 agent 复述自家文档」必然误触发，这正是收紧到尖括号的理由。
    expect(detectToolCallLeak(msgWithText('修法：正则匹配 invoke\\s+name= / parameter\\s+name= 特征'))).toBe(false);
    expect(detectToolCallLeak(msgWithText('检测 `invoke name=` 与 `function_calls` 这两个标记'))).toBe(false);
    expect(detectToolCallLeak(msgWithText('the function_calls channel degraded'))).toBe(false);
  });

  it('普通正文、空内容、纯 thinking 均不命中', () => {
    expect(detectToolCallLeak(msgWithText('已经改好了，跑一下测试就行。'))).toBe(false);
    expect(detectToolCallLeak(msgWithText(''))).toBe(false);
    expect(detectToolCallLeak({ content: [] } as unknown as Anthropic.Message)).toBe(false);
    // thinking 块里出现标签不算泄漏：思考里推演调用形态不等于把调用打成了正文。
    const thinkingOnly = { content: [thinkingBlock(leakAntml)] } as unknown as Anthropic.Message;
    expect(detectToolCallLeak(thinkingOnly)).toBe(false);
  });

  it('大小写与标签内空格容错（退化输出形态不稳定）', () => {
    expect(detectToolCallLeak(msgWithText(`${LT}ANTML:INVOKE NAME="bash">`))).toBe(true);
    expect(detectToolCallLeak(msgWithText(`${LT} invoke   name = "bash">`))).toBe(true);
  });
});

describe('runAgent：泄漏 → 用户可见 notice（消除静默失败）', () => {
  it('零 tool_use + 正文含调用标签 → 发 notice，且回合仍正常收尾', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [leakAntml], finalContent: [textBlock(leakAntml)] },
    ]);
    const messages: StoredMessage[] = [sm('把文件列一下')];
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages }),
    );

    const notices = events.filter((e) => e.type === 'notice');
    expect(notices).toHaveLength(1);
    // 文案必须讲清「工具没执行 / 文件没动」并给出可操作动作，否则提示等于没提示。
    const msg = (notices[0] as { message: string }).message;
    expect(msg).toMatch(/没有任何工具被真正执行|no tool actually ran/);
    expect(msg).toMatch(/\/model/);
    // 回合判定不变：仍是正常收尾，不伪造错误态。
    expect(events.at(-1)!.type).toBe('turn_done');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('正常回复不发 notice（防误报回归）', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: ['改好了。'], finalContent: [textBlock('改好了。')] },
    ]);
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages: [sm('改一下')] }),
    );
    expect(events.filter((e) => e.type === 'notice')).toHaveLength(0);
  });

  it('检测只在零 tool_use 时运行：有结构化调用时即使正文带标签也不发 notice', async () => {
    // 第一轮：既有真实 tool_use（未知工具名 → 回灌 isError），又在正文里带标签。
    // 调用点收窄的语义是「工具通道还活着就不判退化」，这里断言它不会误报。
    const { provider } = makeFakeProvider([
      {
        textChunks: ['我先看看'],
        finalContent: [textBlock(`我先看看 ${leakPlain}`), toolUseBlock('t1', 'no_such_tool', {})],
        stopReason: 'tool_use',
      },
      { textChunks: ['好了'], finalContent: [textBlock('好了')] },
    ]);
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages: [sm('看看')] }),
    );
    expect(events.filter((e) => e.type === 'notice')).toHaveLength(0);
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('max_tokens 截断优先于泄漏判定：截断分支先返回，不叠两条提示', async () => {
    // 截断时正文可能恰好停在半截标签上，此时该给的是「截断」提示而非「通道退化」。
    const { provider } = makeFakeProvider([
      {
        textChunks: [leakPlain],
        finalContent: [textBlock(leakPlain)],
        stopReason: 'max_tokens',
      },
    ]);
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages: [sm('写长文')] }),
    );
    const notices = events.filter((e) => e.type === 'notice');
    expect(notices).toHaveLength(1);
    expect((notices[0] as { message: string }).message).toMatch(/max_tokens/);
  });
});
