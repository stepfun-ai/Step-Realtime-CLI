import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  httpErrorToApiError,
  mapStopReason,
  mapUsage,
  messagesToOpenAi,
  type OpenAiMessage,
  parseToolArguments,
  toolsToOpenAi,
} from '../../src/provider/openaiCommon.js';
import { OpenAiChatProvider } from '../../src/provider/openaiChat.js';

/** 把若干 SSE data 行拼成一个 Response body 的字节流（模拟 OpenAI 流式响应）。 */
function sseResponse(lines: string[], status = 200): Response {
  const body = lines.map((l) => `data: ${l}\n\n`).join('');
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** 收集一次 stream() 的事件 + finalMessage。 */
async function drive(provider: OpenAiChatProvider, params: {
  system?: string;
  tools?: Anthropic.Tool[];
  messages?: Anthropic.MessageParam[];
}): Promise<{ events: Anthropic.MessageStreamEvent[]; final: Anthropic.Message }> {
  const stream = provider.stream({
    system: params.system ?? '',
    tools: params.tools ?? [],
    messages: params.messages ?? [],
  });
  const events: Anthropic.MessageStreamEvent[] = [];
  for await (const ev of stream) events.push(ev);
  const final = await stream.finalMessage();
  return { events, final };
}

describe('messagesToOpenAi 请求翻译', () => {
  it('system 非空 → messages[0] role:system', () => {
    const out = messagesToOpenAi('你是助手', [{ role: 'user', content: '你好' }]);
    expect(out[0]).toEqual({ role: 'system', content: '你是助手' });
    expect(out[1]).toEqual({ role: 'user', content: '你好' });
  });

  it('system 空串 → 不产出 system 消息', () => {
    const out = messagesToOpenAi('', [{ role: 'user', content: '你好' }]);
    expect(out.every((m) => m.role !== 'system')).toBe(true);
  });

  it('user 字符串内容原样透传', () => {
    const out = messagesToOpenAi('', [{ role: 'user', content: 'hi' }]);
    expect(out).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('assistant 的 tool_use 块 → assistant.tool_calls（arguments 为 JSON 字符串）', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我来查一下' },
          { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
        ],
      },
    ];
    const out = messagesToOpenAi('', messages);
    const assistant = out[0] as OpenAiMessage;
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toBe('我来查一下');
    expect(assistant.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
    ]);
  });

  it('纯 tool_use（无正文）→ assistant.content 为 null', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 't', input: {} }] },
    ];
    const out = messagesToOpenAi('', messages);
    expect((out[0] as OpenAiMessage).content).toBeNull();
  });

  it('user 的 tool_result 块 → role:tool 消息带 tool_call_id', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '文件内容' }],
      },
    ];
    const out = messagesToOpenAi('', messages);
    // 纯 tool_result 不产出空 user 消息，只产出 tool 消息
    expect(out).toEqual([{ role: 'tool', tool_call_id: 'call_1', content: '文件内容' }]);
  });

  it('tool_result content 为块数组 → 取文本块拼接', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'c1',
            content: [{ type: 'text', text: '结果A' }],
          },
        ],
      },
    ];
    const out = messagesToOpenAi('', messages);
    expect(out[0]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '结果A' });
  });

  it('assistant 的 thinking 块被忽略（OpenAI 不回传 reasoning）', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '内部思考', signature: 's' } as unknown as Anthropic.ContentBlockParam,
          { type: 'text', text: '答复' },
        ],
      },
    ];
    const out = messagesToOpenAi('', messages);
    expect((out[0] as OpenAiMessage).content).toBe('答复');
  });
});

describe('toolsToOpenAi 工具定义翻译', () => {
  it('Anthropic.Tool → function 型，input_schema→parameters', () => {
    const tools: Anthropic.Tool[] = [
      {
        name: 'read_file',
        description: '读文件',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      } as unknown as Anthropic.Tool,
    ];
    const out = toolsToOpenAi(tools);
    expect(out).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: '读文件',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ]);
  });

  it('缺 description → 不含 description 字段', () => {
    const tools: Anthropic.Tool[] = [
      { name: 't', input_schema: { type: 'object' } } as unknown as Anthropic.Tool,
    ];
    const out = toolsToOpenAi(tools);
    expect('description' in out[0]!.function).toBe(false);
  });
});

describe('mapStopReason', () => {
  it('tool_calls → tool_use', () => {
    expect(mapStopReason('tool_calls', false)).toBe('tool_use');
  });
  it('有 tool_calls 累积但 finish_reason=stop → 仍判 tool_use', () => {
    expect(mapStopReason('stop', true)).toBe('tool_use');
  });
  it('stop → end_turn', () => {
    expect(mapStopReason('stop', false)).toBe('end_turn');
  });
  it('length → max_tokens', () => {
    expect(mapStopReason('length', false)).toBe('max_tokens');
  });
  it('null 或未知 → end_turn', () => {
    expect(mapStopReason(null, false)).toBe('end_turn');
    expect(mapStopReason('weird', false)).toBe('end_turn');
  });
});

