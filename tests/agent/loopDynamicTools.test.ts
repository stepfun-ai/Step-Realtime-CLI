import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/loop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { clearDynamicTools, registerDynamicTool } from '../../src/tools/index.js';
import type { DeferredTool } from '../../src/agent/toolSearch.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';

// 动态工具是模块级全局状态，每个用例后清空，避免泄漏到其他测试文件
afterEach(() => clearDynamicTools());

describe('runAgent 动态工具同轮生效', () => {
  it('tool_search 注册的动态工具，下一回合请求的 tools 数组带完整 schema', async () => {
    // 模拟外部懒加载工具：tool_search 命中后 load() 注册进 DYNAMIC_TOOLS
    const deferred: DeferredTool[] = [
      {
        name: 'mcp_translate',
        description: '调用外部 MCP 服务翻译文本',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ];
    const ctx = {
      cwd: process.cwd(),
      toolSearch: {
        deferred,
        load: (names: string[]) => {
          for (const name of names) {
            registerDynamicTool({
              name,
              description: '调用外部 MCP 服务翻译文本',
              schema: z.object({ text: z.string().describe('要翻译的文本') }),
              execute: async () => ({ content: 'ok', isError: false }),
            });
          }
        },
      },
    };
    const { provider, streamParams } = makeFakeProvider([
      // 第 1 回合：模型要求 tool_search
      { textChunks: [], finalContent: [toolUseBlock('c1', 'tool_search', { query: '翻译' })] },
      // 第 2 回合：结束
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const messages: StoredMessage[] = [stored({ role: 'user', content: 'hi' })];
    const events = await collect(runAgent({ provider, system: 'sys', ctx, messages }));

    expect(events.at(-1)!.type).toBe('turn_done');
    // 第 1 回合的请求不含动态工具
    const tools1 = streamParams()[0]!['tools'] as { name: string }[];
    expect(tools1.some((t) => t.name === 'mcp_translate')).toBe(false);
    // 第 2 回合的请求已包含动态工具及其完整 schema
    const tools2 = streamParams()[1]!['tools'] as {
      name: string;
      input_schema: { properties?: Record<string, unknown> };
    }[];
    const loaded = tools2.find((t) => t.name === 'mcp_translate');
    expect(loaded).toBeDefined();
    expect(loaded!.input_schema.properties).toHaveProperty('text');
  });

  it('动态工具与静态工具同名时不重复出现在 tools 数组', async () => {
    registerDynamicTool({
      name: 'read_file',
      description: '同名动态覆盖注册',
      schema: z.object({}),
      execute: async () => ({ content: 'ok', isError: false }),
    });
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const messages: StoredMessage[] = [stored({ role: 'user', content: 'hi' })];
    await collect(runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages }));

    const tools = streamParams()[0]!['tools'] as { name: string }[];
    expect(tools.filter((t) => t.name === 'read_file')).toHaveLength(1);
  });
});
