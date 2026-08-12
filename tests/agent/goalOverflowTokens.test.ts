import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/loop.js';
import { GoalMode } from '../../src/agent/goal/mode.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';

/** 包一条 storage 消息（测试用）。 */
function sm(
  message: Anthropic.MessageParam,
  origin: 'user' | 'assistant' | 'tool' = 'user',
): StoredMessage {
  return stored(message, { kind: origin });
}

/**
 * TDD 复现测试：验证「overflow 重试是否重复累计 goal token」这一疑似 bug。
 *
 * 疑似 bug（loop.ts:143）：`if (outcome.usage !== undefined) ctx.goal?.addTokens(outcome.usage)`
 * 在 switch 之前无条件执行；overflow 分支会 `iter--; continue` 重试整个回合，
 * 有人怀疑重试时会再次走到 143 行导致 token 重复累计。
 *
 * 关键事实：runTurn.ts:149-150，overflow 是在 stream 抛 context-overflow 错误、
 * 尚未拿到 finalMessage 时 `return { stopReason: 'overflow' }` —— 不带 usage 字段。
 * 因此 143 行的 `outcome.usage !== undefined` 守卫为 false，overflow 回合根本不 addTokens。
 */
describe('goal token 计量在 overflow 重试场景下不重复累计', () => {
  it('第一回合 overflow → 压缩后重试成功：token 只按成功回合的真实 usage 累计', async () => {
    const goal = new GoalMode();
    goal.create('A');

    // Anthropic 400 "prompt is too long" 会被 isContextOverflowError 识别为溢出
    const overflowErr = new Anthropic.APIError(400, undefined, 'prompt is too long', undefined);

    // 成功回合的真实 usage（计费口径：input + output；input_tokens 本身已排除缓存命中部分）
    const usageTool = {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 600,
    } as Anthropic.Usage; // 计 1000 + 200 = 1200
    const usageEnd = { input_tokens: 500, output_tokens: 100 } as Anthropic.Usage; // 计 600

    const { provider, streamCalls } = makeFakeProvider([
      // 第 1 回合首次尝试：上下文溢出（stream 抛错，runTurn 返回 overflow，无 usage）
      { throw: overflowErr },
      // 溢出兜底 fullCompact 的摘要调用（compaction 配置存在时会强制压缩）
      { textChunks: [], finalContent: [textBlock('早期摘要')] },
      // 第 1 回合重试成功：tool_use，带真实 usage
      { textChunks: [], finalContent: [toolUseBlock('c1', 'nonexistent_tool', {})], usage: usageTool },
      // 第 2 回合：end_turn，带真实 usage
      { textChunks: ['完成'], finalContent: [textBlock('完成')], usage: usageEnd },
    ]);

    // 用足够多的历史消息，让 fullCompact 有东西可压（micro/full 至少一个 acted，避免 overflow 兜底直接报错）
    const messages: StoredMessage[] = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0
        ? sm({ role: 'user', content: `第${i}条历史消息${'x'.repeat(50)}` })
        : sm({ role: 'assistant', content: [textBlock(`回复${i}${'y'.repeat(50)}`)] }, 'assistant'),
    );

    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd(), goal },
        messages,
        // 清空工具集：本用例 maxContextSize 是玩具值，而真实全量工具的 schema 有数千 token，
        // 会被预检的框架开销一项压倒、抢在首回合前触发压缩，把这里预设的
        // 「溢出 → 兜底压缩 → 重试」序列打乱。本用例验证的是 goal token 计量，故隔离该变量。
        allowedTools: [],
        // 窗口给 10000（触发线 8500）：重试回合的真实 usage 是 1800（1000+200+500+100），
        // 必须让它落在触发线以下，否则 tool_use 分支会按真实基准判定该压缩、
        // 多发一次摘要调用而打乱本用例预设的 4 次 stream。
        // 不能沿用 1000——那个值下 1800 会过线；而 overflow 由 API 报错触发，与窗口值无关，
        // 所以调大窗口不影响本用例要验证的「溢出 → 兜底压缩 → 重试」链路。
        compaction: { maxContextSize: 10_000, triggerRatio: 0.85, reservedTokens: 100 },
      }),
    );

    // 正常收敛
    expect(events.at(-1)!.type).toBe('turn_done');
    // 发生了重试（notice）
    expect(events.some((e) => e.type === 'notice')).toBe(true);
    // 4 次 stream：溢出 + 压缩摘要 + 重试 tool_use + end_turn
    expect(streamCalls()).toBe(4);

    // 期望：只累计两个成功回合的 usage，overflow 回合（usage 为 undefined）不贡献任何 token。
    // 1200 (usageTool) + 600 (usageEnd) = 1800。
    // 若 bug 真实存在（overflow 回合被重复计量），此值会 > 1800。
    expect(goal.get()?.tokensUsed).toBe(1800);
  });
});