describe('mapUsage', () => {
  it('input_tokens 扣除 cached，cache_read 单列', () => {
    const u = mapUsage({
      prompt_tokens: 100,
      completion_tokens: 40,
      prompt_tokens_details: { cached_tokens: 30 },
    });
    expect(u.input_tokens).toBe(70);
    expect(u.output_tokens).toBe(40);
    expect(u.cache_read_input_tokens).toBe(30);
    expect(u.cache_creation_input_tokens).toBe(0);
  });
  it('无 cached → cache_read 为 0，input_tokens 等于 prompt_tokens', () => {
    const u = mapUsage({ prompt_tokens: 50, completion_tokens: 10 });
    expect(u.input_tokens).toBe(50);
    expect(u.cache_read_input_tokens).toBe(0);
  });
});

describe('parseToolArguments', () => {
  it('合法 JSON → 对象', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
  });
  it('空串 → {}', () => {
    expect(parseToolArguments('')).toEqual({});
  });
  it('非法 JSON → {}', () => {
    expect(parseToolArguments('{bad')).toEqual({});
  });
});

describe('httpErrorToApiError', () => {
  it('包成带 status 的 Anthropic APIError（供 runTurn 重试分类）', () => {
    const err = httpErrorToApiError(429, '{"error":{"message":"rate limited"}}', new Headers());
    expect((err as { status?: number }).status).toBe(429);
    expect(err.message).toContain('rate limited');
  });
  it('body 非 JSON → 用原始 body 作 message', () => {
    const err = httpErrorToApiError(500, 'internal error', new Headers());
    expect((err as { status?: number }).status).toBe(500);
  });
  it('裸 JSON 无 error.message（{"type":"error"} 现场）→ 合成摘要带 type 与截断 body', () => {
    const err = httpErrorToApiError(400, '{"type":"error"}', new Headers());
    expect((err as { status?: number }).status).toBe(400);
    expect(err.message).toBe('400 error · {"type":"error"}');
  });
  it('body 为空 → message 保留状态码与占位说明', () => {
    const err = httpErrorToApiError(502, '', new Headers());
    expect(err.message).toBe('502 (no body)');
  });
  it('顶层 message 形（部分网关）→ 直接采用', () => {
    const err = httpErrorToApiError(403, '{"message":"forbidden"}', new Headers());
    expect(err.message).toBe('403 forbidden');
  });
  it('标准 error.message 形 → err.message 可读（不再是整段 JSON）', () => {
    const err = httpErrorToApiError(
      400,
      '{"error":{"type":"invalid_request_error","message":"bad prompt"}}',
      new Headers(),
    );
    expect(err.message).toBe('400 bad prompt');
  });
});

