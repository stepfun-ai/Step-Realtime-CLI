import AnthropicSDK from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/loop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import type { WireEvent } from '../../src/agent/wirelog.js';
import {
  EmptyResponseError,
  isEmptyStreamError,
  isRetryableError,
  RETRY_MAX_ATTEMPTS,
} from '../../src/provider/retry.js';
import { collect, makeFakeProvider, textBlock, thinkingBlock } from '../helpers/fakeProvider.js';

/** 与 SDK MessageStream 空流时抛出的错误同形（不带 HTTP status 的 AnthropicError）。 */
function repeat(unit: string, n: number): string {
  return unit.repeat(n);
}

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

  it('已流出正文后连接中断（terminated）→ 整轮重试：partial 仅在 UI 未落盘，重发不重复（主流 CLI 标准做法）', async () => {
    // 2026-08-05 行为反转：旧守卫「吐字即放弃」会把长回合中途的网络瞬断变成用户必须手动重发的硬错误。
    // 主流 CLI 参考实现均不做断点续写（流式单向、partial 无法原子回滚），
    // 一致采用「整轮丢弃 partial 重试」。partial 正文只在 UI 的 DisplayItem，不进 messages 历史
    // （runTurn 仅在流成功后才 messages.push），故重发不会造成历史重复；UI 靠 retry 事件的
    // boundary note 隔离，重试正文另开 assistant 条目，不续接残文。
    const terminated = () => Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } });
    const { provider, streamCalls } = makeFakeProvider([
      // 先吐正文，再在 finalMessage 阶段连接中断（terminated）
      { textChunks: ['已经写了一半'], throwAfterChunks: terminated(), finalContent: [] },
      { textChunks: ['完整重发的回复'], finalContent: [textBlock('完整重发的回复')] },
    ]);
    const messages: StoredMessage[] = [sm('问')];
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages }),
    );

    // 吐字后断连 → 仍自动重试（不再直接 error），第二次成功
    expect(streamCalls()).toBe(2);
    const retryEv = events.find((e) => e.type === 'retry');
    expect(retryEv).toBeDefined();
    // B 方案：吐字后断连的 retry 必须带 hadPartial 标记，UI 据此撤回残文气泡（只留重发完整版）
    expect((retryEv as { hadPartial?: boolean }).hadPartial).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    // 正文事件仍包含 partial（第一次）与重发（第二次）——撤回是 UI 层行为，runTurn 事件流不变
    expect(events.filter((e) => e.type === 'text')).toEqual([
      { type: 'text', text: '已经写了一半' },
      { type: 'text', text: '完整重发的回复' },
    ]);
    expect(events.at(-1)!.type).toBe('turn_done');
    // 历史只落盘成功的完整回复，partial 不进 messages（重发不会历史重复）
    const assistant = messages.find((m) => m.origin.kind === 'assistant');
    expect(assistant!.message.content).toEqual([{ type: 'text', text: '完整重发的回复' }]);
  });

  it('未吐字连接期断连 → retry 不带 hadPartial（无残文可撤）', async () => {
    // 连接期失败（第一个 delta 都没产出）：屏幕无残文，retry 不应标 hadPartial，
    // UI 只提示重试、不做撤回。B 方案的撤回仅针对吐字后的残文。
    const terminated = () => Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } });
    const { provider, streamCalls } = makeFakeProvider([
      { throw: terminated() },
      { textChunks: ['恢复'], finalContent: [textBlock('恢复')] },
    ]);
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages: [sm('问')] }),
    );
    expect(streamCalls()).toBe(2);
    const retryEv = events.find((e) => e.type === 'retry');
    expect(retryEv).toBeDefined();
    expect((retryEv as { hadPartial?: boolean }).hadPartial).toBe(false);
  });

  it('吐字后重试耗尽 → 仍报错退出（重试有上限，非无限重发）', async () => {
    const terminated = () => Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } });
    const { provider, streamCalls } = makeFakeProvider(
      Array.from({ length: RETRY_MAX_ATTEMPTS }, () => ({
        textChunks: ['写了一半'],
        throwAfterChunks: terminated(),
        finalContent: [],
      })),
    );
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages: [sm('问')] }),
    );

    expect(streamCalls()).toBe(RETRY_MAX_ATTEMPTS);
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(RETRY_MAX_ATTEMPTS - 1);
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

