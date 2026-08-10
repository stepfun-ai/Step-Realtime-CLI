import type Anthropic from '@anthropic-ai/sdk';

export interface PendingImage {
  mediaType: string;
  base64: string;
}

const SUPPORTED_MEDIA = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * 构建一条 user 消息的 content：无图片时返回纯文本字符串；有图片时返回
 * [文本块?, ...图片块] 的数组（Anthropic 原生 image content block，base64）。
 * StepFun 模型支持 base64 图片理解（png/jpeg/gif/webp），实测可用。
 */
export function buildUserContent(
  text: string,
  images: PendingImage[],
): Anthropic.MessageParam['content'] {
  if (images.length === 0) return text;
  const blocks: Anthropic.ContentBlockParam[] = [];
  if (text.trim() !== '') {
    blocks.push({ type: 'text', text });
  }
  for (const img of images) {
    const mediaType = SUPPORTED_MEDIA.has(img.mediaType) ? img.mediaType : 'image/png';
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
        data: img.base64,
      },
    });
  }
  return blocks;
}