describe('OpenAiChatProvider 流式响应翻译', () => {
  function makeProvider(response: Response, capture?: { body?: unknown; url?: string; headers?: unknown }): OpenAiChatProvider {
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (capture !== undefined) {
        capture.url = url;
        capture.body = JSON.parse(init.body as string);
        capture.headers = init.headers;
      }
      return response;
    }) as unknown as typeof fetch;
    return new OpenAiChatProvider({
      apiKey: 'k',
      baseUrl: 'https://api.stepfun.com/v1',
      model: 'step-3.7-flash',
      maxTokens: 32768,
      fetchImpl,
    });
  }

  it('delta.content → text_delta 事件，finalMessage 含 text 块', async () => {
    const provider = makeProvider(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: '你好' } }] }),
        JSON.stringify({ choices: [{ delta: { content: '，世界' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } }),
      ]),
    );
    const { events, final } = await drive(provider, { messages: [{ role: 'user', content: 'hi' }] });
    const textEvents = events.filter(
      (e) => e.type === 'content_block_delta' && (e.delta as { type: string }).type === 'text_delta',
    );
    expect(textEvents).toHaveLength(2);
    expect(final.content).toEqual([{ type: 'text', text: '你好，世界', citations: null }]);
    expect(final.stop_reason).toBe('end_turn');
    expect(final.usage.input_tokens).toBe(10);
    expect(final.usage.output_tokens).toBe(3);
  });

  it('delta.reasoning_content → thinking_delta 事件，finalMessage 含 thinking 块（在 text 前）', async () => {
    const provider = makeProvider(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { reasoning_content: '想一下' } }] }),
        JSON.stringify({ choices: [{ delta: { content: '答案' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ]),
    );
    const { events, final } = await drive(provider, { messages: [{ role: 'user', content: 'hi' }] });
    const thinkingEvents = events.filter(
      (e) => e.type === 'content_block_delta' && (e.delta as { type: string }).type === 'thinking_delta',
    );
    expect(thinkingEvents).toHaveLength(1);
    expect(final.content[0]).toMatchObject({ type: 'thinking', thinking: '想一下' });
    expect(final.content[1]).toMatchObject({ type: 'text', text: '答案' });
  });

  it('reasoning 与 reasoning_content 同值 → 不重复累加', async () => {
    const provider = makeProvider(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { reasoning_content: 'X', reasoning: 'X' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ]),
    );
    const { final } = await drive(provider, { messages: [{ role: 'user', content: 'hi' }] });
    expect(final.content[0]).toMatchObject({ type: 'thinking', thinking: 'X' });
  });

  it('delta.tool_calls 增量累积 → finalMessage 的 tool_use 块，stop_reason=tool_use', async () => {
    const provider = makeProvider(
      sseResponse([
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }],
        }),
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }],
        }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ]),
    );
    const { final } = await drive(provider, {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'read_file', input_schema: { type: 'object' } } as unknown as Anthropic.Tool],
    });
    expect(final.stop_reason).toBe('tool_use');
    const toolUse = final.content.find((b) => b.type === 'tool_use');
    expect(toolUse).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } });
  });

  it('两个并行 tool_calls（不同 index）→ 两个 tool_use 块', async () => {
    const provider = makeProvider(
      sseResponse([
        JSON.stringify({
          choices: [{ delta: { tool_calls: [
            { index: 0, id: 'c0', function: { name: 't0', arguments: '{}' } },
            { index: 1, id: 'c1', function: { name: 't1', arguments: '{}' } },
          ] } }],
        }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ]),
    );
    const { final } = await drive(provider, {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 't0', input_schema: {} } as unknown as Anthropic.Tool],
    });
    const toolUses = final.content.filter((b) => b.type === 'tool_use');
    expect(toolUses).toHaveLength(2);
    expect(toolUses.map((b) => (b as Anthropic.ToolUseBlock).name)).toEqual(['t0', 't1']);
  });

  it('finish_reason=length → stop_reason=max_tokens', async () => {
    const provider = makeProvider(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: '截断' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }),
      ]),
    );
    const { final } = await drive(provider, { messages: [{ role: 'user', content: 'hi' }] });
    expect(final.stop_reason).toBe('max_tokens');
  });

  it('finalMessage 单独 await（不先迭代）也能 drain 出完整消息', async () => {
    const provider = makeProvider(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: '直接拿' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ]),
    );
    const stream = provider.stream({ system: '', tools: [], messages: [{ role: 'user', content: 'hi' }] });
    const final = await stream.finalMessage();
    expect(final.content).toEqual([{ type: 'text', text: '直接拿', citations: null }]);
  });

  it('请求体：system 提为 messages[0]、带 tools、stream + include_usage、Bearer 鉴权、URL 拼 /chat/completions', async () => {
    const capture: { body?: unknown; url?: string; headers?: unknown } = {};
    const provider = makeProvider(
      sseResponse([JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })]),
      capture,
    );
    await drive(provider, {
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 't', input_schema: { type: 'object' } } as unknown as Anthropic.Tool],
    });
    expect(capture.url).toBe('https://api.stepfun.com/v1/chat/completions');
    const body = capture.body as Record<string, unknown>;
    expect(body['model']).toBe('step-3.7-flash');
    expect(body['stream']).toBe(true);
    expect(body['stream_options']).toEqual({ include_usage: true });
    expect((body['messages'] as OpenAiMessage[])[0]).toEqual({ role: 'system', content: 'sys' });
    expect(Array.isArray(body['tools'])).toBe(true);
    expect((capture.headers as Record<string, string>)['authorization']).toBe('Bearer k');
  });

  it('无工具时不带 tools 字段', async () => {
    const capture: { body?: unknown } = {};
    const provider = makeProvider(
      sseResponse([JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })]),
      capture,
    );
    await drive(provider, { messages: [{ role: 'user', content: 'hi' }] });
    expect('tools' in (capture.body as Record<string, unknown>)).toBe(false);
  });

  it('HTTP 4xx → 抛带 status 的 Anthropic APIError', async () => {
    const provider = makeProvider(
      new Response('{"error":{"message":"bad request"}}', { status: 400 }),
    );
    const stream = provider.stream({ system: '', tools: [], messages: [{ role: 'user', content: 'hi' }] });
    await expect((async () => {
      for await (const _ of stream) { /* consume */ }
    })()).rejects.toMatchObject({ status: 400 });
  });
});
