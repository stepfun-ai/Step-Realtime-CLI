import type { StoredMessage } from './message.js';

/**
 * 轮次（turn）派生层。
 *
 * 存储层按 StoredMessage（≈ Anthropic wire 消息）计数，一条消息可含多个块：
 * 一条 assistant 可同时携带文字 + 多个 tool_use；一批工具的 tool_result 又打包成一条
 * role:user / origin.kind:tool 的消息。这个「条数」是上下文/压缩/token 预算的真实尺寸，
 * 但对用户没有认知意义——用户想的是「我们聊了几个来回」。
 *
 * 轮次即从用户认知出发的派生单位：一轮 = 一次真人输入（origin.kind:'user'）起，
 * 到下一次真人输入前的所有消息（assistant 回复 + 工具往返 + 注入等）归属同一轮。
 * 不改存储结构，仅在读取时按 origin 派生。
 */

/** 判定一条消息是否为「真人输入」——一轮的起点。 */
function isUserTurnStart(m: StoredMessage): boolean {
  // origin.kind:'user' 只覆盖真人输入；后台任务通知有独立 kind（background_task），
  // 不冒充 user，因此不再计入轮次起点。
  // origin.kind:'tool'（tool_result 回灌）虽然 role 也是 user，但不算新一轮的起点。
  return m.origin.kind === 'user';
}

/**
 * 统计会话轮数（按真人 user 消息数）。
 * 空历史返回 0；历史开头若无 user 消息（异常/被压缩），这些前导消息记为第 1 轮。
 */
export function countTurns(messages: StoredMessage[]): number {
  let turns = 0;
  let sawLeading = false;
  for (const m of messages) {
    if (isUserTurnStart(m)) {
      turns += 1;
    } else if (turns === 0) {
      // 首个 user 之前就有消息（如压缩摘要）：归为第 1 轮
      sawLeading = true;
    }
  }
  return turns + (sawLeading && turns === 0 ? 1 : 0);
}

export interface RecentTurnsResult {
  /** 保留下来的消息（最近 keepTurns 轮）。 */
  messages: StoredMessage[];
  /** 会话总轮数。 */
  totalTurns: number;
  /** 被折叠（未包含在 messages 里）的轮数。 */
  foldedTurns: number;
}

/**
 * 取最近 keepTurns 轮的消息。用于回放截断，避免长会话一次性刷屏。
 *
 * keepTurns <= 0 或 >= 总轮数时返回全量（foldedTurns=0）。
 * 截断以「轮的起点」为界：保留从第 (totalTurns - keepTurns + 1) 轮起点开始的所有消息，
 * 该起点之前的前导消息（若有）一并折叠。
 */
export function sliceRecentTurns(messages: StoredMessage[], keepTurns: number): RecentTurnsResult {
  const totalTurns = countTurns(messages);
  if (keepTurns <= 0 || totalTurns <= keepTurns) {
    return { messages: messages.slice(), totalTurns, foldedTurns: 0 };
  }

  // 找到「要保留的第一轮」的起点下标：即第 (totalTurns - keepTurns + 1) 个 user 消息的位置。
  const skipTurns = totalTurns - keepTurns; // 要折叠掉的完整轮数
  let seenUserTurns = 0;
  let startIdx = 0;
  for (let i = 0; i < messages.length; i++) {
    if (isUserTurnStart(messages[i]!)) {
      seenUserTurns += 1;
      if (seenUserTurns === skipTurns + 1) {
        startIdx = i;
        break;
      }
    }
  }

  return {
    messages: messages.slice(startIdx),
    totalTurns,
    foldedTurns: skipTurns,
  };
}
