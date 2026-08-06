import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import {
  applyReprojectionLevel,
  degradeMessages,
  isReprojectableError,
  nextReprojectionLevel,
  type ReprojectionLevel,
} from '../../src/provider/degrader.js';

const CC = { type: 'ephemeral' };

const imageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'x' },
} as unknown as Anthropic.ImageBlockParam;

const thinkingBlock = {
  type: 'thinking',
  thinking: '想',
  signature: 'sig',
} as unknown as Anthropic.ContentBlockParam;

/** 全支持能力：degrader 不应动任何东西。 */
const FULL_CAPABILITY = {
  image_in: true,
  reasoning: true,
  cache_control: true,
  tool_use: true,
  max_context_tokens: 0,
  max_output_tokens: 0,
};

describe('degradeMessages 主动降级', () => {
  it('image_in 为 false：图片块换成占位文本', () => {
    const out = degradeMessages(
      [{ role: 'user', content: [imageBlock, { type: 'text', text: '看图' }] }],
      { ...FULL_CAPABILITY, image_in: false },
    );
    const content = out[0]!.content as Anthropic.ContentBlockParam[];
    expect(content[0]).toEqual({
      type: 'text',
      text: '[image omitted: model has no image input]',
    });
    expect(content[1]).toEqual({ type: 'text', text: '看图' });
  });

  it('cache_control 为 false：所有块的 cache_control 被剥离', () => {
    const out = degradeMessages(
      [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hi', cache_control: CC } as Anthropic.TextBlockParam],
        },
      ],
      { ...FULL_CAPABILITY, cache_control: false },
    );
    const block = (out[0]!.content as Array<Record<string, unknown>>)[0]!;
    expect(block['cache_control']).toBeUndefined();
    expect(block['text']).toBe('hi');
  });

  it('reasoning 为 false：thinking 块被剥掉', () => {
    const out = degradeMessages(
      [{ role: 'assistant', content: [thinkingBlock, { type: 'text', text: '答' }] }],
      { ...FULL_CAPABILITY, reasoning: false },
    );
    expect(out[0]!.content).toEqual([{ type: 'text', text: '答' }]);
  });

  it('能力全支持：消息原样不动', () => {
    const input: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [imageBlock, { type: 'text', text: 'hi', cache_control: CC } as Anthropic.TextBlockParam],
      },
    ];
    const out = degradeMessages(input, FULL_CAPABILITY);
    expect(out[0]!.content).toEqual(input[0]!.content);
  });

  it('全 false 能力：三类同时降级', () => {
    const out = degradeMessages([{ role: 'assistant', content: [thinkingBlock, imageBlock] }], {
      ...FULL_CAPABILITY,
      image_in: false,
      reasoning: false,
      cache_control: false,
      tool_use: false,
    });
    expect(out[0]!.content).toEqual([
      { type: 'text', text: '[image omitted: model has no image input]' },
    ]);
  });
});

describe('applyReprojectionLevel 档位行为', () => {
  const history: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [imageBlock, { type: 'text', text: 'hi', cache_control: CC } as Anthropic.TextBlockParam],
    },
    { role: 'assistant', content: [thinkingBlock, { type: 'text', text: '答' }] },
  ];

  it('normal：原样返回', () => {
    expect(applyReprojectionLevel(history, 'normal')).toEqual(history);
  });

  it('media-degraded：媒体块换占位文本，其余不动', () => {
    const out = applyReprojectionLevel(history, 'media-degraded');
    const content = out[0]!.content as Anthropic.ContentBlockParam[];
    expect(content[0]).toEqual({ type: 'text', text: '[image removed: exceeded API image limit, older images dropped to retry]' });
    expect(out[1]).toEqual(history[1]);
  });

  it('media-degraded 保留最近 N 张：旧图换占位、最近 N 张原样保留', () => {
    // 按消息逆序数：msg3 的 imgC/imgB、msg2 的 imgA 是最近 3 张之前的全部。
    // keep=2 时保留 imgC、imgB（msg3 内也按逆序，C 比 B 新），imgA 换占位。
    const imgA = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } } as unknown as Anthropic.ImageBlockParam;
    const imgB = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'b' } } as unknown as Anthropic.ImageBlockParam;
    const imgC = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'c' } } as unknown as Anthropic.ImageBlockParam;
    const msgs: Anthropic.MessageParam[] = [
      { role: 'user', content: [imgA, { type: 'text', text: '第一张' }] },
      { role: 'assistant', content: [{ type: 'text', text: '看到了' }] },
      { role: 'user', content: [imgB, imgC, { type: 'text', text: '再看这两张' }] },
    ];
    const out = applyReprojectionLevel(msgs, 'media-degraded', 2);
    // 最旧的 imgA 被换占位
    expect((out[0]!.content as Anthropic.ContentBlockParam[])[0]).toEqual({
      type: 'text',
      text: '[image removed: exceeded API image limit, older images dropped to retry]',
    });
    // 最近两张（imgB、imgC）原样保留
    const last = out[2]!.content as Anthropic.ContentBlockParam[];
    expect(last[0]).toBe(imgB);
    expect(last[1]).toBe(imgC);
    // 文本块与 assistant 消息不动
    expect(out[1]).toEqual(msgs[1]);
  });

  it('media-degraded keep=0 时维持旧行为（全部换占位）', () => {
    const out = applyReprojectionLevel(history, 'media-degraded', 0);
    const content = out[0]!.content as Anthropic.ContentBlockParam[];
    expect(content[0]).toEqual({ type: 'text', text: '[image removed: exceeded API image limit, older images dropped to retry]' });
  });

  it('media-degraded 保留计数只算 image，document 块仍换占位', () => {
    const doc = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'd' } } as unknown as Anthropic.ContentBlockParam;
    const msgs: Anthropic.MessageParam[] = [
      { role: 'user', content: [imageBlock] },
      { role: 'user', content: [doc] },
    ];
    const out = applyReprojectionLevel(msgs, 'media-degraded', 1);
    // image 是最近 1 张，保留；document 不参与计数，换占位
    expect((out[0]!.content as Anthropic.ContentBlockParam[])[0]).toBe(imageBlock);
    expect((out[1]!.content as Anthropic.ContentBlockParam[])[0]).toEqual({
      type: 'text',
      text: '[document omitted: model has no document input]',
    });
  });

  it('media-stripped：媒体块移除，thinking 与 cache_control 保留', () => {
    const out = applyReprojectionLevel(history, 'media-stripped');
    expect((out[0]!.content as unknown[]).length).toBe(1);
    expect(JSON.stringify(out)).toContain('thinking');
  });

  it('strict：媒体移除 + thinking 剥掉 + cache_control 剥掉', () => {
    const out = applyReprojectionLevel(history, 'strict');
    const first = out[0]!.content as Array<Record<string, unknown>>;
    expect(first).toHaveLength(1);
    expect(first[0]!['cache_control']).toBeUndefined();
    expect(out[1]!.content).toEqual([{ type: 'text', text: '答' }]);
  });
});

