import type Anthropic from '@anthropic-ai/sdk';
import type { ChatProvider } from './types.js';
import { checkHistoryInvariants } from './historyInvariants.js';
import { normalizeHistory } from './projector.js';
import { logWarn } from '../utils/logger.js';

/**
 * 请求前历史整形的统一装饰器，覆盖全部 provider 通道。
 *
 * 执行顺序（关键，顺序不可调换）：
 * 1. 先对**原始** messages 跑 `checkHistoryInvariants`。
 *    顺序反了就永远查不到问题（归一化会把违规全修掉）。
 *
 * 2. 有违规时：
 *    - 环境变量 `STEP_CODE_STRICT_HISTORY` 为 `'1'` → 抛错，错误消息带违规清单；
 *    - 否则 `logWarn`。
 *    - 同一个实例内，同一 `code` 的违规只 warn 一次，避免每回合刷屏。
 *
 * 3. 用 `normalizeHistory(params.messages)` 的结果调 `inner.stream`。
 *    **不要**调 `ensureLeadingUser`：OpenAI Chat 的首条是 system 消息，
 *    协议不要求 user 开场，插一条空 content 的 user 反而可能被严格网关拒。
 *
 * 4. 透传 `maxTokens`。
 */
export function withHistoryNormalization(inner: ChatProvider): ChatProvider {
  const warned = new Set<string>();

  const provider: ChatProvider = {
    maxTokens: inner.maxTokens,
    stream(params: {
      system: string;
      tools: Anthropic.Tool[];
      messages: Anthropic.MessageParam[];
      signal?: AbortSignal;
      model?: string;
      thinking?: import('./types.js').ThinkingParam | null;
    }): ReturnType<Anthropic['messages']['stream']> {
      const violations = checkHistoryInvariants(params.messages);
      if (violations.length > 0) {
        const newCodes = violations
          .map((v) => v.code)
          .filter((code) => !warned.has(code));
        for (const code of newCodes) warned.add(code);

        const detail = violations.map((v) => `[${v.code}] ${v.detail}`).join('; ');
        if (process.env['STEP_CODE_STRICT_HISTORY'] === '1') {
          throw new Error(`history invariant violations: ${detail}`);
        }
        if (newCodes.length > 0) {
          logWarn(`history invariant violations: ${detail}`);
        }
      }

      const normalized = normalizeHistory(params.messages);
      return inner.stream({ ...params, messages: normalized });
    },
  };

  // 暴露原始 inner，方便测试与调试（不改变 ChatProvider 接口契约）。
  (provider as Record<string, unknown>).inner = inner;
  return provider;
}
