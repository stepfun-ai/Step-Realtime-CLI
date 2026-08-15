/**
 * 图片附件在 pi 侧的提交路径测试。
 *
 * 这里测的是「占位符文本 → image content block」这一段：附件池与展开逻辑是共用的
 * 纯逻辑（src/chat/imageAttachment.ts），pi 侧新增的是接线，所以断言集中在
 * extractImageContent 的契约上——写坏了表现为图片被当普通文本发出去，模型看不到图。
 */
import { describe, expect, it } from 'vitest';
import { extractImageContent, ImageAttachmentStore } from '../../src/chat/imageAttachment.js';

const PNG = 'iVBORw0KGgo=';

describe('图片占位符提交路径', () => {
  it('占位符展开为 image block，正文保留为 text block', () => {
    const store = new ImageAttachmentStore();
    const att = store.add(PNG, 'image/png', 800, 600);
    const r = extractImageContent(`看这张图 ${att.placeholder} 说说问题`, store);
    expect(r.imageCount).toBe(1);
    expect(Array.isArray(r.content)).toBe(true);
    const blocks = r.content as { type: string }[];
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image', 'text']);
    expect(r.displayText).not.toContain(PNG);
  });

  it('没有占位符时返回纯文本（不改旧路径）', () => {
    const store = new ImageAttachmentStore();
    const r = extractImageContent('普通消息', store);
    expect(r.imageCount).toBe(0);
    expect(r.content).toBe('普通消息');
  });

  it('用户删掉占位符即等于移除该图', () => {
    const store = new ImageAttachmentStore();
    const att = store.add(PNG, 'image/png', 10, 10);
    const r = extractImageContent('删掉了'.concat(att.placeholder.slice(0, 3)), store);
    expect(r.imageCount).toBe(0);
  });

  it('陈旧占位符（池里已无）留作文本，不报错', () => {
    const store = new ImageAttachmentStore();
    const att = store.add(PNG, 'image/png', 10, 10);
    const text = `x ${att.placeholder}`;
    store.clear();
    const r = extractImageContent(text, store);
    expect(r.imageCount).toBe(0);
    expect(r.content).toBe(text);
  });

  it('多张图按出现顺序展开', () => {
    const store = new ImageAttachmentStore();
    const a = store.add(PNG, 'image/png', 1, 1);
    const b = store.add(PNG, 'image/jpeg', 2, 2);
    const r = extractImageContent(`${a.placeholder} 和 ${b.placeholder}`, store);
    expect(r.imageCount).toBe(2);
    const blocks = r.content as { type: string; source?: { media_type: string } }[];
    const images = blocks.filter((x) => x.type === 'image');
    expect(images[0]!.source!.media_type).toBe('image/png');
    expect(images[1]!.source!.media_type).toBe('image/jpeg');
  });
});
