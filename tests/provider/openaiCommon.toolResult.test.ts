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

  it('带 document 块的 tool_result → document 块被丢弃（Chat Completions 不支持）', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_123',
            content: [
              { type: 'text', text: '已读取 PDF：' },
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: 'JVBERi0xLjQKJeLjz9MKMyAwIG9iago8PC9MZW5ndGgg...',
                },
              } as unknown as Anthropic.ContentBlockParam,
            ],
          },
        ],
      },
    ];
    const out = messagesToOpenAi('', messages);
    expect(out).toHaveLength(1);
    // document 块被丢弃，只剩 text 块，退化成 string
    expect(out[0]!.content).toBe('已读取 PDF：');
  });

  it('混合内容（text + image + document）→ image 转 image_url，document 丢弃', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_123',
            content: [
              { type: 'text', text: '已读取文件：' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                },
              },
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: 'JVBERi0xLjQKJeLjz9MKMyAwIG9iago8PC9MZW5ndGgg...',
                },
              } as unknown as Anthropic.ContentBlockParam,
              { type: 'text', text: '处理完成' },
            ],
          },
        ],
      },
    ];
    const out = messagesToOpenAi('', messages);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe('tool');
    expect(Array.isArray(out[0]!.content)).toBe(true);
    const parts = out[0]!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    // document 被丢弃，剩 3 个 part：text + image_url + text
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: 'text', text: '已读取文件：' });
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: {
        url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      },
    });
    expect(parts[2]).toEqual({ type: 'text', text: '处理完成' });
  });

  it('多个 tool_result 块混合（一个纯文本，一个带图片）', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_111',
            content: [{ type: 'text', text: '纯文本结果' }],
          },
          {
            type: 'tool_result',
            tool_use_id: 'call_222',
            content: [
              { type: 'text', text: '带图片结果：' },
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
    expect(out).toHaveLength(2);
    // 第一个：纯文本，退化成 string
    expect(out[0]).toEqual({
      role: 'tool',
      tool_call_id: 'call_111',
      content: '纯文本结果',
    });
    // 第二个：带图片，OpenAiContentPart[]
    expect(out[1]!.role).toBe('tool');
    expect(out[1]!.tool_call_id).toBe('call_222');
    expect(Array.isArray(out[1]!.content)).toBe(true);
  });
});

describe('messagesToOpenAi · tool_result 裸对象 content（cc-switch #6170 边缘 case）', () => {
  it('裸 image 对象 → image_url（MCP 工具真实输出形态）', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_123',
            content: { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' } as unknown as Anthropic.ToolResultBlockParam['content'],
          },
        ],
      },
    ];
    const out = messagesToOpenAi('', messages);
    expect(out[0]!.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    ]);
  });

  it('裸 text 对象 → string', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_123',
            content: { type: 'text', text: 'hello' } as unknown as Anthropic.ToolResultBlockParam['content'],
          },
        ],
      },
    ];
    const out = messagesToOpenAi('', messages);
    expect(out[0]!.content).toBe('hello');
  });

  it('无法识别的裸对象 → 空字符串（丢弃，不崩溃）', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_123',
            content: { type: 'unknown', foo: 'bar' } as unknown as Anthropic.ToolResultBlockParam['content'],
          },
        ],
      },
    ];
    const out = messagesToOpenAi('', messages);
    expect(out[0]!.content).toBe('');
  });
});

describe('messagesToOpenAi · user 消息图片块（2026-08-12 实录：贴图被静默吃掉）', () => {
  const imgBlock = {
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: 'image/png', data: 'aGVsbG8=' },
  };

  it('user [image, text] → content 升级为 parts 数组（text + image_url）', () => {
    const out = messagesToOpenAi('', [
      { role: 'user', content: [imgBlock, { type: 'text', text: '看看这个图' }] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe('user');
    expect(out[0]!.content).toEqual([
      { type: 'text', text: '看看这个图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    ]);
  });

  it('user 纯文本数组（无图片）→ 保持 string 路径不回归', () => {
    const out = messagesToOpenAi('', [
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
    ]);
    expect(out[0]!.content).toBe('你好');
  });

  it('混合消息：tool_result 在前成 tool 消息，图片+文本在后成 parts user 消息', () => {
    const out = messagesToOpenAi('', [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: '结果' },
          imgBlock,
          { type: 'text', text: '接着看' },
        ],
      },
    ]);
    expect(out[0]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '结果' });
    expect(out[1]!.role).toBe('user');
    expect(Array.isArray(out[1]!.content)).toBe(true);
  });
});

describe('messagesToOpenAi · 视频块（read_media 视频回灌）', () => {
  const videoBlock = {
    type: 'video',
    source: { type: 'base64', media_type: 'video/mp4', data: 'dmlkZW8=' },
  } as unknown as Anthropic.ContentBlockParam;

  it('tool_result 内嵌视频块 → video_url data URI part', () => {
    const out = messagesToOpenAi('', [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_v',
            content: [{ type: 'text', text: '已读取视频' }, videoBlock],
          } as Anthropic.ToolResultBlockParam,
        ],
      },
    ]);
    expect(out[0]!.role).toBe('tool');
    expect(out[0]!.content).toEqual([
      { type: 'text', text: '已读取视频' },
      { type: 'video_url', video_url: { url: 'data:video/mp4;base64,dmlkZW8=' } },
    ]);
  });

  it('user 消息内嵌视频块 → parts 数组含 video_url', () => {
    const out = messagesToOpenAi('', [
      { role: 'user', content: [{ type: 'text', text: '看这个视频' }, videoBlock] },
    ]);
    expect(out[0]!.role).toBe('user');
    expect(out[0]!.content).toEqual([
      { type: 'text', text: '看这个视频' },
      { type: 'video_url', video_url: { url: 'data:video/mp4;base64,dmlkZW8=' } },
    ]);
  });
});
