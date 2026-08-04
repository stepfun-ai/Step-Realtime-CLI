import AnthropicSDK from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/loop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import {
  EmptyResponseError,
  isEmptyStreamError,
  isRetryableError,
  RETRY_MAX_ATTEMPTS,
} from '../../src/provider/retry.js';
import { collect, makeFakeProvider, textBlock, thinkingBlock } from '../helpers/fakeProvider.js';

/** 与 SDK MessageStream 空流时抛出的错误同形（不带 HTTP status 的 AnthropicError）。 */
const emptyStreamErr = () =>
  new AnthropicSDK.AnthropicError('stream ended without producing a Message with role=assistant');

function sm(text: string): StoredMessage {
  return stored({ role: 'user', content: text }, { kind: 'user' });
}

describe('空流/空响应的错误分类', () => {
  it('SDK 空流错误与 EmptyResponseError 均可重试；4xx 仍不可重试', () => {
    expect(isEmptyStreamError(emptyStreamErr())).toBe(true);
    expect(isRetryableError(emptyStreamErr())).toBe(true);
    expect(isRetryableError(new EmptyResponseError('empty'))).toBe(true);
    // 带 status 的 APIError 即使消息撞脸也不算空流错误
    const lookalike = new AnthropicSDK.APIError(
      400,
      undefined,
      'stream ended without producing a Message with role=assistant',
      undefined,
    );
    expect(isEmptyStreamError(lookalike)).toBe(false);
    expect(isRetryableError(lookalike)).toBe(false);
    // 普通 Error 不受影响
    expect(isRetryableError(new Error('boom'))).toBe(false);
  });
});

describe('runAgent 空流/空响应重试', () => {
  it('SDK 空流错误 → 自动重试 → 第二次成功：retry 事件 + 正文正常 + 历史只记成功结果', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { throw: emptyStreamErr() },
      { textChunks: ['恢复'], finalContent: [textBlock('恢复')] },
    ]);
    const messages: StoredMessage[] = [sm('问')];
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages }),
    );

    expect(streamCalls()).toBe(2);
    expect(events.some((e) => e.type === 'retry')).toBe(true);
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: '恢复' }]);
    expect(events.at(-1)!.type).toBe('turn_done');
    const assistant = messages.find((m) => m.origin.kind === 'assistant');
    expect(assistant!.message.content).toEqual([{ type: 'text', text: '恢复' }]);
  });

  it('流正常结束但内容为空 → 同样走重试（空响应契约覆盖 OpenAI 通道形态）', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [] },
      { textChunks: ['好了'], finalContent: [textBlock('好了')] },
    ]);
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages: [sm('问')] }),
    );

    expect(streamCalls()).toBe(2);
    expect(events.some((e) => e.type === 'retry')).toBe(true);
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('重试耗尽 → error 事件给中文文案（不再是 SDK 英文原文）', async () => {
    const { provider, streamCalls } = makeFakeProvider(
      Array.from({ length: RETRY_MAX_ATTEMPTS }, () => ({ throw: emptyStreamErr() })),
    );
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages: [sm('问')] }),
    );

    expect(streamCalls()).toBe(RETRY_MAX_ATTEMPTS);
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect((err as { message: string }).message).toContain('空响应');
    expect((err as { message: string }).message).not.toContain('stream ended');
  });

  it('thinking-only 空响应会自动重试：思考不算正文，不该阻断重试（router 实测场景）', async () => {
    // 2026-08-03 实测：step-router-v1 每轮都先吐思考，服务端偶发返回 thinking-only 空响应。
    // 旧行为把思考也算作「已吐字」，于是永远走不进重试分支——诊断文案说「重试往往有效」，
    // 代码却直接报错退出，用户只能手动重发。此处钉住修复后的行为：自动重试并拿到正常回复。
    const { provider, streamCalls } = makeFakeProvider([
      { thinkingChunks: ['先想一下'], textChunks: [], finalContent: [thinkingBlock('先想一下')] },
      { thinkingChunks: ['再想一下'], textChunks: ['正常回复'], finalContent: [textBlock('正常回复')] },
    ]);
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages: [sm('问')] }),
    );

    expect(streamCalls()).toBe(2);
    expect(events.some((e) => e.type === 'retry')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: '正常回复' }]);
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('已流出正文后出错仍不重试：正文重复展示的代价才是真的（守卫口径收窄到正文）', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      // 先吐正文，再在 finalMessage 阶段抛可重试错误
      { textChunks: ['已经写了一半'], finalContent: [], stopReason: 'end_turn' },
      { textChunks: ['不该被调用'], finalContent: [textBlock('不该被调用')] },
    ]);
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages: [sm('问')] }),
    );

    // 正文已进屏幕 → 不重试，直接报错，避免同一段话出现两遍
    expect(streamCalls()).toBe(1);
    expect(events.some((e) => e.type === 'retry')).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('thinking 吃满预算（stop_reason=max_tokens + 仅 thinking 块）→ 不重试、不报空响应，给「调 max_tokens/降档」确定性提示', async () => {
    // 无 thinkingChunks 流出（emittedText=false），直接靠 finalMessage 的 stop_reason 分型：
    // 应走 max_tokens 分支给 thinkingExhausted 提示，而非误判为瞬时空响应去重试。
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [thinkingBlock('思考但没输出正文')], stopReason: 'max_tokens' },
    ]);
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages: [sm('问')] }),
    );

    expect(streamCalls()).toBe(1);
    expect(events.some((e) => e.type === 'retry')).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const notice = events.find((e) => e.type === 'notice');
    expect(notice).toBeDefined();
    expect((notice as { message: string }).message).toContain('思考消耗');
    expect((notice as { message: string }).message).not.toContain('空响应');
    expect(events.at(-1)!.type).toBe('turn_done');
  });
});

