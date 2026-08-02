import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { buildUserContent } from '../../src/tui/userContent.js';

describe('buildUserContent', () => {
  it('无图片时返回纯文本字符串', () => {
    expect(buildUserContent('你好', [])).toBe('你好');
  });

  it('有图片时返回 [文本块, 图片块] 数组', () => {
    const content = buildUserContent('看这张图', [{ mediaType: 'image/png', base64: 'AAAA' }]);
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as Anthropic.ContentBlockParam[];
    expect(blocks[0]).toMatchObject({ type: 'text', text: '看这张图' });
    expect(blocks[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
  });

  it('空文本 + 图片时只含图片块（允许纯图消息）', () => {
    const content = buildUserContent('', [{ mediaType: 'image/png', base64: 'X' }]);
    const blocks = content as Anthropic.ContentBlockParam[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('image');
  });

  it('多张图片全部带上', () => {
    const content = buildUserContent('两张', [
      { mediaType: 'image/png', base64: 'A' },
      { mediaType: 'image/jpeg', base64: 'B' },
    ]);
    const blocks = content as Anthropic.ContentBlockParam[];
    expect(blocks.filter((b) => b.type === 'image')).toHaveLength(2);
  });

  it('不支持的 media_type 回退为 image/png', () => {
    const content = buildUserContent('', [{ mediaType: 'image/bmp', base64: 'Z' }]);
    const blocks = content as Anthropic.ContentBlockParam[];
    expect((blocks[0] as { source: { media_type: string } }).source.media_type).toBe('image/png');
  });
});
