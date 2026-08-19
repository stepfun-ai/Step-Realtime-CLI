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
  classifyJimpError,
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

  it('视频文件（MP4 魔数）→ 能力门控报错（未声明 video_in 时）', async () => {
    const mp4 = Buffer.alloc(32);
    mp4.write('ftyp', 4, 'ascii');
    writeFileSync(join(dir, 'v.mp4'), mp4);
    // 文件级 ctx 声明的是 ['image_in']（无 video_in）→ 明确报能力缺失而非「不是图片」
    const r = await executeTool('read_media', { path: 'v.mp4' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('视频');
    expect(r.content).toContain('video_in');
  });

  it('probe 模式：只回元数据不交付图片，小图建议无需分块', async () => {
    writePng('small.png', await pngBytes(100, 80));
    const r = await executeTool('read_media', { path: 'small.png', probe: true }, ctx);
    expect(r.isError).toBe(false);
    expect(r.images).toBeUndefined(); // 不交付图片
    expect(r.content).toContain('图片元数据');
    expect(r.content).toContain('100×80');
    expect(r.content).toContain('无需分块');
  });

  it(
    'probe 模式：长图给出按高度方向的建议分块，末块按剩余收窄',
    { timeout: 60_000 },
    async () => {
      // 单跑基线 11–15s，并发放大系数约 1.4×（21094ms 实测），再留 4 倍余量到 60s。
      // 全局 20s 是给 16 核并发下 3 倍放大预留的，但这个用例光编码+20 次 region 解码就超基线。
      // 不动全局：全局放宽会把其它测试的死锁假阴性窗口一起放大。见 vitest.config.ts。
      // 508×30173 长图（模拟真实公众号长截图）
      writePng('tall.png', await pngBytes(508, 30173));
    const r = await executeTool('read_media', { path: 'tall.png', probe: true }, ctx);
    expect(r.isError).toBe(false);
    expect(r.images).toBeUndefined();
    expect(r.content).toContain('508×30173');
    expect(r.content).toContain('建议分');
    expect(r.content).toContain('高度方向');
    // 第一块 y=0 height=1568
    expect(r.content).toContain('{x:0,y:0,width:508,height:1568}');
    // 末块：30173 = 19×1568 + 381，最后一块 height 应收窄为 381
    expect(r.content).toContain(`{x:0,y:${19 * 1568},width:508,height:${30173 - 19 * 1568}}`);
    // 验证所有建议 region 照抄不超界（重新调用 read_media 逐个试）
    const count = Math.ceil(30173 / 1568);
    for (let i = 0; i < count; i++) {
      const y = i * 1568;
      const h = Math.min(1568, 30173 - y);
      const rr = await executeTool(
        'read_media',
        { path: 'tall.png', region: { x: 0, y, width: 508, height: h } },
        ctx,
      );
      expect(rr.isError, `建议 region 第 ${i} 块不应超界`).toBe(false);
    }
  });

  it('probe 模式：宽图给出按宽度方向的建议分块', async () => {
    writePng('wide.png', await pngBytes(4000, 800));
    const r = await executeTool('read_media', { path: 'wide.png', probe: true }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('宽度方向');
    expect(r.content).toContain('{x:0,y:0,width:1568,height:800}');
  });

  it('region 超限错误：自动建议 clamp 后的可重试 region', async () => {
    writePng('small.png', await pngBytes(100, 80));
    const r = await executeTool(
      'read_media',
      { path: 'small.png', region: { x: 90, y: 0, width: 50, height: 50 } },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('超出图片范围');
    // 建议 region：x 保持 90（在图内），width 收窄为 100-90=10
    expect(r.content).toContain('建议改用 region {x:90,y:0,width:10,height:50}');
    expect(r.content).toContain('probe:true');
    // 按建议 region 重试应成功
    const r2 = await executeTool(
      'read_media',
      { path: 'small.png', region: { x: 90, y: 0, width: 10, height: 50 } },
      ctx,
    );
    expect(r2.isError).toBe(false);
  });

  it('region 超限（起点已超界）：建议 clamp 起点到图内', async () => {
    writePng('small.png', await pngBytes(100, 80));
    // y=200 远超 height=80
    const r = await executeTool(
      'read_media',
      { path: 'small.png', region: { x: 0, y: 200, width: 50, height: 50 } },
      ctx,
    );
    expect(r.isError).toBe(true);
    // y clamp 到 79，height 收窄为 80-79=1
    expect(r.content).toContain('建议改用 region {x:0,y:79,width:50,height:1}');
  });
});

/** 最小 ISO-BMFF 视频头（size + ftyp + brand），供视频分支测试。 */
function mp4Bytes(total = 4096, brand = 'isom'): Buffer {
  const buf = Buffer.alloc(total);
  buf.writeUInt32BE(24, 0);
  buf.write('ftyp', 4, 'ascii');
  buf.write(brand, 8, 4, 'ascii');
  return buf;
}

describe('read_media · 视频', () => {
  it('声明 video_in → 原始字节 inline 交付，mediaType 嗅探为 video/mp4', async () => {
    const bytes = mp4Bytes();
    writeFileSync(join(dir, 'clip.mp4'), bytes);
    const r = await executeTool('read_media', { path: 'clip.mp4' }, { cwd: dir, capabilities: ['image_in', 'video_in'] });
    expect(r.isError).toBe(false);
    expect(r.videos).toHaveLength(1);
    expect(r.videos![0]!.mediaType).toBe('video/mp4');
    expect(Buffer.from(r.videos![0]!.base64, 'base64').equals(bytes)).toBe(true);
    expect(r.content).toContain('已读取视频');
  });

  it('capabilities 显式声明不含 video_in → 能力门控报错，提示抽帧替代', async () => {
    writeFileSync(join(dir, 'clip.mp4'), mp4Bytes());
    const r = await executeTool('read_media', { path: 'clip.mp4' }, { cwd: dir, capabilities: ['image_in'] });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('video_in');
    expect(r.content).toContain('抽帧');
    expect(r.videos).toBeUndefined();
  });

  it('capabilities 为 undefined → 不拒绝，正常构造 videos（由投影/降级链兜底）', async () => {
    writeFileSync(join(dir, 'clip.mp4'), mp4Bytes());
    const r = await executeTool('read_media', { path: 'clip.mp4' }, { cwd: dir });
    expect(r.isError).toBe(false);
    expect(r.videos).toHaveLength(1);
  });

  it('超出交付预算 → 明确报错（按别名 video_budget_bytes 收窄验证）', async () => {
    writeFileSync(join(dir, 'big.mp4'), mp4Bytes(4096));
    const r = await executeTool(
      'read_media',
      { path: 'big.mp4' },
      { cwd: dir, capabilities: ['image_in', 'video_in'], videoBudgetBytes: 1024 },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('交付预算');
    expect(r.videos).toBeUndefined();
  });

  it("ftyp brand 'qt  ' → mediaType video/quicktime", async () => {
    writeFileSync(join(dir, 'clip.mov'), mp4Bytes(4096, 'qt  '));
    const r = await executeTool('read_media', { path: 'clip.mov' }, { cwd: dir, capabilities: ['image_in', 'video_in'] });
    expect(r.isError).toBe(false);
    expect(r.videos![0]!.mediaType).toBe('video/quicktime');
  });
});

describe('read_media · classifyJimpError 错误分类', () => {
  // 实测坑：2026-08-18 某 step session 读图报 "Cannot find package 'jimp'"，是改名过渡期
  // 旧 node_modules 受损导致懒加载解析不到，并非图片损坏。错误文案必须把两者分开，
  // 否则模型会把环境故障误判成文件坏、对同一张图反复重试。
  it('依赖缺失（解析不到 jimp）→ 明确提示环境问题 + pnpm install，不报成「文件损坏」', () => {
    const msg = classifyJimpError("Cannot find package 'jimp' imported from .../readMedia.js");
    expect(msg).toContain('依赖（jimp）缺失');
    expect(msg).toContain('环境问题');
    expect(msg).toContain('pnpm install');
    expect(msg).not.toContain('文件损坏');
  });

  it('真正的解码失败 → 报成「图片解码失败/文件损坏」', () => {
    const msg = classifyJimpError('Could not find MIME for Buffer <01 02 03>');
    expect(msg).toContain('图片解码失败');
    expect(msg).toContain('文件损坏');
  });

  it('ERR_MODULE_NOT_FOUND 变体也归到依赖缺失', () => {
    expect(classifyJimpError("Cannot find module 'jimp'")).toContain('环境问题');
  });
});
