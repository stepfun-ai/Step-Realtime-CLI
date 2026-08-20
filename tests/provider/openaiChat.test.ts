import type Anthropic from '@anthropic-ai/sdk';
import { mapStepChatFinishReason } from '../../src/provider/step/stepCommon.js';
import { describe, expect, it } from 'vitest';
import {
  httpErrorToApiError,
  MAX_ACCUMULATED_CHARS,
  mapUsage,
  messagesToOpenAi,
  OpenAiChatAccumulator,
  type OpenAiMessage,
  parseToolArguments,
  toolsToOpenAi,
  withStreamIdleWatchdog,
} from '../../src/provider/openaiCommon.js';
import { OpenAiChatProvider } from '../../src/provider/openaiChat.js';
import { isRetryableError, StreamIdleTimeoutError } from '../../src/provider/retry.js';
import { normalizeHistory } from '../../src/provider/projector.js';

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
    const out = messagesToOpenAi('你是助手', [{ role: 'user', content: '你好' }], true);
    expect(out[0]).toEqual({ role: 'system', content: '你是助手' });
    expect(out[1]).toEqual({ role: 'user', content: '你好' });
  });

  it('system 空串 → 不产出 system 消息', () => {
    const out = messagesToOpenAi('', [{ role: 'user', content: '你好' }], true);
    expect(out.every((m) => m.role !== 'system')).toBe(true);
  });

  it('user 字符串内容原样透传', () => {
    const out = messagesToOpenAi('', [{ role: 'user', content: 'hi' }], true);
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
    const out = messagesToOpenAi('', messages, true);
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
    const out = messagesToOpenAi('', messages, true);
    expect((out[0] as OpenAiMessage).content).toBeNull();
  });

  it('user 的 tool_result 块 → role:tool 消息带 tool_call_id', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '文件内容' }],
      },
    ];
    const out = messagesToOpenAi('', messages, true);
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
    const out = messagesToOpenAi('', messages, true);
    expect(out[0]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '结果A' });
  });

  it('assistant 的 thinking 块按 capability.reasoning 保留或剥离', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '内部思考', signature: 's' } as unknown as Anthropic.ContentBlockParam,
          { type: 'text', text: '答复' },
        ],
      },
    ];
    // reasoning=true：保留 thinking 块，序列化为 reasoning_content
    const outKeep = messagesToOpenAi('', messages, true);
    expect((outKeep[0] as OpenAiMessage).content).toBe('答复');
    expect((outKeep[0] as OpenAiMessage).reasoning_content).toBe('内部思考');

    // reasoning=false：剥离 thinking 块
    const outStrip = messagesToOpenAi('', messages, false);
    expect((outStrip[0] as OpenAiMessage).content).toBe('答复');
    expect((outStrip[0] as OpenAiMessage).reasoning_content).toBeUndefined();
  });

  it('空 thinking 块 → reasoning_content 为空字符串（Kimi 要求含空串回传）', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: '' } as unknown as Anthropic.ContentBlockParam,
          { type: 'text', text: '答复' },
        ],
      },
    ];
    const out = messagesToOpenAi('', messages, true);
    expect((out[0] as OpenAiMessage).content).toBe('答复');
    expect((out[0] as OpenAiMessage).reasoning_content).toBe('');
  });

  it('混合 user 消息（文本 + tool_result）→ tool 消息在前、user 文本在后', () => {
    // 某些严格网关要求 tool 消息紧跟 assistant(tool_calls)，
    // 中间插一条 user 文本即 400「tool_calls must be followed by tool messages」。
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '补充一句' },
          { type: 'tool_result', tool_use_id: 'call_1', content: '文件内容' },
        ],
      },
    ];
    const out = messagesToOpenAi('', messages, true);
    expect(out).toEqual([
      { role: 'assistant', content: null, tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'call_1', content: '文件内容' },
      { role: 'user', content: '补充一句' },
    ]);
  });

  it('悬空 tool_use 经 normalizeHistory 修复后，wire 上 assistant.tool_calls 后紧跟 tool 消息', () => {
    // 端到端顺序断言：整形层把合成 tool_result 前插进带文本的 user 消息，
    // 翻译层若把文本发在 tool 前面，修复会在 wire 上被抵消（2026-08-04 严格网关 400 事故）。
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: '问' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'read_file:202', name: 'read_file', input: {} }],
      },
      { role: 'user', content: '继续完成任务' },
    ];
    const out = messagesToOpenAi('', normalizeHistory(messages), true);
    const assistantIdx = out.findIndex((m) => m.role === 'assistant');
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    const next = out[assistantIdx + 1] as OpenAiMessage;
    expect(next.role).toBe('tool');
    expect(next.tool_call_id).toBe('read_file:202');
  });
});