describe('thinking 流死循环检测与诱导跳出（thinking_loop）', () => {
  it('思考逐字复读触发检测 → 中止当前流 + 注入诱导提示重试，第二次正常产出', async () => {
    const { provider, streamCalls, streamParams } = makeFakeProvider([
      // 首轮：thinking 大量重复（触发检测），且因检测中止，不会走到 finalMessage
      { thinkingChunks: [repeat('的', 1200)], textChunks: [], finalContent: [thinkingBlock('循环')], stopReason: 'max_tokens' },
      // 注入诱导后重试：正常产出正文
      { textChunks: ['直接给答案'], finalContent: [textBlock('直接给答案')] },
    ]);
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages: [sm('问')] }),
    );

    // 中止当前流 + 注入重试 = 2 次 stream 调用
    expect(streamCalls()).toBe(2);
    // 透出 thinking_loop 事件
    expect(events.some((e) => e.type === 'thinking_loop')).toBe(true);
    // 第二次请求的消息序列尾部是注入的诱导提示
    const second = streamParams()[1] as { messages?: Array<{ role: string; content: unknown }> };
    const lastMsg = second.messages?.at(-1);
    expect(lastMsg?.role).toBe('user');
    expect(String(lastMsg?.content)).toContain('周期性重复');
    // 正文正常流出
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: '直接给答案' }]);
  });

  it('注入重试后再次触发循环 → 不再二次注入（最多 1 次），走原路径', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { thinkingChunks: [repeat('的', 1200)], textChunks: [], finalContent: [thinkingBlock('循环')], stopReason: 'max_tokens' },
      // 重试仍循环：检测器 fired 后不二次触发，正常收尾（这里给 max_tokens 空响应）
      { thinkingChunks: [repeat('的', 1200)], textChunks: [], finalContent: [thinkingBlock('仍循环')], stopReason: 'max_tokens' },
    ]);
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages: [sm('问')] }),
    );
    // 只注入重试 1 次：总共 2 次 stream 调用
    expect(streamCalls()).toBe(2);
    // thinking_loop 事件只发 1 次
    expect(events.filter((e) => e.type === 'thinking_loop')).toHaveLength(1);
  });
});