describe('nextReprojectionLevel 错误驱动档位', () => {
  // 真实媒体方言（stepfun 实测 2026-08-06 的报错文案）
  const err400 = () =>
    new Anthropic.APIError(400, undefined, 'Input images too many. model: step-3.7-flash, max: 60, input: 61', undefined);
  const err413 = () => new Anthropic.APIError(413, undefined, 'payload too large', undefined);

  it('413 / 媒体超限 400 可重投影，从 normal 进到 media-degraded', () => {
    const used = new Set<ReprojectionLevel>(['normal']);
    expect(nextReprojectionLevel(err413(), used)).toBe('media-degraded');
    expect(nextReprojectionLevel(err400(), used)).toBe('media-degraded');
  });

  it('逐档推进：media-degraded 用过后进 media-stripped，再到 strict', () => {
    const used = new Set<ReprojectionLevel>(['normal', 'media-degraded']);
    expect(nextReprojectionLevel(err400(), used)).toBe('media-stripped');
    used.add('media-stripped');
    expect(nextReprojectionLevel(err400(), used)).toBe('strict');
  });

  it('档位用尽返回 null', () => {
    const used = new Set<ReprojectionLevel>(REPROJECTION_LEVELS_ALL);
    expect(nextReprojectionLevel(err400(), used)).toBeNull();
  });

  it('上下文溢出的 400 不重投影（该走压缩历史）', () => {
    const overflow = new Anthropic.APIError(400, undefined, 'prompt is too long', undefined);
    expect(isReprojectableError(overflow)).toBe(false);
    expect(nextReprojectionLevel(overflow, new Set(['normal']))).toBeNull();
  });

  it('裸 400（非媒体方言）不重投影：参数错误不该被降级掩盖', () => {
    const plain = new Anthropic.APIError(400, undefined, 'invalid_request_error: max_tokens must be positive', undefined);
    expect(isReprojectableError(plain)).toBe(false);
    expect(nextReprojectionLevel(plain, new Set(['normal']))).toBeNull();
  });

  it('各通道媒体方言均可重投影（issue 实录文案）', () => {
    const dialects = [
      'image exceeds 5 MB maximum: 7414068 bytes > 5242880 bytes', // Anthropic 协议 issue 实录
      'image dimensions exceed max allowed size for many-image requests: 2000 pixels', // Anthropic 多图场景
      'You can only include 10 image links. Please reduce the number accordingly.', // Gemini/Vertex
      'At most 1 image(s) may be provided in one request.', // vLLM 推理端
      'Image base64 size (8.4 MB) exceeds API limit (5.0 MB).', // OpenAI 兼容网关 issue 实录
    ];
    for (const msg of dialects) {
      const err = new Anthropic.APIError(400, undefined, msg, undefined);
      expect(isReprojectableError(err), `方言应可重投影: ${msg}`).toBe(true);
    }
  });

  it('500 / 429 / 无媒体关键词的裸 Error 不重投影', () => {
    expect(nextReprojectionLevel(new Anthropic.APIError(500, undefined, 'x', undefined), new Set(['normal']))).toBeNull();
    expect(nextReprojectionLevel(new Anthropic.APIError(429, undefined, 'x', undefined), new Set(['normal']))).toBeNull();
    expect(nextReprojectionLevel(new Error('boom'), new Set(['normal']))).toBeNull();
  });
});

const REPROJECTION_LEVELS_ALL: ReprojectionLevel[] = [
  'normal',
  'media-degraded',
  'media-stripped',
  'strict',
];
