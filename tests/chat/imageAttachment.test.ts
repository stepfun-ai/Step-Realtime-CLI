import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  ImageAttachmentStore,
  extractImageContent,
  formatPlaceholder,
} from '../../src/chat/imageAttachment.js';

describe('formatPlaceholder', () => {
  it('生成固定英文占位符', () => {
    expect(formatPlaceholder(1, 1920, 1080)).toBe('[image #1 (1920×1080)]');
  });
});

describe('ImageAttachmentStore', () => {
  it('add 自增 id 并返回占位符', () => {
    const s = new ImageAttachmentStore();
    const a = s.add('AAAA', 'image/png', 640, 480);
    const b = s.add('BBBB', 'image/png', 100, 200);
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(a.placeholder).toBe('[image #1 (640×480)]');
    expect(s.size()).toBe(2);
  });

  it('clear 后 id 重新从 1 开始', () => {
    const s = new ImageAttachmentStore();
    s.add('X', 'image/png', 1, 1);
    s.clear();
    expect(s.size()).toBe(0);
    expect(s.add('Y', 'image/png', 1, 1).id).toBe(1);
  });

  it('activeIds 只返回文本里仍存在的占位符 id，按序去重', () => {
    const s = new ImageAttachmentStore();
    const a = s.add('A', 'image/png', 10, 10);
    const b = s.add('B', 'image/png', 20, 20);
    const text = `看 ${b.placeholder} 和 ${a.placeholder} 还有 ${b.placeholder}`;
    expect(s.activeIds(text)).toEqual([2, 1]); // 按出现顺序、去重
  });

  it('activeIds 忽略已删除/不存在的占位符', () => {
    const s = new ImageAttachmentStore();
    const a = s.add('A', 'image/png', 10, 10);
    // 手打一个不存在的 #99
    expect(s.activeIds(`${a.placeholder} [image #99 (1×1)]`)).toEqual([1]);
  });
});

describe('extractImageContent', () => {
  it('无占位符时返回纯文本', () => {
    const s = new ImageAttachmentStore();
    const r = extractImageContent('普通消息', s);
    expect(r.imageCount).toBe(0);
    expect(r.content).toBe('普通消息');
    expect(r.displayText).toBe('普通消息');
  });

  it('占位符展开为 image block，文本保留为 text block', () => {
    const s = new ImageAttachmentStore();
    const a = s.add('BASE64DATA', 'image/png', 800, 600);
    const r = extractImageContent(`看这张 ${a.placeholder} 谢谢`, s);
    expect(r.imageCount).toBe(1);
    const blocks = r.content as Anthropic.ContentBlockParam[];
    expect(Array.isArray(blocks)).toBe(true);
    const img = blocks.find((b) => b.type === 'image') as Anthropic.ImageBlockParam;
    expect(img.source).toMatchObject({ type: 'base64', media_type: 'image/png', data: 'BASE64DATA' });
    const texts = blocks.filter((b) => b.type === 'text').map((b) => (b as Anthropic.TextBlockParam).text);
    expect(texts.join('')).toContain('看这张');
    expect(texts.join('')).toContain('谢谢');
    // 展示文本折叠掉占位符
    expect(r.displayText).not.toContain('[image #');
  });

  it('多张图片按顺序展开', () => {
    const s = new ImageAttachmentStore();
    const a = s.add('A', 'image/png', 1, 1);
    const b = s.add('B', 'image/jpeg', 2, 2);
    const r = extractImageContent(`${a.placeholder}${b.placeholder}`, s);
    expect(r.imageCount).toBe(2);
    const imgs = (r.content as Anthropic.ContentBlockParam[]).filter((x) => x.type === 'image');
    expect(imgs.length).toBe(2);
  });

  it('已删除的占位符（store 查不到）留作文本，不展开', () => {
    const s = new ImageAttachmentStore();
    const r = extractImageContent('手打 [image #77 (5×5)] 文字', s);
    expect(r.imageCount).toBe(0);
    expect(r.content).toBe('手打 [image #77 (5×5)] 文字');
  });

  it('不支持的 mediaType 回落 image/png', () => {
    const s = new ImageAttachmentStore();
    const a = s.add('Z', 'image/bmp', 3, 3);
    const r = extractImageContent(a.placeholder, s);
    const img = (r.content as Anthropic.ContentBlockParam[]).find((b) => b.type === 'image') as Anthropic.ImageBlockParam;
    expect(img.source).toMatchObject({ media_type: 'image/png' });
  });
});
