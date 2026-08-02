import type Anthropic from '@anthropic-ai/sdk';

export const CACHE_CONTROL = { type: 'ephemeral' as const };

/** 可承载 cache_control 的 content block 类型。 */
const CACHEABLE_BLOCK_TYPES = new Set(['text', 'image', 'document', 'tool_use', 'tool_result']);

/** system → 带 cache_control 的 TextBlock 数组；inject=false 时不带 cache_control（能力声明不支持的通道）。 */
export function buildSystemBlocks(system: string, inject = true): Anthropic.TextBlockParam[] {
  return inject
    ? [{ type: 'text', text: system, cache_control: CACHE_CONTROL }]
    : [{ type: 'text', text: system }];
}

/** 给最后一个 tool 定义打 cache_control（缓存整段 tool 定义前缀）；inject=false 时原样返回。 */
export function withToolCacheControl(tools: Anthropic.Tool[], inject = true): Anthropic.Tool[] {
  if (!inject || tools.length === 0) return tools;
  return tools.map((tool, i) =>
    i === tools.length - 1 ? { ...tool, cache_control: CACHE_CONTROL } : tool,
  );
}

/**
 * 剔除「空且无 signature」的 thinking 块（防御：strict 端点会拒绝空 content 块）。
 * 带 signature 的 thinking 块原样保留（Anthropic 协议要求 tool-use 轮带 signature 回灌）。
 * 不改动入参消息对象：无需剔除时返回原对象引用。
 */
export function stripInvalidThinkingBlocks(msg: Anthropic.MessageParam): Anthropic.MessageParam {
  if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg;
  const content = msg.content as unknown as Array<Record<string, unknown>>;
  const filtered = content.filter(
    (b) =>
      b['type'] !== 'thinking' ||
      String(b['thinking'] ?? '').trim() !== '' ||
      String(b['signature'] ?? '') !== '',
  );
  if (filtered.length === content.length) return msg;
  return { role: msg.role, content: filtered as unknown as Anthropic.ContentBlockParam[] };
}

/**
 * 归一化消息：
 * 1. 剔除「空且无 signature」的 thinking 块（回灌防御）。
 * 2. 合并相邻的「纯 tool_result」user 消息为一条（Anthropic 并行工具用法规范）。
 * 3. 在最后一条消息的最后一个 content block 注入 cache_control（inject=false 时跳过）。
 * 不改动入参数组本身（返回浅拷贝）。
 */
export function prepareMessages(input: Anthropic.MessageParam[], inject = true): Anthropic.MessageParam[] {
  const merged: Anthropic.MessageParam[] = [];
  for (const raw of input) {
    const msg = stripInvalidThinkingBlocks(raw);
    const last = merged[merged.length - 1];
    if (last !== undefined && isToolResultOnly(last) && isToolResultOnly(msg)) {
      merged[merged.length - 1] = {
        role: 'user',
        content: [
          ...(last.content as Anthropic.ContentBlockParam[]),
          ...(msg.content as Anthropic.ContentBlockParam[]),
        ],
      };
    } else {
      merged.push(msg);
    }
  }
  injectCacheControlOnLastBlock(merged, inject);
  return merged;
}

export function isToolResultOnly(msg: Anthropic.MessageParam): boolean {
  if (msg.role !== 'user' || !Array.isArray(msg.content) || msg.content.length === 0) {
    return false;
  }
  return msg.content.every((b) => b.type === 'tool_result');
}

function injectCacheControlOnLastBlock(messages: Anthropic.MessageParam[], inject = true): void {
  if (!inject) return;
  const lastMsg = messages[messages.length - 1];
  if (lastMsg === undefined || !Array.isArray(lastMsg.content) || lastMsg.content.length === 0) {
    return;
  }
  const content = [...lastMsg.content];
  const lastBlock = content[content.length - 1] as Anthropic.ContentBlockParam;
  if (CACHEABLE_BLOCK_TYPES.has(lastBlock.type)) {
    content[content.length - 1] = {
      ...lastBlock,
      cache_control: CACHE_CONTROL,
    } as Anthropic.ContentBlockParam;
    messages[messages.length - 1] = { role: lastMsg.role, content };
  }
}
