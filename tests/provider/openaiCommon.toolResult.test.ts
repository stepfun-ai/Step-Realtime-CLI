import { describe, it, expect } from 'vitest';
import { messagesToOpenAi } from '../../src/provider/openaiCommon.js';
import type Anthropic from '@anthropic-ai/sdk';

describe('messagesToOpenAi · tool_result 图片块', () => {
  it('纯文本 tool_result → string content', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_123',
            content: [{ type: 'text', text: '文件内容...' }],
          },
        ],
      },
    ];
    const out = messagesToOpenAi('', messages);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      role: 'tool',
      tool_call_id: 'call_123',
      content: '文件内容...',
    });
  });

  it('带图片的 tool_result → OpenAiContentPart[] content', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_123',
            content: [
              { type: 'text', text: '已读取图片：image/png' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                },
              },
            ],
          },
        ],
      },
    ];
    const out = messagesToOpenAi('', messages);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe('tool');
    expect(out[0]!.tool_call_id).toBe('call_123');
    expect(Array.isArray(out[0]!.content)).toBe(true);
    const parts = out[0]!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: 'text', text: '已读取图片：image/png' });
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: {
        url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      },
    });
  });

  it('string content 的 tool_result 原样透传', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_123',
            content: '简单字符串结果',
          },
        ],
      },
    ];
    const out = messagesToOpenAi('', messages);
    expect(out[0]!.content).toBe('简单字符串结果');
  });
});
