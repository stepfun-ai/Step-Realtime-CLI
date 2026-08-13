import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  buildResponsesMessage,
  messagesToResponsesInput,
  OpenAiResponsesProvider,
  toolsToResponses,
} from '../../src/provider/openaiResponses.js';

/** 把若干 Responses 流式事件拼成 SSE 响应体。 */
function sseResponse(events: unknown[], status = 200): Response {
  const body = `${events.map((e) => `data: ${JSON.stringify(e)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

function makeProvider(response: Response, capture?: { body?: unknown; url?: string }): OpenAiResponsesProvider {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (capture !== undefined) {
      capture.url = url;
      capture.body = JSON.parse(init.body as string);
    }
    return response;
  }) as unknown as typeof fetch;
  return new OpenAiResponsesProvider({
    apiKey: 'k',
    baseUrl: 'https://api.stepfun.com/v1',
    model: 'step-3.7-flash',
    maxTokens: 32768,
    fetchImpl,
  });
}

/**
 * 一个最小可用的 response.completed 事件。
 *
 * 必须带 `status: 'completed'`：真实服务端的 response.completed 事件一定含该字段
 * （官方文档 SSE 示例即为 `"status":"completed"`），而 stop_reason 现在由
 * status + incomplete_details.reason 推导。省掉它会让假数据比真实响应「更贫」，
 * 测出来的 stop_reason 也就不作数。
 */
function completedEvent(output: unknown[], usage?: unknown): unknown {
  return {
    type: 'response.completed',
    response: { status: 'completed', output, ...(usage !== undefined ? { usage } : {}) },
  };
}

describe('buildResponsesMessage', () => {
  it('output 的 reasoning→thinking、message→text（thinking 在前）', () => {
    const msg = buildResponsesMessage(
      {
        status: 'completed',
        output: [
          { type: 'reasoning', content: [{ type: 'reasoning_text', text: '思考中' }] },
          { type: 'message', content: [{ type: 'output_text', text: '最终答复' }] },
        ],
        usage: { input_tokens: 20, output_tokens: 8 },
      },
      'step-3.7-flash',
      32768,
    );
    expect(msg.content[0]).toMatchObject({ type: 'thinking', thinking: '思考中' });
    expect(msg.content[1]).toMatchObject({ type: 'text', text: '最终答复' });
    expect(msg.stop_reason).toBe('end_turn');
    expect(msg.usage.input_tokens).toBe(20);
    expect(msg.usage.output_tokens).toBe(8);
  });

  it('只有 message 段 → 仅 text 块', () => {
    const msg = buildResponsesMessage(
      { output: [{ type: 'message', content: [{ type: 'output_text', text: '纯对话' }] }] },
      'm',
      100,
    );
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]).toMatchObject({ type: 'text', text: '纯对话' });
  });

  it('缺 usage → usage 全 0', () => {
    const msg = buildResponsesMessage({ output: [] }, 'm', 100);
    expect(msg.usage.input_tokens).toBe(0);
    expect(msg.usage.output_tokens).toBe(0);
  });

  it('function_call → tool_use（id 取 call_id、arguments 解析成对象），stop_reason=tool_use', () => {
    const msg = buildResponsesMessage(
      {
        status: 'completed',
        output: [
          { type: 'reasoning', content: [{ type: 'reasoning_text', text: '要查天气' }] },
          {
            type: 'function_call',
            id: 'fc_9c6933c87cf49dff',
            call_id: 'chatcmpl-tool-a44059ad3db0184c',
            name: 'get_weather',
            arguments: '{"city": "北京"}',
            status: 'completed',
          },
        ],
      },
      'm',
      100,
    );
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.content[0]).toMatchObject({ type: 'thinking' });
    expect(msg.content[1]).toMatchObject({
      type: 'tool_use',
      id: 'chatcmpl-tool-a44059ad3db0184c',
      name: 'get_weather',
      input: { city: '北京' },
    });
  });

  it('function_call 的 arguments 非法 JSON → input 退化成 {}', () => {
    const msg = buildResponsesMessage(
      { output: [{ type: 'function_call', call_id: 'c1', name: 'x', arguments: '{不是 JSON' }] },
      'm',
      100,
    );
    expect(msg.content[0]).toMatchObject({ type: 'tool_use', id: 'c1', input: {} });
  });

  it('多个 function_call → 多个 tool_use 块，顺序保持', () => {
    const msg = buildResponsesMessage(
      {
        output: [
          { type: 'function_call', call_id: 'c1', name: 'a', arguments: '{}' },
          { type: 'function_call', call_id: 'c2', name: 'b', arguments: '{"k":1}' },
        ],
      },
      'm',
      100,
    );
    expect(msg.content).toHaveLength(2);
    expect(msg.content.map((b) => (b as unknown as { id: string }).id)).toEqual(['c1', 'c2']);
  });
});