describe('空响应诊断上下文（替代无证据的「瞬时故障」归因）', () => {
  it('EmptyResponseError 可携带诊断上下文，且旧调用点只传 message 仍可用', () => {
    const withCtx = new EmptyResponseError('x', {
      hadReasoning: true,
      stopReason: 'end_turn',
      outputTokens: 4096,
      model: 'step-3.7-flash',
    });
    expect(withCtx.context).toEqual({
      hadReasoning: true,
      stopReason: 'end_turn',
      outputTokens: 4096,
      model: 'step-3.7-flash',
    });
    expect(new EmptyResponseError('x').context).toBeUndefined();
  });

  it('错误文案不再断言「瞬时故障」——该归因无证据且实测被证伪', async () => {
    const { provider } = makeFakeProvider(
      Array.from({ length: RETRY_MAX_ATTEMPTS }, () => ({
        // 流正常结束但内容为空：走 EmptyResponseError 路径
        thinkingChunks: [],
        textChunks: [],
        finalContent: [],
      })),
    );
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages: [sm('问')] }),
    );
    const err = events.find((e) => e.type === 'error') as { message: string } | undefined;
    expect(err).toBeDefined();
    expect(err!.message).toContain('空响应');
    // 旧文案的错误归因必须消失
    expect(err!.message).not.toContain('瞬时故障');
    expect(err!.message).not.toContain('请重新发送');
    // 取而代之的是可观测事实
    expect(err!.message).toContain('实测信息');
    expect(err!.message).toContain('结束原因');
  });

  it('产出过思考且真把预算烧光（输出逼近上限）→ 附「降档 / 调大 max_tokens」并说明重发无效', async () => {
    // 思考存在但正文为空、且未流出思考文本（finalContent 有 thinking 但 thinkingChunks 为空），
    // 走 EmptyResponseError 分支并带 hadReasoning=true。
    // 输出 4096 / 上限 4096 = 100%，预算确实被烧光，此时「重发无用」的判断成立。
    const { provider } = makeFakeProvider(
      Array.from({ length: RETRY_MAX_ATTEMPTS }, () => ({
        thinkingChunks: [],
        textChunks: [],
        finalContent: [thinkingBlock('想了很久')],
        usage: { input_tokens: 10, output_tokens: 4096 },
      })),
      4096,
    );
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages: [sm('问')] }),
    );
    const err = events.find((e) => e.type === 'error') as { message: string } | undefined;
    // 不加 if 守卫：断言必须真的跑到，否则测试等于自己发通过许可
    expect(err).toBeDefined();
    expect(err!.message).toContain('已产出思考内容');
    expect(err!.message).toContain('max_tokens');
    expect(err!.message).toContain('重发无用');
  });

  it('正常结束且输出只占预算零头 → 给「重试往往有效」，不得说「重发无用」（用户实测数字：155/65536）', async () => {
    // 这是 2026-08-03 用户实测报告的真实组合：step-3.7-flash、有思考、end_turn、输出 155 tok。
    // 旧判据（hadReasoning && outputTokens > 0）把它诊断成「思考已消耗输出预算」并劝「重发无用」，
    // 而 155/65536 = 0.24%，预算根本没参与——降档与调大都无效，重试才是唯一可能有效的动作。
    const { provider } = makeFakeProvider(
      Array.from({ length: RETRY_MAX_ATTEMPTS }, () => ({
        thinkingChunks: [],
        textChunks: [],
        finalContent: [thinkingBlock('短暂思考')],
        usage: { input_tokens: 10, output_tokens: 155 },
      })),
      65536,
    );
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages: [sm('问')] }),
    );
    const err = events.find((e) => e.type === 'error') as { message: string } | undefined;
    expect(err).toBeDefined();
    // 必须给出正确方向：这不是预算问题，重试有效
    expect(err!.message).toContain('这不是预算问题');
    expect(err!.message).toContain('重试');
    // 必须不出现被推翻的那条建议（反向断言：只删错的不够，还要钉住不许复活）
    expect(err!.message).not.toContain('重发无用');
    expect(err!.message).not.toContain('思考已消耗输出预算');
    // 诊断行要把比值摆出来，让用户自己也能看出「没耗尽」
    expect(err!.message).toContain('155');
    expect(err!.message).toContain('65536');
  });

  it('服务端明确报 max_tokens 时不看比值，直接判预算耗尽', () => {
    // 该分支下服务端已确认截断，比值再小也以服务端信号为准（防御性：该路径通常被上游拦走）。
    const ctx = { hadReasoning: true, stopReason: 'max_tokens', outputTokens: 10, maxTokens: 65536 };
    const err = new EmptyResponseError('x', ctx);
    expect(err.context).toEqual(ctx);
  });

  it('拿不到 maxTokens 时不给任何建议——宁可不给，也不给可能相反的建议', async () => {
    // 不传 maxTokens（模拟自定义 provider 实现省略该字段）。此时无法判断预算是否耗尽，
    // 两条建议恰好相反，猜错就把用户推向无效动作，所以只报事实、不给建议。
    const { provider } = makeFakeProvider(
      Array.from({ length: RETRY_MAX_ATTEMPTS }, () => ({
        thinkingChunks: [],
        textChunks: [],
        finalContent: [thinkingBlock('想了想')],
        usage: { input_tokens: 10, output_tokens: 155 },
      })),
    );
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages: [sm('问')] }),
    );
    const err = events.find((e) => e.type === 'error') as { message: string } | undefined;
    expect(err).toBeDefined();
    // 事实照报
    expect(err!.message).toContain('实测信息');
    expect(err!.message).toContain('已产出思考内容');
    // 两条建议都不出现
    expect(err!.message).not.toContain('重发无用');
    expect(err!.message).not.toContain('这不是预算问题');
  });
});
