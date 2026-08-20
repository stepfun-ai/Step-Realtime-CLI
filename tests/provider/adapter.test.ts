import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { StepfunAdapter } from '../../src/provider/adapter.js';
import type { CapabilityOverride } from '../../src/provider/capability-registry.js';
import type { ChatProvider } from '../../src/provider/types.js';

type StreamLike = ReturnType<Anthropic['messages']['stream']>;

/** 构造一个最小的最终消息。 */
function fakeMessage(text = 'ok'): Anthropic.Message {
  return {
    id: 'm1',
    type: 'message',
    role: 'assistant',
    model: 'step-3.7-flash',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}

/** 假流：可 for await（空事件序列），finalMessage 成功或按序抛错。 */
function fakeStream(result: Anthropic.Message | unknown): StreamLike {
  const isErr = result instanceof Error;
  return {
    async *[Symbol.asyncIterator]() {
      if (isErr) throw result;
    },
    async finalMessage() {
      if (isErr) throw result;
      return result as Anthropic.Message;
    },
  } as unknown as StreamLike;
}

/** mock 的内部协议 provider：记录每次收到的参数，按队列抛出前 N 个错误。 */
class MockInner implements ChatProvider {
  calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
  private failures: unknown[];

  constructor(failures: unknown[] = []) {
    this.failures = [...failures];
  }

  stream(params: { messages: Anthropic.MessageParam[] }): StreamLike {
    this.calls.push({ messages: params.messages });
    const err = this.failures.shift();
    return fakeStream(err !== undefined ? err : fakeMessage());
  }
}

const imageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'x' },
} as unknown as Anthropic.ImageBlockParam;

function makeAdapter(inner: MockInner, overrides?: CapabilityOverride[]): StepfunAdapter {
  return new StepfunAdapter({
    apiKey: 'k',
    baseUrl: 'https://example.invalid',
    model: 'step-3.7-flash',
    maxTokens: 1024,
    inner,
    capabilityOverrides: overrides,
  });
}

describe('StepfunAdapter.stream：投影 + 主动降级 + 透传', () => {
  it('孤儿 tool_result 在投影阶段被修复，内部 provider 收到干净历史', () => {
    const inner = new MockInner();
    const adapter = makeAdapter(inner);
    adapter.stream({
      system: 's',
      tools: [],
      messages: [
        { role: 'user', content: '问' },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'ghost', content: 'r' }],
        },
      ],
    });
    expect(JSON.stringify(inner.calls[0]!.messages)).not.toContain('ghost');
  });

  it('stepfun 能力表 image_in 为 true：图片块原样透传', () => {
    const inner = new MockInner();
    const adapter = makeAdapter(inner);
    adapter.stream({ system: 's', tools: [], messages: [{ role: 'user', content: [imageBlock] }] });
    expect(JSON.stringify(inner.calls[0]!.messages)).toContain('image');
  });

  it('config 覆盖 image_in=false：图片块被主动降级为占位文本', () => {
    const inner = new MockInner();
    const adapter = makeAdapter(inner, [
      { channel: 'stepfun', model: 'step-3.7-flash', capability: { image_in: false } },
    ]);
    adapter.stream({ system: 's', tools: [], messages: [{ role: 'user', content: [imageBlock] }] });
    const sent = JSON.stringify(inner.calls[0]!.messages);
    expect(sent).toContain('[image omitted: model has no image input]');
    expect(sent).not.toContain('base64');
  });

  it('首条非 user 时补空 user 开场', () => {
    const inner = new MockInner();
    const adapter = makeAdapter(inner);
    adapter.stream({
      system: 's',
      tools: [],
      messages: [{ role: 'assistant', content: '答' }],
    });
    expect(inner.calls[0]!.messages[0]).toEqual({ role: 'user', content: '' });
  });

  it('runtime capabilities 优先于构造时 overrides：runtime 开启可覆盖构造时关闭', () => {
    const inner = new MockInner();
    // 构造时 override image_in=false → 图片被主动降级
    const adapter = makeAdapter(inner, [
      { channel: 'stepfun', model: 'step-3.7-flash', capability: { image_in: false } },
    ]);
    adapter.stream({ system: 's', tools: [], messages: [{ role: 'user', content: [imageBlock] }] });
    expect(JSON.stringify(inner.calls[0]!.messages)).toContain('[image omitted: model has no image input]');

    // runtime 注入 image_in：覆盖构造时的 false → 图片原样透传
    adapter.setRuntimeCapabilities(['image_in']);
    adapter.stream({ system: 's', tools: [], messages: [{ role: 'user', content: [imageBlock] }] });
    expect(JSON.stringify(inner.calls[1]!.messages)).toContain('image');
    expect(JSON.stringify(inner.calls[1]!.messages)).not.toContain('[image omitted');
  });
});

describe('StepfunAdapter.send：错误驱动重投影', () => {
  const mediaHistory: Anthropic.MessageParam[] = [{ role: 'user', content: [imageBlock] }];

  it('400 后沿档位降级重发：第二次请求媒体块已换占位文本', async () => {
    const inner = new MockInner([new Anthropic.APIError(400, undefined, 'Input images too many. max: 60, input: 61', undefined)]);
    const adapter = makeAdapter(inner);
    const res = await adapter.send({ system: 's', tools: [], messages: mediaHistory });
    expect(res.message.content[0]).toMatchObject({ type: 'text', text: 'ok' });
    expect(inner.calls).toHaveLength(2);
    // 第一次按能力表透传图片；第二次走 media-degraded 档换占位文本
    expect(JSON.stringify(inner.calls[0]!.messages)).toContain('base64');
    expect(JSON.stringify(inner.calls[1]!.messages)).toContain('[image removed');
  });

  it('连续失败逐档推进，档位用尽后抛出最后一次错误', async () => {
    const inner = new MockInner([
      new Anthropic.APIError(400, undefined, 'Input images too many. max: 60 (e1)', undefined),
      new Anthropic.APIError(400, undefined, 'Input images too many. max: 60 (e2)', undefined),
      new Anthropic.APIError(400, undefined, 'Input images too many. max: 60 (e3)', undefined),
      new Anthropic.APIError(400, undefined, 'Input images too many. max: 60 (e4)', undefined),
    ]);
    const adapter = makeAdapter(inner);
    await expect(adapter.send({ system: 's', tools: [], messages: mediaHistory })).rejects.toThrow(
      /e4/,
    );
    // normal + media-degraded + media-stripped + strict 共 4 次，每档一次
    expect(inner.calls).toHaveLength(4);
    // strict 档：媒体块整个移除
    expect(JSON.stringify(inner.calls[3]!.messages)).not.toContain('base64');
    expect(JSON.stringify(inner.calls[3]!.messages)).not.toContain('image omitted');
  });

  it('不可重投影的错误（500）直接抛出，不重发', async () => {
    const inner = new MockInner([new Anthropic.APIError(500, undefined, 'boom', undefined)]);
    const adapter = makeAdapter(inner);
    await expect(adapter.send({ system: 's', tools: [], messages: mediaHistory })).rejects.toThrow();
    expect(inner.calls).toHaveLength(1);
  });

  it('上下文溢出 400 直接抛出，不走重投影', async () => {
    const inner = new MockInner([
      new Anthropic.APIError(400, undefined, 'prompt is too long', undefined),
    ]);
    const adapter = makeAdapter(inner);
    await expect(adapter.send({ system: 's', tools: [], messages: mediaHistory })).rejects.toThrow();
    expect(inner.calls).toHaveLength(1);
  });
});