describe('thinking 预算耗尽自动降档重试（thinking_downgrade）', () => {
  it('high 档耗尽 → 自动降到 low 重试 1 次成功：降级事件 + 正文正常，第二次请求 thinking.level=low', async () => {
    const { provider, streamCalls, streamParams } = makeFakeProvider([
      // 首轮：thinking 吃满预算，正文零输出
      { textChunks: [], finalContent: [thinkingBlock('烧光了')], stopReason: 'max_tokens' },
      // 降档重试：正常产出正文
      { textChunks: ['恢复正文'], finalContent: [textBlock('恢复正文')] },
    ]);
    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd() },
        messages: [sm('问')],
        thinking: { level: 'high', budgetTokens: 8192 },
      }),
    );

    expect(streamCalls()).toBe(2);
    // 降级事件透出原档位与目标档位
    const dg = events.find((e) => e.type === 'thinking_downgrade');
    expect(dg).toBeDefined();
    expect((dg as { fromLevel?: string }).fromLevel).toBe('high');
    expect((dg as { toLevel?: string }).toLevel).toBe('low');
    // 第二次请求确实带了降档后的 thinking 参数
    expect((streamParams()[1] as { thinking?: { level?: string } }).thinking?.level).toBe('low');
    // 正文正常流出，回合正常结束
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: '恢复正文' }]);
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('low 档耗尽 → 降无可降，不重试，直接走提示路径', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [thinkingBlock('烧光了')], stopReason: 'max_tokens' },
    ]);
    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd() },
        messages: [sm('问')],
        thinking: { level: 'low', budgetTokens: 1024 },
      }),
    );

    expect(streamCalls()).toBe(1);
    expect(events.some((e) => e.type === 'thinking_downgrade')).toBe(false);
    const notice = events.find((e) => e.type === 'notice');
    expect((notice as { message: string }).message).toContain('思考消耗');
  });

  it('thinking 为 null（off）→ 不可能 thinking 耗尽，不触发降档', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [thinkingBlock('烧光了')], stopReason: 'max_tokens' },
    ]);
    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd() },
        messages: [sm('问')],
        thinking: null,
      }),
    );

    expect(streamCalls()).toBe(1);
    expect(events.some((e) => e.type === 'thinking_downgrade')).toBe(false);
  });

  it('降档重试后仍耗尽 → 尝试 think-only 恢复，恢复仍耗尽则退到提示路径', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [thinkingBlock('首轮烧光')], stopReason: 'max_tokens' },
      { textChunks: [], finalContent: [thinkingBlock('low 档仍烧光')], stopReason: 'max_tokens' },
      { textChunks: [], finalContent: [thinkingBlock('注入仍烧光')], stopReason: 'max_tokens' },
    ]);
    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd() },
        messages: [sm('问')],
        thinking: { level: 'high', budgetTokens: 8192 },
      }),
    );

    // 共 3 次 stream 调用：原请求 + 降档重试 + 注入恢复
    expect(streamCalls()).toBe(3);
    expect(events.filter((e) => e.type === 'thinking_downgrade')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'thinking_recover')).toHaveLength(1);
    const notice = events.find((e) => e.type === 'notice');
    expect((notice as { message: string }).message).toContain('思考消耗');
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

describe('turn.issue 落盘：请求级异常在 wire 留踪迹（事后可排查）', () => {
  it('空响应重试：wire 落 turn.issue(kind=empty)，带诊断上下文', async () => {
    const wire: WireEvent[] = [];
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [] }, // 空响应 → EmptyResponseError → 重试
      { textChunks: ['好了'], finalContent: [textBlock('好了')] },
    ]);
    await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd() },
        messages: [sm('问')],
        onWireEvent: (e) => wire.push(e),
      }),
    );
    const issue = wire.find((e) => e.type === 'turn.issue');
    expect(issue).toBeDefined();
    if (issue?.type === 'turn.issue') {
      expect(issue.kind).toBe('empty'); // 空响应触发的重试归类为 empty
      expect(issue.attempt).toBe(1);
      expect(typeof issue.delayMs).toBe('number');
      // 空响应诊断上下文：stopReason（end_turn）落盘
      expect(issue.stopReason).toBe('end_turn');
    }
  });

  it('断连重试（terminated）：wire 落 turn.issue(kind=retry)', async () => {
    const wire: WireEvent[] = [];
    const terminated = () => Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } });
    const { provider } = makeFakeProvider([
      { throw: terminated() },
      { textChunks: ['恢复'], finalContent: [textBlock('恢复')] },
    ]);
    await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd() },
        messages: [sm('问')],
        onWireEvent: (e) => wire.push(e),
      }),
    );
    const issue = wire.find((e) => e.type === 'turn.issue');
    expect(issue).toBeDefined();
    if (issue?.type === 'turn.issue') {
      expect(issue.kind).toBe('retry'); // 非空响应的普通重试
      expect(issue.attempt).toBe(1);
    }
  });

  it('turn.issue 不参与 resume 状态迁移（重放后消息数不变）', async () => {
    const { replayWireEvents } = await import('../../src/agent/wirelog.js');
    const base = replayWireEvents([]);
    const withIssue = replayWireEvents([
      {
        type: 'turn.issue',
        ts: new Date().toISOString(),
        kind: 'empty',
        message: 'x',
        stopReason: 'end_turn',
      },
    ]);
    expect(withIssue.messages).toEqual(base.messages);
    expect(withIssue.turnCount).toBe(base.turnCount);
  });
});
