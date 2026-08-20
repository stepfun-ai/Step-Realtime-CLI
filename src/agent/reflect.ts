import type Anthropic from '@anthropic-ai/sdk';
import type { ChatProvider } from '../provider/types.js';
import { estimateTokens } from './compaction/compact.js';
import type { StoredMessage } from './message.js';

/**
 * /reflect 的核心：分段遍历完整对话历史（map → reduce），提炼可复用的通用方法论经验。
 *
 * 设计要点（对齐「对话回顾与经验沉淀」设计文档）：
 * - 自建循环、直接调 provider.stream，不进主 agent 循环，遍历过程不污染主上下文、也不触发压缩。
 * - map：把历史按 token 预算切成若干段，逐段用「提炼方法论」的 prompt 调模型，
 *   段间携带「已发现经验」的滚动摘要，保持连贯（对齐游走语义）。
 * - reduce：把各段经验点合并、去重、按重要性排序，产出最终清单。
 * - 护栏：段数上限，超限截断并在结尾给出提示。
 *
 * 纯函数：provider 以参数注入，便于单测用 fake provider 覆盖切段/map/reduce/护栏。
 */

/** 空历史占位文案。App 侧据此判断：占位产出不注入会话流（注入了也没内容可选摘）。 */
export const REFLECT_EMPTY_HISTORY = '（没有可回顾的对话历史。）';

/** 未提炼出经验的占位文案。同上。 */
export const REFLECT_NO_FINDINGS = '（未从历史中提炼出可复用的方法论经验。）';

/** map 阶段的系统提示词：取向定死为可复用方法论，排除一次性事实。 */
const MAP_SYSTEM =
  '你是一个协作复盘器。给你一段 AI 助手与用户的对话历史，请只提炼**可复用的通用方法论经验**，' +
  '维度包括：有效的协作/推进策略、踩过的坑与其信号、被推翻的判断（先怎么想、后来为何改、教训）、' +
  '下次遇到同类任务该怎么做。明确排除：本次任务的具体事实结论、代码细节、一次性的项目信息。' +
  '用简洁的中文条目输出；这一段没有值得沉淀的方法论时，只回复「（本段无）」。';

/** reduce 阶段的系统提示词：合并去重排序。 */
const REDUCE_SYSTEM =
  '你是一个经验汇总器。给你若干段从对话中提炼的方法论经验点，请合并语义重复项、' +
  '删掉一次性事实，按重要性/可迁移性从高到低排序，输出一份精炼的可复用方法论经验清单（中文条目）。';

export interface ReflectOptions {
  /** 每段的 token 预算（估算）。超过即切段。默认 8000。 */
  maxTokensPerSegment?: number;
  /** 段数上限护栏。历史切出的段数超过此值时截断，只回顾前 N 段。默认 12。 */
  maxSegments?: number;
  /** 透传给 provider 的中断信号。 */
  signal?: AbortSignal;
  /** 模型覆盖，省略用 provider 默认模型。 */
  model?: string;
}

const DEFAULT_MAX_TOKENS_PER_SEGMENT = 8000;
const DEFAULT_MAX_SEGMENTS = 12;

/**
 * 把完整历史按 token 预算切段。单条消息即便超过预算也自成一段（不拆消息）。
 * 返回按时间顺序排列的段数组。
 */
export function segmentMessages(
  messages: readonly StoredMessage[],
  maxTokensPerSegment: number,
): StoredMessage[][] {
  const segments: StoredMessage[][] = [];
  let current: StoredMessage[] = [];
  let currentTokens = 0;
  for (const m of messages) {
    const t = estimateTokens([m]);
    // 当前段非空且加入后会超预算 → 先收尾，另起一段
    if (current.length > 0 && currentTokens + t > maxTokensPerSegment) {
      segments.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(m);
    currentTokens += t;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** 把一段消息序列化成给模型看的纯文本（role: 内容）。 */
function serializeSegment(segment: readonly StoredMessage[]): string {
  return segment.map((m) => `${m.message.role}: ${serializeContent(m.message.content)}`).join('\n');
}

function serializeContent(content: Anthropic.MessageParam['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((b: Anthropic.ContentBlockParam) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_use') return `[调用工具 ${b.name}]`;
      if (b.type === 'tool_result') return '[工具结果]';
      return `[${b.type}]`;
    })
    .join(' ');
}

/** 用给定 system + 用户正文调一次 provider，收集文本输出。 */
async function collectText(
  provider: ChatProvider,
  system: string,
  userContent: string,
  opts: ReflectOptions,
): Promise<string> {
  const stream = provider.stream({
    system,
    tools: [],
    messages: [{ role: 'user', content: userContent }],
    signal: opts.signal,
    model: opts.model,
  });
  const final: Anthropic.Message = await stream.finalMessage();
  return final.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/** 判断一段 map 产出是否为「无经验」占位（避免把空段喂进 reduce）。 */
function isEmptyFinding(text: string): boolean {
  return text === '' || text.replace(/[（）()\s]/g, '') === '本段无';
}

/**
 * 分段遍历完整历史，提炼可复用方法论经验，返回最终经验清单字符串。
 * 空历史 / 未提炼出经验时返回友好提示文案（供调用方直接 pushItem）。
 */
export async function runReflect(
  provider: ChatProvider,
  fullMessages: readonly StoredMessage[],
  opts: ReflectOptions = {},
): Promise<string> {
  if (fullMessages.length === 0) return REFLECT_EMPTY_HISTORY;

  const maxTokensPerSegment = opts.maxTokensPerSegment ?? DEFAULT_MAX_TOKENS_PER_SEGMENT;
  const maxSegments = opts.maxSegments ?? DEFAULT_MAX_SEGMENTS;

  const allSegments = segmentMessages(fullMessages, maxTokensPerSegment);
  const truncated = allSegments.length > maxSegments;
  const segments = truncated ? allSegments.slice(0, maxSegments) : allSegments;

  // map：逐段提炼，携带「已发现经验」滚动摘要保持连贯（串行）。
  const findings: string[] = [];
  for (const segment of segments) {
    const prior =
      findings.length > 0
        ? `已发现的经验（供参考，避免重复，可补充或修正）：\n${findings.join('\n')}\n\n`
        : '';
    const userContent = `${prior}本段对话历史：\n${serializeSegment(segment)}`;
    const finding = await collectText(provider, MAP_SYSTEM, userContent, opts);
    if (!isEmptyFinding(finding)) findings.push(finding);
  }

  let result: string;
  if (findings.length === 0) {
    result = REFLECT_NO_FINDINGS;
  } else if (findings.length === 1) {
    // 只有一段有产出，无需再 reduce
    result = findings[0]!;
  } else {
    const reduceInput = findings.map((f, i) => `【第 ${i + 1} 段】\n${f}`).join('\n\n');
    const reduced = await collectText(provider, REDUCE_SYSTEM, reduceInput, opts);
    result = reduced === '' ? findings.join('\n\n') : reduced;
  }

  if (truncated) {
    result += `\n\n（历史过长：共 ${allSegments.length} 段，仅回顾了前 ${maxSegments} 段。）`;
  }
  return result;
}