describe('toolsToResponses', () => {
  it('平铺形状：name/description/parameters 直接挂在 item 上（input_schema→parameters）', () => {
    const tools = toolsToResponses([
      {
        name: 'get_weather',
        description: '查天气',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      } as unknown as Anthropic.Tool,
    ]);
    expect(tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: '查天气',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]);
    // 不是 Chat 的嵌套形状
    expect(tools[0]).not.toHaveProperty('function');
  });

  it('description 缺失或空串 → 不带该字段；input_schema 缺失 → parameters 为 {}', () => {
    const tools = toolsToResponses([
      { name: 'a', description: '' } as unknown as Anthropic.Tool,
      { name: 'b' } as unknown as Anthropic.Tool,
    ]);
    expect(tools[0]).toEqual({ type: 'function', name: 'a', parameters: {} });
    expect(tools[1]).toEqual({ type: 'function', name: 'b', parameters: {} });
  });
});

describe('messagesToResponsesInput', () => {
  it('system + 字符串消息 → role/content 项', () => {
    expect(
      messagesToResponsesInput('sys', [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'yo' },
      ]),
    ).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ]);
  });

  it('工具往返：tool_use→function_call、tool_result→function_call_output，call_id 关联', () => {
    const input = messagesToResponsesInput('', [
      { role: 'user', content: '北京天气' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '要查', signature: '' } as unknown as Anthropic.ContentBlockParam,
          { type: 'text', text: '我查一下' },
          { type: 'tool_use', id: 'call-1', name: 'get_weather', input: { city: '北京' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '{"temp":31}' }],
      },
    ]);
    expect(input).toEqual([
      { role: 'user', content: '北京天气' },
      { role: 'assistant', content: '我查一下' },
      { type: 'function_call', name: 'get_weather', call_id: 'call-1', arguments: '{"city":"北京"}' },
      { type: 'function_call_output', call_id: 'call-1', output: '{"temp":31}' },
    ]);
  });

  it('纯工具调用轮（无正文）→ 只出 function_call 项，不插空 assistant', () => {
    const input = messagesToResponsesInput('', [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 't', input: {} }],
      },
    ]);
    expect(input).toEqual([{ type: 'function_call', name: 't', call_id: 'c1', arguments: '{}' }]);
  });

  it('tool_result 的 content 为文本块数组 → 拼接成 output 字符串', () => {
    const input = messagesToResponsesInput('', [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'c1',
            content: [
              { type: 'text', text: 'a' },
              { type: 'text', text: 'b' },
            ],
          },
        ],
      },
    ]);
    expect(input).toEqual([{ type: 'function_call_output', call_id: 'c1', output: 'ab' }]);
  });

  it('混合 user 消息（文本 + tool_result）→ function_call_output 在前、user 文本在后', () => {
    // 与 messagesToOpenAi 同一顺序约定：整形层会把合成/迟到的 tool_result 与插话文本
    // 合进同一条 user 消息，输出项先发出能保持「调用紧邻结果」的 input 形态。
    const input = messagesToResponsesInput('', [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 't', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '补充一句' },
          { type: 'tool_result', tool_use_id: 'c1', content: '结果' },
        ],
      },
    ]);
    expect(input).toEqual([
      { type: 'function_call', name: 't', call_id: 'c1', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: '结果' },
      { role: 'user', content: '补充一句' },
    ]);
  });
});

