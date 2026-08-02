import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { UNKNOWN_CAPABILITY } from '../../src/provider/capability-registry.js';
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

  it('UNKNOWN 能力（全 false）：三类同时降级', () => {
    const out = degradeMessages(
      [{ role: 'assistant', content: [thinkingBlock, imageBlock] }],
      UNKNOWN_CAPABILITY,
    );
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
    expect(content[0]).toEqual({ type: 'text', text: '[image omitted: model has no image input]' });
    expect(out[1]).toEqual(history[1]);
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
  const err400 = () => new Anthropic.APIError(400, undefined, 'invalid image', undefined);
  const err413 = () => new Anthropic.APIError(413, undefined, 'payload too large', undefined);

  it('413 / 普通 400 可重投影，从 normal 进到 media-degraded', () => {
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

  it('500 / 429 / 非 APIError 不重投影', () => {
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
