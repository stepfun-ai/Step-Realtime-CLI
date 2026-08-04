import type Anthropic from '@anthropic-ai/sdk';
import { logWarn } from '../utils/logger.js';
import { checkHistoryInvariants } from './historyInvariants.js';
import { normalizeHistory } from './projector.js';
import type { ChatProvider } from './types.js';

/**
 * 请求前历史整形的统一装饰器：把 {@link normalizeHistory} 提升为覆盖全部通道的收口。
 *
 * 为什么需要它：内部历史是 Anthropic 形状，三条协议通道各自投影，而各家网关对
 * 历史合法性的校验严格程度不同（实测：同一段带孤儿 tool_result 的历史，某些
 * OpenAI 兼容网关直接 400，另一些照常 200）。整形此前只接在 StepfunAdapter
 * 内部，恰好是最宽松的那条通道，最严的 openai 通道反而裸发——覆盖度与严格性
 * 反相关。装饰器消掉这个不对称：任何 provider 都先过同一套不变量维护。
 *
 * 它维护的是「源头无法阻止的事」：进程崩在 assistant 已入列、tool_result 未入列
 * 的窗口内，用户中途打断，子 agent 被中断。**不是**为旧版本脏数据兜底（那类代码
 * 已按 1.0 前哲学拆除，不要复活），也**不是**替源头兜底（持久化顺序、压缩切点
 * 在各自源头已修）。
 */
export interface NormalizedChatProvider extends ChatProvider {
  /**
   * 被包装的原始 provider。
   *
   * 显式写进类型而不是偷偷挂属性：装配层（factory）之后，调用方拿到的是装饰器，
   * `instanceof` 判断会落空，测试与调试需要一条受支持的穿透路径。
   */
  readonly inner: ChatProvider;
}

/** {@link ChatProvider.stream} 的参数类型；跟着接口走，避免两处签名漂移。 */
type StreamParams = Parameters<ChatProvider['stream']>[0];

/**
 * 用历史整形包装一个 provider。
 *
 * stream 内的执行顺序不可调换：
 * 1. 先对**原始** messages 查不变量。反了就永远查不到——归一化会把违规全修掉，
 *    检查放在后面只会得到一份永远干净的历史，掩盖源头缺陷。
 * 2. 有违规时按 `STEP_CODE_STRICT_HISTORY` 分流：设为 '1' 抛错（开发期硬失败，
 *    因为不变量是时序/结构性质，`tsc` 全绿也照样违规），否则只 logWarn 并继续。
 *    开关刻意不用 `NODE_ENV`——本项目踩过 NODE_ENV 分流致 TUI 首帧静默失效的坑。
 * 3. 用归一化后的历史发请求。
 *
 * 刻意**不**调 `ensureLeadingUser`：补一条空 user 开场是 Anthropic 协议的要求，
 * 不是通用不变量。OpenAI Chat 首条是 system 消息，协议不要求 user 开场，插一条
 * 空 content 的 user 反而可能被严格网关拒。该步骤留在 projectMessages 里，由走
 * Anthropic 协议的 adapter 自己施加。
 */
export function withHistoryNormalization(inner: ChatProvider): NormalizedChatProvider {
  /** 已 warn 过的违规 code：同一实例内每类只提醒一次，避免每回合刷屏。 */
  const warned = new Set<string>();

  return {
    inner,
    maxTokens: inner.maxTokens,
    stream(params: StreamParams): ReturnType<Anthropic['messages']['stream']> {
      const violations = checkHistoryInvariants(params.messages);
      if (violations.length > 0) {
        const detail = violations.map((v) => `[${v.code}] ${v.detail}`).join('; ');
        if (process.env['STEP_CODE_STRICT_HISTORY'] === '1') {
          throw new Error(`历史不变量被破坏（STEP_CODE_STRICT_HISTORY=1 下硬失败）：${detail}`);
        }
        const fresh = violations.filter((v) => !warned.has(v.code));
        if (fresh.length > 0) {
          for (const v of fresh) warned.add(v.code);
          logWarn(`历史不变量被破坏（已按整形规则修补后发出）：${detail}`);
        }
      }
      return inner.stream({ ...params, messages: normalizeHistory(params.messages) });
    },
  };
}
