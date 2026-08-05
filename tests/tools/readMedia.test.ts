import { randomFillSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Jimp } from 'jimp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeTool } from '../../src/tools/index.js';
import { parseImageMeta } from '../../src/tools/imageMeta.js';
import {
  READ_MEDIA_IMAGE_BYTE_BUDGET,
  READ_MEDIA_MAX_EDGE_PX,
} from '../../src/tools/readMedia.js';
import type { ToolContext } from '../../src/tools/types.js';

let dir: string;
let ctx: ToolContext;

/** 用 jimp 现场生成纯色 PNG 字节（不进二进制 fixture）。 */
async function pngBytes(width: number, height: number): Promise<Buffer> {
  const img = new Jimp({ width, height, color: 0x3366ccff });
  return img.getBuffer('image/png');
}

/** 生成噪声 PNG（压缩率高不了，用于撑过字节预算的用例）。 */
async function noisePngBytes(width: number, height: number): Promise<Buffer> {
  const img = new Jimp({ width, height, color: 0x000000ff });
  randomFillSync(img.bitmap.data as Buffer);
  return img.getBuffer('image/png');
}

function writePng(name: string, bytes: Buffer): string {
  writeFileSync(join(dir, name), bytes);
  return name;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stepcode-readmedia-'));
  ctx = { cwd: dir, capabilities: ['image_in'] };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('read_media', () => {
  it('小 PNG 直通：不解码，字节原样交付，note 标注原图未改动', async () => {
    const bytes = await pngBytes(100, 80);
    writePng('small.png', bytes);

    const r = await executeTool('read_media', { path: 'small.png' }, ctx);
    expect(r.isError).toBe(false);
    expect(r.images).toHaveLength(1);
    expect(r.images![0]!.mediaType).toBe('image/png');
    expect(Buffer.from(r.images![0]!.base64, 'base64').equals(bytes)).toBe(true);
    expect(r.content).toContain('原图未改动');
    expect(r.content).toContain('100×80');
    expect(r.content).toContain('<system>');
  });

  it('3000×2000 PNG 降采样：长边 ≤1568 且 note 标注已降采样', async () => {
    const bytes = await pngBytes(3000, 2000);
    writePng('big.png', bytes);

    const r = await executeTool('read_media', { path: 'big.png' }, ctx);
    expect(r.isError).toBe(false);
    expect(r.images).toHaveLength(1);
    expect(r.content).toContain('已降采样');
    expect(r.content).toContain('3000×2000'); // 原始尺寸仍标注
    const delivered = Buffer.from(r.images![0]!.base64, 'base64');
    const meta = parseImageMeta(delivered);
    expect(meta).not.toBeNull();
    expect(Math.max(meta!.width, meta!.height)).toBeLessThanOrEqual(READ_MEDIA_MAX_EDGE_PX);
    expect(delivered.length).toBeLessThanOrEqual(READ_MEDIA_IMAGE_BYTE_BUDGET);
  });

  it('region 裁剪：note 含区域坐标且交付尺寸正确', async () => {
    const bytes = await pngBytes(3000, 2000);
    writePng('crop.png', bytes);

    const r = await executeTool(
      'read_media',
      { path: 'crop.png', region: { x: 100, y: 50, width: 400, height: 300 } },
      ctx,
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain('x=100,y=50,w=400,h=300');
    const delivered = Buffer.from(r.images![0]!.base64, 'base64');
    const meta = parseImageMeta(delivered);
    expect(meta!.width).toBe(400);
    expect(meta!.height).toBe(300);
  });

  it('region 超出图片范围 → 明确报错', async () => {
    writePng('small.png', await pngBytes(100, 80));
    const r = await executeTool(
      'read_media',
      { path: 'small.png', region: { x: 90, y: 0, width: 50, height: 50 } },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('超出图片范围');
  });

  it('full_resolution 超字节预算 → 明确报错并建议 region', async () => {
    // 噪声 PNG 压缩不动，1600×1200 约 7MB，必然超 4MB 预算
    const bytes = await noisePngBytes(1600, 1200);
    expect(bytes.length).toBeGreaterThan(READ_MEDIA_IMAGE_BYTE_BUDGET);
    writePng('noise.png', bytes);

    const r = await executeTool('read_media', { path: 'noise.png', full_resolution: true }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('full_resolution');
    expect(r.content).toContain('region');
  });

  it('capabilities 显式声明不含 image_in → 能力门控报错', async () => {
    writePng('small.png', await pngBytes(100, 80));
    const r = await executeTool('read_media', { path: 'small.png' }, { cwd: dir, capabilities: ['thinking'] });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('image_in');
    expect(r.content).toContain('/model');
  });

  it('capabilities 为 undefined → 不拒绝，正常构造 images（由 degrader 兜底）', async () => {
    const bytes = await pngBytes(100, 80);
    writePng('small.png', bytes);
    // ctx 无 capabilities 字段（undefined）：工具应正常返回 images，不报错。
    const r = await executeTool('read_media', { path: 'small.png' }, { cwd: dir });
    expect(r.isError).toBe(false);
    expect(r.images).toHaveLength(1);
    expect(r.images![0]!.mediaType).toBe('image/png');
  });

  it('非图片文件 → 报错', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello world');
    const r = await executeTool('read_media', { path: 'a.txt' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('不是可识别的图片文件');
  });

  it('jimp 解码失败（截断 PNG）→ 报错并保留原始错误信息', async () => {
    // 头部含合法 PNG 签名 + IHDR（parseImageMeta 认得出），但数据截断，jimp 解码必失败
    const bytes = await pngBytes(3000, 2000);
    writePng('truncated.png', bytes.subarray(0, 64));
    // 用 region 迫使走解码路径（直通路径不解码）
    const r = await executeTool(
      'read_media',
      { path: 'truncated.png', region: { x: 0, y: 0, width: 100, height: 100 } },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('图片解码失败');
  });

  it('视频文件（MP4 魔数）→ 明说 v1 不支持', async () => {
    const mp4 = Buffer.alloc(32);
    mp4.write('ftyp', 4, 'ascii');
    writeFileSync(join(dir, 'v.mp4'), mp4);
    const r = await executeTool('read_media', { path: 'v.mp4' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('视频');
    expect(r.content).toContain('暂不支持');
  });
});