describe('OpenAiChatAccumulator 累积保险丝', () => {
  it('累积字符超过 MAX_ACCUMULATED_CHARS 即抛错中止（防上游洪流撑爆堆）', () => {
    // 2026-08-04 事故：两条在途流 15 分钟未结束，堆涨到 4GB 触发 V8 OOM。
    const acc = new OpenAiChatAccumulator();
    expect(() => acc.addDelta({ content: 'x'.repeat(MAX_ACCUMULATED_CHARS + 1) })).toThrow(
      /累积超过/,
    );
  });

  it('工具 arguments 同样计入预算', () => {
    const acc = new OpenAiChatAccumulator();
    expect(() =>
      acc.addDelta({
        tool_calls: [{ index: 0, id: 'c1', function: { name: 't', arguments: 'y'.repeat(MAX_ACCUMULATED_CHARS + 1) } }],
      }),
    ).toThrow(/累积超过/);
  });

  it('预算内的累积不受影响', () => {
    const acc = new OpenAiChatAccumulator();
    acc.addDelta({ content: '正常输出', reasoning_content: '正常思考' });
    const msg = acc.build('m');
    const text = msg.content.find((b) => b.type === 'text');
    expect(text).toMatchObject({ type: 'text', text: '正常输出' });
  });
});

describe('withStreamIdleWatchdog 流式空闲看门狗', () => {
  /** 按给定间隔（ms）逐个产出元素的流。 */
  async function* delayed(delays: number[]): AsyncGenerator<string> {
    for (const d of delays) {
      await new Promise((r) => setTimeout(r, d));
      yield 'x';
    }
  }

  it('间隔小于超时的流不受影响', async () => {
    const seen: string[] = [];
    for await (const v of withStreamIdleWatchdog(delayed([5, 5, 5]), 100)) seen.push(v);
    expect(seen).toEqual(['x', 'x', 'x']);
  });

  it('超过超时无任何数据 → 抛错并触发 onIdle（中止底层 fetch）', async () => {
    // 2026-08-04 事故形态：流不收尾也不报错，无限挂住。
    let idleCalled = false;
    const consume = async (): Promise<void> => {
      for await (const _ of withStreamIdleWatchdog(delayed([5, 500]), 30, () => {
        idleCalled = true;
      })) {
        /* 消费 */
      }
    };
    await expect(consume()).rejects.toThrow(/没有任何数据/);
    expect(idleCalled).toBe(true);
  });

  it('空闲超时抛 StreamIdleTimeoutError 且可重试——假死换连接可恢复，不该推给用户手动重发', async () => {
    // 2026-08-05 实测：旧版抛裸 Error，isRetryableError 接不住 → 流假死 120s 被判死后
    // 直接报错退出，与「吐字即放弃」同属把瞬时网络问题推成硬错误的缺陷。独立成类型后可重试。
    const consume = async (): Promise<void> => {
      for await (const _ of withStreamIdleWatchdog(delayed([5, 500]), 30)) {
        /* 消费 */
      }
    };
    const err = await consume().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StreamIdleTimeoutError);
    expect(isRetryableError(err)).toBe(true);
    // 反向钉住：同文案的裸 Error 不可重试——没有把所有 Error 一并放开
    expect(isRetryableError(new Error('流式响应超过 120s 没有任何数据'))).toBe(false);
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

describe('mapStepChatFinishReason', () => {
  it('tool_calls → tool_use', () => {
    expect(mapStepChatFinishReason('tool_calls', false)).toBe('tool_use');
  });
  it('function_call（OpenAI 旧字段）→ tool_use', () => {
    expect(mapStepChatFinishReason('function_call', false)).toBe('tool_use');
  });
  it('有 tool_calls 累积但 finish_reason=stop → 仍判 tool_use', () => {
    expect(mapStepChatFinishReason('stop', true)).toBe('tool_use');
  });
  it('stop → end_turn', () => {
    expect(mapStepChatFinishReason('stop', false)).toBe('end_turn');
  });
  it('length → max_tokens', () => {
    expect(mapStepChatFinishReason('length', false)).toBe('max_tokens');
  });
  it('content_filter → refusal（旧实现把它当成 end_turn，内容拦截被伪装成正常结束）', () => {
    expect(mapStepChatFinishReason('content_filter', false)).toBe('refusal');
  });
  it('null / 空串 / 未知值 → null（无信号，不冒充 end_turn）', () => {
    expect(mapStepChatFinishReason(null, false)).toBeNull();
    expect(mapStepChatFinishReason('', false)).toBeNull();
    expect(mapStepChatFinishReason(undefined, false)).toBeNull();
    expect(mapStepChatFinishReason('weird', false)).toBeNull();
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

  it('服务端的「模型不支持此接口」提示必须完整保留，不截断不改写', () => {
    // 2026-08-03 实测的真实响应：把某个只在 Messages API 开放的模型配到 Chat Completions
    // 上时，阶跃返回 400 并**直接指出该用哪个接口**。这条消息比客户端能做的任何预检提示
    // 都准确，而且不会过期（官方开放新协议时它自然消失），所以我们的职责只有一个：
    // 原样传给用户，不要吞、不要截断、不要用自己猜的措辞覆盖它。
    //
    // 相关决策：曾计划在 `step doctor config` 里加 (model, protocol) 组合预检，
    // 后判定不做——预检需要硬编码「哪个模型只在哪个接口开放」的清单，那是服务端行为
    // 快照，官方一变更就成误报；而服务端这条报错永远是最新的。详见 AGENTS.md 缺口清单。
    const body = JSON.stringify({
      error: {
        message:
          'this model is not enabled for the Chat Completions API, please use the Messages API (/v1/messages) instead',
        type: 'request_params_invalid',
      },
    });
    const err = httpErrorToApiError(400, body, new Headers());
    expect((err as { status?: number }).status).toBe(400);
    // 关键断言：可执行的那半句（该用哪个接口）不能丢
    expect(err.message).toContain('please use the Messages API (/v1/messages) instead');
    // 且不带截断省略号（这条消息 110 字符，低于 200 的截断阈值，但阈值只作用于 fallback 路径，
    // 有 error.message 时无论多长都应原样保留——这里同时钉住这个语义）
    expect(err.message).not.toContain('…');
  });

  it('非对话模型（TTS/ASR）配进 model 时的 404 提示同样完整保留', () => {
    // 阶跃 /v1/models 里 31 个模型只有少数是对话模型，其余是 ASR/TTS/图像/GUI。
    // 手滑填错的实际后果是 404，措辞略含糊（说「不存在」，其实是存在但非对话模型），
    // 但含模型名，足以定位。同样不做客户端预检，理由同上。
    const body = JSON.stringify({
      error: { message: 'The model "step-tts-2" does not exist or you do not have access to it.', type: 'model_invalid' },
    });
    const err = httpErrorToApiError(404, body, new Headers());
    expect((err as { status?: number }).status).toBe(404);
    expect(err.message).toContain('step-tts-2');
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

  it('tool_calls 增量同时合成 content_block_start[tool_use] 与 input_json_delta 流事件（成形卡的数据源）', async () => {
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
    const { events } = await drive(provider, {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'read_file', input_schema: { type: 'object' } } as unknown as Anthropic.Tool],
    });
    // start 只发一次（第二个增量块只有 arguments 没有 name/id，不重复发）
    const starts = events.filter((e) => e.type === 'content_block_start');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      index: 1000,
      content_block: { type: 'tool_use', id: 'call_1', name: 'read_file' },
    });
    // 两段 arguments 各产一条 input_json_delta
    const argDeltas = events.filter(
      (e) => e.type === 'content_block_delta' && (e.delta as { type: string }).type === 'input_json_delta',
    );
    expect(argDeltas).toHaveLength(2);
    expect(argDeltas.map((e) => (e.delta as { partial_json: string }).partial_json).join('')).toBe('{"path":"a.ts"}');
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

  // 多 completion 分段：部分上游模型在一条流里返回多个 chunk.id，互为前缀关系
  // `inner === outer + "." + <后缀>`。外层段是模型内部工作痕迹，内层段才是真答案。
  describe('多 completion 分段', () => {
    const OUTER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const INNER = `${OUTER}.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`;

    it('外层段内容归 thinking、不进正文、不产出 text_delta', async () => {
      const provider = makeProvider(
        sseResponse([
          JSON.stringify({ id: OUTER, choices: [{ delta: { content: '内部痕迹' }, finish_reason: null }] }),
          JSON.stringify({ id: INNER, choices: [{ delta: { content: '真答案' } }] }),
          JSON.stringify({ id: INNER, choices: [{ delta: {}, finish_reason: 'stop' }] }),
        ]),
      );
      const { events, final } = await drive(provider, { messages: [{ role: 'user', content: 'hi' }] });

      const textEvents = events.filter(
        (e) => e.type === 'content_block_delta' && (e.delta as { type: string }).type === 'text_delta',
      );
      // 关键：外层内容不能 yield，否则用户会实时看到它滚过去
      expect(textEvents).toHaveLength(1);
      expect((textEvents[0]?.delta as { text: string }).text).toBe('真答案');

      const text = final.content.find((b) => b.type === 'text');
      expect(text).toMatchObject({ type: 'text', text: '真答案' });
      const thinking = final.content.find((b) => b.type === 'thinking');
      expect(thinking).toMatchObject({ type: 'thinking', thinking: '内部痕迹' });
      // 外层的 finish_reason=null 不得覆盖主段的真实结束标志
      expect(final.stop_reason).toBe('end_turn');
    });

    it('单 completion 流行为完全不变（首帧照常进正文）', async () => {
      const provider = makeProvider(
        sseResponse([
          JSON.stringify({ id: OUTER, choices: [{ delta: { content: '第一句' } }] }),
          JSON.stringify({ id: OUTER, choices: [{ delta: { content: '第二句' } }] }),
          JSON.stringify({ id: OUTER, choices: [{ delta: {}, finish_reason: 'stop' }] }),
        ]),
      );
      const { events, final } = await drive(provider, { messages: [{ role: 'user', content: 'hi' }] });
      const textEvents = events.filter(
        (e) => e.type === 'content_block_delta' && (e.delta as { type: string }).type === 'text_delta',
      );
      expect(textEvents).toHaveLength(2);
      expect(final.content).toEqual([{ type: 'text', text: '第一句第二句', citations: null }]);
    });

    it('两个 id 无前缀关系时不分段，首帧仍进正文（保守兜底）', async () => {
      const provider = makeProvider(
        sseResponse([
          JSON.stringify({ id: 'id-one', choices: [{ delta: { content: '甲' } }] }),
          JSON.stringify({ id: 'id-two', choices: [{ delta: { content: '乙' } }] }),
          JSON.stringify({ id: 'id-two', choices: [{ delta: {}, finish_reason: 'stop' }] }),
        ]),
      );
      const { final } = await drive(provider, { messages: [{ role: 'user', content: 'hi' }] });
      const text = final.content.find((b) => b.type === 'text');
      expect(text).toMatchObject({ text: '甲乙' });
      expect(final.content.some((b) => b.type === 'thinking')).toBe(false);
    });

    it('只有一帧的流按主段处理（无后续帧可比对）', async () => {
      const provider = makeProvider(
        sseResponse([
          JSON.stringify({ id: OUTER, choices: [{ delta: { content: '独此一帧' }, finish_reason: 'stop' }] }),
        ]),
      );
      const { final } = await drive(provider, { messages: [{ role: 'user', content: 'hi' }] });
      expect(final.content).toEqual([{ type: 'text', text: '独此一帧', citations: null }]);
    });

    it('外层段被剥离后主段正文为空 → 判空可见（不被外层内容掩盖）', async () => {
      // 真实形态：思考吃满预算，正文零输出，但外层顾问块把总长撑到非零
      const provider = makeProvider(
        sseResponse([
          JSON.stringify({ id: OUTER, choices: [{ delta: { content: '内部痕迹填充' }, finish_reason: null }] }),
          JSON.stringify({ id: INNER, choices: [{ delta: { reasoning_content: '想很久' } }] }),
          JSON.stringify({ id: INNER, choices: [{ delta: {}, finish_reason: 'length' }] }),
        ]),
      );
      const { final } = await drive(provider, { messages: [{ role: 'user', content: 'hi' }] });
      // 正文块必须不存在——否则上层判空逻辑会把内部痕迹当成有效回答
      expect(final.content.some((b) => b.type === 'text')).toBe(false);
      expect(final.stop_reason).toBe('max_tokens');
    });

    it('无 id 字段的流（常规 OpenAI 端点）行为不变', async () => {
      const provider = makeProvider(
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: 'A' } }] }),
          JSON.stringify({ choices: [{ delta: { content: 'B' } }] }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        ]),
      );
      const { final } = await drive(provider, { messages: [{ role: 'user', content: 'hi' }] });
      expect(final.content).toEqual([{ type: 'text', text: 'AB', citations: null }]);
    });
  });
});