describe('OpenAiResponsesProvider', () => {
  it('请求体：input 含 system + user、URL 拼 /responses、stream 为 true、无 tools 时不带 tools 字段', async () => {
    const capture: { body?: unknown; url?: string } = {};
    const provider = makeProvider(
      sseResponse([completedEvent([{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }])]),
      capture,
    );
    const stream = provider.stream({ system: 'sys', tools: [], messages: [{ role: 'user', content: 'hi' }] });
    await stream.finalMessage();
    expect(capture.url).toBe('https://api.stepfun.com/v1/responses');
    const body = capture.body as Record<string, unknown>;
    expect(body['input']).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
    expect(body['max_output_tokens']).toBe(32768);
    expect(body['stream']).toBe(true);
    expect(body).not.toHaveProperty('tools');
  });

  it('请求体：tools 非空 → 平铺 tools 字段随请求发出（不再报错）', async () => {
    const capture: { body?: unknown; url?: string } = {};
    const provider = makeProvider(sseResponse([completedEvent([])]), capture);
    const stream = provider.stream({
      system: '',
      tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object' } } as unknown as Anthropic.Tool],
      messages: [{ role: 'user', content: 'hi' }],
    });
    await stream.finalMessage();
    const body = capture.body as Record<string, unknown>;
    expect(body['tools']).toEqual([
      { type: 'function', name: 'get_weather', description: '查天气', parameters: { type: 'object' } },
    ]);
  });

  it('请求体：工具结果回灌 → input 里 function_call 与 function_call_output 成对且 call_id 一致', async () => {
    const capture: { body?: unknown; url?: string } = {};
    const provider = makeProvider(sseResponse([completedEvent([])]), capture);
    const stream = provider.stream({
      system: '',
      tools: [{ name: 'get_weather', input_schema: {} } as unknown as Anthropic.Tool],
      messages: [
        { role: 'user', content: '北京天气' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'chatcmpl-tool-a44059', name: 'get_weather', input: { city: '北京' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'chatcmpl-tool-a44059', content: '{"temp":31}' }],
        },
      ],
    });
    await stream.finalMessage();
    const input = (capture.body as { input: Array<Record<string, unknown>> }).input;
    const call = input.find((i) => i['type'] === 'function_call');
    const output = input.find((i) => i['type'] === 'function_call_output');
    expect(call).toEqual({
      type: 'function_call',
      name: 'get_weather',
      call_id: 'chatcmpl-tool-a44059',
      arguments: '{"city":"北京"}',
    });
    expect(output).toEqual({
      type: 'function_call_output',
      call_id: 'chatcmpl-tool-a44059',
      output: '{"temp":31}',
    });
    // 回灌路径不使用 Chat 的 role:'tool' 消息
    expect(input.some((i) => i['role'] === 'tool')).toBe(false);
  });

  it('流式纯对话：reasoning/text 增量逐条吐出，finalMessage 取 response.completed', async () => {
    const provider = makeProvider(
      sseResponse([
        { type: 'response.created' },
        { type: 'response.in_progress' },
        { type: 'response.output_item.added', item: { type: 'reasoning' } },
        { type: 'response.reasoning_text.delta', delta: '想' },
        { type: 'response.reasoning_text.delta', delta: '了想' },
        { type: 'response.output_text.delta', delta: '答' },
        { type: 'response.output_text.delta', delta: '案' },
        completedEvent(
          [
            { type: 'reasoning', content: [{ type: 'reasoning_text', text: '想了想' }] },
            { type: 'message', content: [{ type: 'output_text', text: '答案' }] },
          ],
          { input_tokens: 5, output_tokens: 2 },
        ),
      ]),
    );
    const stream = provider.stream({ system: '', tools: [], messages: [{ role: 'user', content: 'hi' }] });
    const events: Anthropic.MessageStreamEvent[] = [];
    for await (const ev of stream) events.push(ev);
    const final = await stream.finalMessage();
    const kinds = events.map((e) => (e.delta as { type: string }).type);
    expect(kinds).toEqual(['thinking_delta', 'thinking_delta', 'text_delta', 'text_delta']);
    expect(final.content[0]).toMatchObject({ type: 'thinking', thinking: '想了想' });
    expect(final.content[1]).toMatchObject({ type: 'text', text: '答案' });
    expect(final.stop_reason).toBe('end_turn');
    expect(final.usage.output_tokens).toBe(2);
  });

  it('流式工具调用：tool_use.id 取 response.completed 的 call_id，而非流式中间事件里的 call_id', async () => {
    const provider = makeProvider(
      sseResponse([
        { type: 'response.created' },
        {
          type: 'response.output_item.added',
          item: { type: 'function_call', call_id: 'call_864cb5000a1ffd02', name: 'get_weather' },
        },
        { type: 'response.function_call_arguments.delta', delta: '{"city": "北京"}' },
        { type: 'response.function_call_arguments.done', arguments: '{"city": "北京"}', name: 'get_weather' },
        { type: 'response.output_item.done' },
        completedEvent([
          {
            type: 'function_call',
            id: 'fc_9c6933c87cf49dff',
            call_id: 'chatcmpl-tool-a44059ad3db0184c',
            name: 'get_weather',
            arguments: '{"city": "北京"}',
          },
        ]),
      ]),
    );
    const stream = provider.stream({
      system: '',
      tools: [{ name: 'get_weather', input_schema: {} } as unknown as Anthropic.Tool],
      messages: [{ role: 'user', content: '北京天气' }],
    });
    for await (const _ of stream) { /* 工具调用轮无文本增量 */ }
    const final = await stream.finalMessage();
    expect(final.stop_reason).toBe('tool_use');
    expect(final.content[0]).toMatchObject({
      type: 'tool_use',
      id: 'chatcmpl-tool-a44059ad3db0184c',
      name: 'get_weather',
      input: { city: '北京' },
    });
  });

  it('只 await finalMessage（不迭代）也能拿到完整结果，且只请求一次', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return sseResponse([completedEvent([{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }])]);
    }) as unknown as typeof fetch;
    const provider = new OpenAiResponsesProvider({
      apiKey: 'k',
      baseUrl: 'https://api.stepfun.com/v1',
      model: 'm',
      maxTokens: 100,
      fetchImpl,
    });
    const stream = provider.stream({ system: '', tools: [], messages: [{ role: 'user', content: 'hi' }] });
    const final = await stream.finalMessage();
    expect(calls).toBe(1);
    expect(final.content[0]).toMatchObject({ type: 'text', text: 'ok' });
  });

  it('HTTP 错误 → 抛带 status 的 Anthropic APIError', async () => {
    const provider = makeProvider(jsonResponse({ error: { message: 'boom' } }, 500));
    const stream = provider.stream({ system: '', tools: [], messages: [{ role: 'user', content: 'hi' }] });
    await expect(stream.finalMessage()).rejects.toMatchObject({ status: 500 });
  });
});

