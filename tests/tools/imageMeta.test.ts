import { describe, expect, it } from 'vitest';
import { parseImageMeta } from '../../src/tools/imageMeta.js';

/** 构造 PNG：8 字节签名 + IHDR 长度/类型 + 宽高（大端 uint32）。 */
function makePng(w: number, h: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // 8..15 IHDR length + "IHDR"（内容不影响宽高解析）
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return b;
}

/** 构造 GIF：GIF89a + 宽高（小端 uint16）。 */
function makeGif(w: number, h: number): Uint8Array {
  const b = new Uint8Array(13);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // "GIF89a"
  b[6] = w & 0xff;
  b[7] = (w >> 8) & 0xff;
  b[8] = h & 0xff;
  b[9] = (h >> 8) & 0xff;
  return b;
}

/** 构造 JPEG：SOI + SOF0 段（含高、宽大端 uint16）。 */
function makeJpeg(w: number, h: number): Uint8Array {
  const b = new Uint8Array(20);
  b[0] = 0xff;
  b[1] = 0xd8; // SOI
  b[2] = 0xff;
  b[3] = 0xc0; // SOF0
  b[4] = 0x00;
  b[5] = 0x11; // 段长
  b[6] = 0x08; // 精度
  b[7] = (h >> 8) & 0xff;
  b[8] = h & 0xff;
  b[9] = (w >> 8) & 0xff;
  b[10] = w & 0xff;
  return b;
}

/** 构造 WebP VP8X 扩展格式：RIFF....WEBP + VP8X + 宽高（24 位小端，存 实际-1）。 */
function makeWebpVp8x(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  b.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  const wm = w - 1;
  const hm = h - 1;
  b[24] = wm & 0xff;
  b[25] = (wm >> 8) & 0xff;
  b[26] = (wm >> 16) & 0xff;
  b[27] = hm & 0xff;
  b[28] = (hm >> 8) & 0xff;
  b[29] = (hm >> 16) & 0xff;
  return b;
}

describe('parseImageMeta', () => {
  it('解析 PNG 宽高', () => {
    expect(parseImageMeta(makePng(1920, 1080))).toEqual({
      mime: 'image/png',
      width: 1920,
      height: 1080,
    });
  });

  it('解析 GIF 宽高', () => {
    expect(parseImageMeta(makeGif(640, 480))).toEqual({
      mime: 'image/gif',
      width: 640,
      height: 480,
    });
  });

  it('解析 JPEG 宽高', () => {
    expect(parseImageMeta(makeJpeg(800, 600))).toEqual({
      mime: 'image/jpeg',
      width: 800,
      height: 600,
    });
  });

  it('解析 WebP (VP8X) 宽高', () => {
    expect(parseImageMeta(makeWebpVp8x(2560, 1440))).toEqual({
      mime: 'image/webp',
      width: 2560,
      height: 1440,
    });
  });

  it('非图片字节返回 null', () => {
    expect(parseImageMeta(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
  });

  it('过短的字节返回 null', () => {
    expect(parseImageMeta(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});
