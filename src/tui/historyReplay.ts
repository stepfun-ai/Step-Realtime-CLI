import type Anthropic from '@anthropic-ai/sdk';
import type { StoredMessage } from '../agent/message.js';
import { sliceRecentTurns } from '../agent/turns.js';
import type { DisplayItem } from './types.js';

/**
 * 会话回放：把恢复的历史消息（StoredMessage[]）投影成可渲染的 DisplayItem[]。
 *
 * 适配 Step Code 的数据驱动 UI：DisplayItem 是静态数据结构，
 * 故直接构造与实时 applyEvent 结构一致的 DisplayItem，无需模拟流式管线。
 * 产物走同一个 MessageItem 组件渲染，保证回放与实时逐像素一致。
 *
 * 关键处理：
 * - assistant 的 text 块拼成一条 assistant，thinking 块落成 thinking，tool_use 落成 tool；
 * - tool_result 按 tool_use_id 配对回填到对应 tool 的 result/status（Map 配对）；
 * - origin.kind='injection' 跳过（内部注入的 system-reminder 不该显示给用户）；
 * - 图片块转成 [图片] 占位（resume 时图片是 stepref 指针，历史区不实际渲染）；
 * - 按轮次截断（sliceRecentTurns），避免长会话一次性刷屏。
 */

/** 回放默认保留的最近轮数（一轮 = 一次真人输入到下次输入前）。超出的折叠。 */
export const REPLAY_TURN_LIMIT = 15;

/** 从 tool_result 块的 content 提取纯文本（content 可能是 string 或块数组）。 */
function toolResultText(content: Anthropic.ToolResultBlockParam['content']): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'image') return '[图片]';
      return '';
    })
    .join('');
}

type ToolItem = Extract<DisplayItem, { kind: 'tool' }>;

export interface ReplayResult {
  items: DisplayItem[];
  totalTurns: number;
  foldedTurns: number;
}

/**
 * 把历史消息转成 DisplayItem 列表。
 * keepTurns 控制回放的最近轮数；<=0 表示全量。
 */
export function historyToDisplayItems(
  messages: StoredMessage[],
  keepTurns = REPLAY_TURN_LIMIT,
): ReplayResult {
  const sliced = sliceRecentTurns(messages, keepTurns);
  const items: DisplayItem[] = [];
  // tool_use_id → 对应的 tool DisplayItem，供后续 tool_result 回填。
  const toolById = new Map<string, ToolItem>();

  for (const stored of sliced.messages) {
    const { message, origin } = stored;

    // 内部注入的 system-reminder 不面向用户展示。
    if (origin.kind === 'injection') continue;

    const { role, content } = message;

    // content 为纯字符串：user 直接成条，assistant 直接成条。
    if (typeof content === 'string') {
      if (content.trim() === '') continue;
      items.push({ kind: role === 'user' ? 'user' : 'assistant', text: content });
      continue;
    }

    // content 为块数组：按块类型分派。
    if (role === 'assistant') {
      // 按块原始顺序构造，保持与实时渲染一致（文字通常先于 tool_use 出现）。
      // 相邻的 text 块合并成一条 assistant，遇到 thinking/tool_use 则先 flush 已累积的文字。
      let textBuf = '';
      const flushText = (): void => {
        if (textBuf.trim() !== '') items.push({ kind: 'assistant', text: textBuf });
        textBuf = '';
      };
      for (const block of content) {
        switch (block.type) {
          case 'text':
            textBuf += block.text;
            break;
          case 'thinking':
            flushText();
            if (block.thinking.trim() !== '') {
              items.push({ kind: 'thinking', text: block.thinking });
            }
            break;
          case 'tool_use': {
            flushText();
            const tool: ToolItem = {
              kind: 'tool',
              id: block.id,
              name: block.name,
              input: block.input,
              status: 'ok',
            };
            items.push(tool);
            toolById.set(block.id, tool);
            break;
          }
          default:
            break;
        }
      }
      flushText();
      continue;
    }

    // role === 'user'：可能是真人输入（text/image 块）或 tool_result 回灌（origin.kind:'tool'）。
    for (const block of content) {
      if (block.type === 'tool_result') {
        // 回填到对应的 tool 条目。
        const tool = toolById.get(block.tool_use_id);
        if (tool !== undefined) {
          tool.result = toolResultText(block.content);
          tool.status = block.is_error === true ? 'error' : 'ok';
        }
      } else if (block.type === 'text') {
        if (block.text.trim() !== '') {
          items.push({ kind: 'user', text: block.text });
        }
      } else if (block.type === 'image') {
        items.push({ kind: 'user', text: '[图片]' });
      }
    }
  }

  return { items, totalTurns: sliced.totalTurns, foldedTurns: sliced.foldedTurns };
}
