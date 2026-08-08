/**
 * 跨回合零进展检测（round loop guard）——纯函数模块。
 *
 * 背景：模型在 tool_use 分支陷入「看到相同工具结果 → 做出相同反应」的稳态，
 * 每轮产出的 assistant 消息与工具结果逐字节相同，没有信息增量。
 * 该病态不在流内（thinkingLoop 管不着）、不在续写链路（continuation 管不着），
 * 只出现在 `loop.ts` 的 `tool_use` 分支走 continue 时。
 *
 * 本模块用「回合指纹」做确定性判据：完整字符串相等是二值判断，误报空间为零。
 * 完整设计与阈值理据见内部产品设计文档（跨回合零进展检测设计）。
 *
 * 无 IO、状态显式、与 continuation.ts 同风格。
 */

import type { StoredMessage } from './message.js';

/* ------------------------------------------------------------------ */
/* 类型定义                                                           */
/* ------------------------------------------------------------------ */

/**
 * 检测结果。
 * - none：正常，无干预。
 * - warn：连续相同第 3 次，已注入警告，继续一轮。
 * - stop：连续相同第 4 次（含）以上，判定死循环，停止本轮。
 */
export type RoundLoopVerdict =
  | { action: 'none' }
  | { action: 'warn'; streak: number }
  | { action: 'stop'; streak: number };

/* ------------------------------------------------------------------ */
/* 指纹生成                                                           */
/* ------------------------------------------------------------------ */

/**
 * 从 messages 尾部取「最后一条 assistant 消息（倒数第二条）+ 紧随其后的 tool_result user 消息（最后一条）」，
 * 拼出稳定指纹字符串。尾部结构不匹配返回 null。
 *
 * "最后一条 assistant" = 从尾部扫描，最后一条 role='assistant' 的消息。
 * "紧随的 tool_result user" = 紧跟在 assistant 之后的那条 role='user' 消息（工具结果回灌）。
 *
 * 排除 tool_use id 与消息 ts——这两样每轮必然不同，含了指纹永远不等、检测静默失效。
 *
 * @param messages 完整 storage 历史（只读，不修改）
 */
export function fingerprintRound(messages: StoredMessage[]): string | null {
  if (messages.length < 2) return null;

  // 尾部两条：[倒数第二 = assistant, 倒数第一 = tool_result user]
  const assistantMsg = messages[messages.length - 2]!;
  const resultMsg = messages[messages.length - 1]!;

  if (assistantMsg.message.role !== 'assistant') return null;
  if (resultMsg.message.role !== 'user') return null;

  // ---------- assistant 侧 ----------
  const assistantContent = assistantMsg.message.content;
  let assistantFingerprint = '';

  if (typeof assistantContent === 'string') {
    assistantFingerprint = `t:${assistantContent}`;
  } else if (Array.isArray(assistantContent)) {
    const parts: string[] = [];
    for (const block of assistantContent) {
      if (block.type === 'text') {
        // text 块原文直接参与指纹
        parts.push(`t:${block.text}`);
      } else if (block.type === 'tool_use') {
        // tool_use 的 name + input 参与指纹，不含 id
        parts.push(`u:${block.name}:${JSON.stringify(block.input)}`);
      }
      // thinking 等非 text/tool_use 块忽略（它们是思考过程，不改变工具调用语义）
    }
    assistantFingerprint = parts.join('|');
  }

  if (assistantFingerprint === '') return null;

  // ---------- tool_result 侧 ----------
  const toolContent = resultMsg.message.content;
  let toolFingerprint = '';

  if (typeof toolContent === 'string') {
    toolFingerprint = `r:${toolContent}`;
  } else if (Array.isArray(toolContent)) {
    const parts: string[] = [];
    for (const block of toolContent) {
      if (block.type !== 'tool_result') continue;

      // is_error 参与指纹：错误复读也是复读
      const errFlag = block.is_error === true ? 'e' : 'o';

      if (typeof block.content === 'string') {
        parts.push(`${errFlag}:${block.content}`);
      } else if (Array.isArray(block.content)) {
        // 块数组形态：取所有 text 块拼接（忽略图片等不可序列化块）
        const texts: string[] = [];
        for (const inner of block.content) {
          if (inner.type === 'text') texts.push(inner.text);
        }
        parts.push(`${errFlag}:${texts.join('')}`);
      }
      // 无 content 的 tool_result 记为空串
    }
    toolFingerprint = parts.join('|');
  }

  return `${assistantFingerprint}||${toolFingerprint}`;
}

/* ------------------------------------------------------------------ */
/* 检测器（有状态，闭包持有 streak）                                   */
/* ------------------------------------------------------------------ */

/**
 * 阈值理据：
 *
 * - 连续相同第 1、2 次不触发（`action: 'none'`）：合理确认性重试（模型复核一次结果）
 *   在两轮内完成，正常任务极少出现 3 轮完全相同的情况。
 * - 连续相同第 3 次 → `action: 'warn'`：与 `thinkingLoop.ts` 的 `REPEAT_THRESHOLD=3` 口径一致；
 *   3 轮相同说明模型大概率卡住，但偶发（如网络抖动导致模型重发同一条调用）仍有可能，
 *   先注入警告给一次机会。
 * - 注入后仍相同（第 4 次）→ `action: 'stop'`：与 thinkingLoop「诱导重试最多 1 次」、
 *   hooks「续行只给一次机会」同款收敛策略——给机会是为了不冤枉偶发，给完还犯就是真困住，
 *   继续烧全量上下文没有价值。
 * - streak ≥ 5 理论上在 stop 后不会发生（loop 已停），函数保持有定义行为。
 */
export function createRoundLoopDetector(): {
  observe(fingerprint: string | null): RoundLoopVerdict;
  reset(): void;
} {
  /** 当前连续相同指纹的轮数。 */
  let streak = 0;
  /** 上一轮观察到的指纹（null 表示尚未有有效观察）。 */
  let lastFingerprint: string | null = null;

  /**
   * 观察一轮的指纹，返回处置建议。
   * 调用方按 action 决定：none → 继续；warn → 注入警告后继续；stop → 停止。
   */
  function observe(fingerprint: string | null): RoundLoopVerdict {
    // null = 尾部结构不匹配或首轮，清零 streak
    if (fingerprint === null) {
      streak = 0;
      lastFingerprint = null;
      return { action: 'none' };
    }

    if (fingerprint !== lastFingerprint) {
      // 与上轮不同：清零
      streak = 0;
      lastFingerprint = fingerprint;
    }

    streak += 1;

    if (streak >= 4) {
      return { action: 'stop', streak };
    }
    if (streak === 3) {
      return { action: 'warn', streak };
    }
    // streak 1、2：不干预
    return { action: 'none' };
  }

  function reset(): void {
    streak = 0;
    lastFingerprint = null;
  }

  return { observe, reset };
}