describe('stop_reason 由 status + incomplete_details 推导（空响应根因）', () => {
  it('status=incomplete + reason=max_output_tokens → max_tokens（不再冒充 end_turn）', () => {
    // 这是「服务端返回了空响应」的真实形状：思考吃满预算，output 里没有 message 项。
    // 旧实现写死 end_turn，把预算耗尽伪装成正常收尾，上层无从分型。
    const msg = buildResponsesMessage(
      {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: '想了很久' }] }],
      },
      'm',
      100,
    );
    expect(msg.stop_reason).toBe('max_tokens');
  });

  it('status=incomplete + reason=content_filter → refusal', () => {
    const msg = buildResponsesMessage(
      { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] },
      'm',
      100,
    );
    expect(msg.stop_reason).toBe('refusal');
  });

  it('status=failed → null（非正常收尾，交上层分型）', () => {
    const msg = buildResponsesMessage(
      { status: 'failed', error: { message: 'boom' }, output: [] },
      'm',
      100,
    );
    expect(msg.stop_reason).toBeNull();
  });

  it('status 缺失 → null（无信号，不假装正常结束）', () => {
    expect(buildResponsesMessage({ output: [] }, 'm', 100).stop_reason).toBeNull();
  });

  it('status=completed 且含 function_call → tool_use', () => {
    const msg = buildResponsesMessage(
      {
        status: 'completed',
        output: [{ type: 'function_call', call_id: 'c1', name: 'x', arguments: '{}' }],
      },
      'm',
      100,
    );
    expect(msg.stop_reason).toBe('tool_use');
  });
});

describe('messagesToResponsesInput · user 消息图片块', () => {
  it('user [image, text] → input_text + input_image parts', async () => {
    const { messagesToResponsesInput } = await import('../../src/provider/openaiResponses.js');
    const out = messagesToResponsesInput('', [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
          },
          { type: 'text', text: '看看这个图' },
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: '看看这个图' },
        { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' },
      ],
    });
  });
});
