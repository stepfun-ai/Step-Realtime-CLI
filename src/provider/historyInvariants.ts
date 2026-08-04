import type Anthropic from '@anthropic-ai/sdk';

/**
 * 历史消息不变量检查。
 *
 * 输入是裸 `Anthropic.MessageParam[]`，不含存储层元数据（id/origin/ts）。
 * 因此「消息 id 唯一」这一不变量**不在这一层实现**：
 * - 裸 `MessageParam` 没有 id 字段；
 * - id 唯一性是存储层（`StoredMessage`）的性质，由 `src/agent/message.ts` 的 `randomUUID` 保证；
 * - 本层刻意不引入存储层依赖，也不自行发明 id 字段。
 *
 * 其余四条不变量可以在裸消息层判定，这里集中实现。
 */

export interface HistoryViolation {
  code:
    | 'dangling-tool-use'
    | 'orphan-tool-result'
    | 'pairing-not-adjacent'
    | 'consecutive-same-role';
  /** 可定位的说明，带 tool_use_id 或消息序号（从 0 起）。 */
  detail: string;
}

type Block = Anthropic.ContentBlockParam;

/** 收集 assistant 消息里的 tool_use id（按出现顺序，带消息索引）。 */
function collectToolUses(messages: readonly Anthropic.MessageParam[]): Array<{ id: string; msgIdx: number }> {
  const out: Array<{ id: string; msgIdx: number }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
    for (const b of msg.content) {
      if (b.type === 'tool_use') out.push({ id: b.id, msgIdx: i });
    }
  }
  return out;
}

/** 收集所有 tool_result（带 tool_use_id 与消息索引）。 */
function collectToolResults(
  messages: readonly Anthropic.MessageParam[],
): Array<{ tool_use_id: string; msgIdx: number }> {
  const out: Array<{ tool_use_id: string; msgIdx: number }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (typeof msg.content === 'string') continue;
    for (const b of msg.content) {
      if (b.type === 'tool_result') out.push({ tool_use_id: b.tool_use_id!, msgIdx: i });
    }
  }
  return out;
}

/** 取消息 content 的块数组（字符串消息视为空块）。 */
function toBlocks(msg: Anthropic.MessageParam): Block[] {
  if (typeof msg.content === 'string') return msg.content === '' ? [] : [{ type: 'text', text: msg.content }];
  return [...msg.content];
}

/**
 * 纯函数：检查四条历史不变量，返回违规列表。
 */
export function checkHistoryInvariants(
  messages: readonly Anthropic.MessageParam[],
): HistoryViolation[] {
  const violations: HistoryViolation[] = [];
  const toolUses = collectToolUses(messages);
  const toolResults = collectToolResults(messages);

  const toolUseIds = new Set(toolUses.map((tu) => tu.id));
  const answered = new Set(toolResults.map((r) => r.tool_use_id));
  const answeredFirstIdx = new Map<string, number>();
  for (const r of toolResults) {
    if (!answeredFirstIdx.has(r.tool_use_id)) answeredFirstIdx.set(r.tool_use_id, r.msgIdx);
  }

  // ① 每个 tool_use 都有配对 tool_result
  for (const tu of toolUses) {
    if (!answered.has(tu.id)) {
      violations.push({
        code: 'dangling-tool-use',
        detail: `assistant 消息 #${tu.msgIdx} 的 tool_use(id=${tu.id}) 未配对`,
      });
    }
  }

  // ② 每个 tool_result 能向前配对到 tool_use
  for (const tr of toolResults) {
    if (!toolUseIds.has(tr.tool_use_id)) {
      violations.push({
        code: 'orphan-tool-result',
        detail: `消息 #${tr.msgIdx} 的 tool_result(tool_use_id=${tr.tool_use_id}) 找不到对应 tool_use`,
      });
    }
  }

  // ③ assistant(tool_use) 之后紧跟它的 tool_result 组，中间不插入其他消息
  for (const tu of toolUses) {
    if (!answeredFirstIdx.has(tu.id)) continue; // 未配对，已在上条记录
    const resultIdx = answeredFirstIdx.get(tu.id)!;
    if (resultIdx <= tu.msgIdx) continue; // 同一消息内或更早，不应发生
    // 检查 (tu.msgIdx, resultIdx) 之间是否全是 user 且只含 tool_result/text
    for (let i = tu.msgIdx + 1; i < resultIdx; i++) {
      const m = messages[i]!;
      if (m.role !== 'user') {
        violations.push({
          code: 'pairing-not-adjacent',
          detail: `tool_use(id=${tu.id}) 在 #${tu.msgIdx} 与配对 tool_result 在 #${resultIdx} 之间插入了 #${i} role=${m.role}`,
        });
        break;
      }
      const blocks = toBlocks(m);
      const hasNonTool = blocks.some((b) => b.type !== 'tool_result' && b.type !== 'text');
      if (hasNonTool) {
        violations.push({
          code: 'pairing-not-adjacent',
          detail: `tool_use(id=${tu.id}) 与配对 tool_result 之间的 user 消息 #${i} 含有非工具结果块`,
        });
        break;
      }
    }
  }

  // ④ 不出现连续同 role 消息
  for (let i = 1; i < messages.length; i++) {
    if (messages[i]!.role === messages[i - 1]!.role) {
      violations.push({
        code: 'consecutive-same-role',
        detail: `消息 #${i - 1} 与 #${i} 连续同为 role=${messages[i]!.role}`,
      });
    }
  }

  return violations;
}
