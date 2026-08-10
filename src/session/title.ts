/**
 * 会话标题的 AI 生成。
 *
 * 背景：默认标题是「第一条 user 消息截断 50 字符」（store.ts 的 deriveTitle），
 * 问题开头被截成标题，可读性差。本模块在第一轮回答后异步生成语义标题。
 *
 * 覆盖纪律（与 rename 机制配套）：
 * - `name`（用户 rename 的自定义名）非空的会话永不覆盖——展示口径本来就是 name ?? title；
 * - `title` 仅在「为空」或「仍等于 deriveTitle 的派生结果」时可被覆盖——
 *   用户没看到生成过程，任何非派生标题都不能被静默替换；
 * - 只自动生成一次，不做话题漂移重命名：标题的职责是「在列表里找到它」，
 *   中途改名反而让用户找不到。
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { ChatProvider } from '../provider/types.js';
import type { StoredMessage } from '../agent/message.js';

/** 标题生成的输入消息摘要上限（每条）。标题只需话题轮廓，不需要全文。 */
const INPUT_SNIPPET_MAX = 300;

/** 标题长度上限（与 deriveTitle 的 TITLE_MAX 对齐）。 */
export const GENERATED_TITLE_MAX = 50;

const TITLE_SYSTEM =
  'Generate a brief title that would help the user find this conversation later.\n' +
  '- A single line, no more than 50 characters\n' +
  '- Use the same language as the user message\n' +
  '- Focus on the main topic; no tool names, no explanations, no quotes, no trailing punctuation\n' +
  'Output ONLY the title text.';

/** 取消息文本（string 或 text 块拼接），截断到 max。 */
function snippetOf(m: StoredMessage, max: number): string {
  const c = m.message.content;
  const text =
    typeof c === 'string'
      ? c
      : c
          .map((b: Anthropic.ContentBlockParam) => (b.type === 'text' ? b.text : ''))
          .join(' ');
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

/** 清洗模型输出：去 think 块、取首行、去引号、截断。空结果返回 undefined（调用方放弃覆盖）。 */
export function cleanGeneratedTitle(raw: string): string | undefined {
  const noThink = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  const firstLine = noThink.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  const unquoted = firstLine.replace(/^[「"'"'“”‘’]+|[」"'"'“”‘’。.\s]+$/g, '');
  if (unquoted === '') return undefined;
  return unquoted.length > GENERATED_TITLE_MAX ? unquoted.slice(0, GENERATED_TITLE_MAX - 1) + '…' : unquoted;
}

/**
 * 用第一轮问答生成会话标题。失败（空输出、provider 抛错）返回 undefined，调用方保留派生标题。
 * provider 以参数注入，便于单测。
 */
export async function generateSessionTitle(
  provider: ChatProvider,
  messages: readonly StoredMessage[],
  opts: { signal?: AbortSignal; model?: string } = {},
): Promise<string | undefined> {
  const firstUser = messages.find((m) => m.origin.kind === 'user' || m.origin.kind === 'user_verbatim');
  const firstAssistant = messages.find((m) => m.message.role === 'assistant');
  if (firstUser === undefined) return undefined;

  const userSnippet = snippetOf(firstUser, INPUT_SNIPPET_MAX);
  if (userSnippet === '') return undefined;
  const assistantSnippet = firstAssistant === undefined ? '' : snippetOf(firstAssistant, INPUT_SNIPPET_MAX);

  try {
    const stream = provider.stream({
      system: TITLE_SYSTEM,
      tools: [],
      messages: [
        {
          role: 'user',
          content: `User: ${userSnippet}\nAssistant: ${assistantSnippet}\nTitle:`,
        },
      ],
      signal: opts.signal,
      model: opts.model,
    });
    const final: Anthropic.Message = await stream.finalMessage();
    const raw = final.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return cleanGeneratedTitle(raw);
  } catch {
    return undefined; // 标题是锦上添花，任何失败都静默回退派生标题
  }
}

/**
 * 是否可以为该会话生成/覆盖标题。
 * derivedTitle：调用方用当前 messages 现算的 deriveTitle 结果（避免本模块反向依赖 store）。
 */
export function canOverwriteTitle(
  session: { name?: string; title?: string },
  derivedTitle: string | undefined,
): boolean {
  // 用户 rename 过（name 非空）：永不覆盖
  if (session.name !== undefined && session.name !== '') return false;
  // title 为空：可以生成
  if (session.title === undefined || session.title === '') return true;
  // title 仍等于派生结果（没人改过）：可以覆盖；否则视为外部设定，不动
  return derivedTitle !== undefined && session.title === derivedTitle;
}
