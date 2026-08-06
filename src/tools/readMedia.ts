import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { resolvePath } from './fsutil.js';
import { parseImageMeta, type ImageMeta } from './imageMeta.js';
import { fail, type ToolDef } from './types.js';

/** 读入文件硬上限：超过直接拒绝（不读进内存）。 */
export const READ_MEDIA_MAX_BYTES = 100 * 1024 * 1024;
/**
 * 交付给模型的图片字节预算：超出则需降采样/裁剪后再交付。
 * 256KB：图片是上下文里最贵的块，一张超预算的大图对模型读图精度和 token
 * 成本都不划算（对齐主流视觉 CLI 的交付预算量级）。
 */
export const READ_MEDIA_IMAGE_BYTE_BUDGET = 256 * 1024;
/** 交付图片的长边像素上限：超出则等比降采样（对齐主流视觉模型的推荐输入尺寸）。 */
export const READ_MEDIA_MAX_EDGE_PX = 1568;

const schema = z.object({
  path: z.string().describe('要读取的图片文件路径，相对当前工作目录或绝对路径。'),
  region: z
    .object({
      x: z.number().int().min(0).describe('裁剪区域左上角 x（原图像素坐标）。'),
      y: z.number().int().min(0).describe('裁剪区域左上角 y（原图像素坐标）。'),
      width: z.number().int().min(1).describe('裁剪区域宽度（原图像素）。'),
      height: z.number().int().min(1).describe('裁剪区域高度（原图像素）。'),
    })
    .optional()
    .describe('只看原图的某个矩形区域时给出（原图像素坐标），先裁剪再按预算交付。'),
  full_resolution: z
    .boolean()
    .optional()
    .describe('true = 跳过降采样按原图交付；原始字节超 4MB 时会明确报错，建议改用 region 分块读。'),
});

type Input = z.infer<typeof schema>;

/** 视频/音频魔数嗅探：命中则明说 v1 不支持（区别于「不是图片」的笼统报错）。 */
function sniffMediaKind(buf: Buffer): 'video' | 'audio' | null {
  if (buf.length >= 12) {
    // MP4/MOV 等 ISO-BMFF：偏移 4 起是 ftyp
    if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'video';
    // WebM/MKV：EBML 头 0x1A45DFA3
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video';
    // WAV：RIFF....WAVE
    if (
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WAVE'
    ) {
      return 'audio';
    }
    // Ogg 容器（ogg/oga/opus）
    if (buf.subarray(0, 4).toString('ascii') === 'OggS') return 'audio';
    // FLAC
    if (buf.subarray(0, 4).toString('ascii') === 'fLaC') return 'audio';
  }
  // MP3：ID3 标签或帧同步 0xFFEx
  if (buf.length >= 3 && buf.subarray(0, 3).toString('ascii') === 'ID3') return 'audio';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) return 'audio';
  return null;
}

/** jimp 可重新编码的目标格式：jpeg→jpeg，其余（png/gif/bmp/tiff）→png。webp jimp 不支持，调用方已拦。 */
function encodeMimeFor(meta: ImageMeta): 'image/jpeg' | 'image/png' {
  return meta.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
}

/** 组装 <system> 旁注：格式/原始字节/原始宽高/交付方式 + 两条固定提醒。 */
function buildNote(meta: ImageMeta, rawBytes: number, delivery: string): string {
  return (
    `<system>已读取图片：${meta.mime}，原始 ${rawBytes} 字节，原始尺寸 ${meta.width}×${meta.height}。${delivery}` +
    '坐标请按原始尺寸换算，不要量显示副本。生成或编辑图片后应重新调用本工具读取结果。</system>'
  );
}

export const readMediaTool: ToolDef<Input> = {
  name: 'read_media',
  description:
    '读取本地图片文件，把图片内容回传给模型看。支持 png/jpeg/gif/bmp/webp；超预算（>4MB 或长边 >1568px）会自动等比降采样，可用 region 只看原图某个区域。视频/音频 v1 暂不支持。',
  schema,
  access: (input, ctx) => ({ kind: 'read', path: resolvePath(ctx.cwd, input.path) }),
  async execute(input, ctx) {
    // capabilities 为 undefined 时**不拒绝**：让工具正常构造 images，由 degrader 按
    // 能力表兜底（未声明 image_in 的模型会被剥成占位文本）。比静默拒绝更诚实——
    // 模型至少能看到图片、尝试理解，理解不了时错误会回灌给模型自纠。
    // 只有显式声明了 capabilities 且不含 image_in 时才拒绝。
    if (ctx.capabilities !== undefined && !ctx.capabilities.includes('image_in')) {
      return fail('当前模型不支持图片输入（capabilities 无 image_in），请 /model 切换到支持图片的模型。');
    }

    const abs = resolvePath(ctx.cwd, input.path);
    let st;
    try {
      st = statSync(abs);
    } catch {
      return fail(`文件不存在：${input.path}`);
    }
    if (st.isDirectory()) {
      return fail(`这是一个目录，不是文件：${input.path}。`);
    }
    if (st.size > READ_MEDIA_MAX_BYTES) {
      return fail(
        `文件过大（${st.size} 字节，超过 ${READ_MEDIA_MAX_BYTES} 上限），无法用 read_media 读取。`,
      );
    }

    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch (e) {
      return fail(`读取失败：${(e as Error).message}`);
    }

    const meta = parseImageMeta(buf);
    if (meta === null) {
      const kind = sniffMediaKind(buf);
      if (kind === 'video') {
        return fail(`这是视频文件，read_media v1 暂不支持读取视频：${input.path}`);
      }
      if (kind === 'audio') {
        return fail(`这是音频文件，read_media v1 暂不支持读取音频：${input.path}`);
      }
      return fail(`不是可识别的图片文件：${input.path}`);
    }

    const longEdge = Math.max(meta.width, meta.height);
    const withinBudget = buf.length <= READ_MEDIA_IMAGE_BYTE_BUDGET && longEdge <= READ_MEDIA_MAX_EDGE_PX;

    // 直通：无裁剪、不超预算 → 原始字节直接交付，不重新编码（webp 也只能走这条，jimp 不支持 webp）
    if (input.region === undefined && (withinBudget || (input.full_resolution === true && buf.length <= READ_MEDIA_IMAGE_BYTE_BUDGET))) {
      const base64 = buf.toString('base64');
      return {
        content: buildNote(meta, buf.length, '原图未改动交付。'),
        isError: false,
        images: [{ mediaType: meta.mime, base64 }],
      };
    }

    // full_resolution：跳过降采样；超字节预算显式报错并建议 region
    if (input.full_resolution === true && input.region === undefined && buf.length > READ_MEDIA_IMAGE_BYTE_BUDGET) {
      return fail(
        `图片原始字节 ${buf.length} 超过 ${READ_MEDIA_IMAGE_BYTE_BUDGET} 预算，full_resolution 下无法交付。` +
          '请用 region 参数分块读取原图区域，或去掉 full_resolution 让工具自动降采样。',
      );
    }

    // 需要解码处理（裁剪/降采样）：webp 无法在本工具内重新编码
    if (meta.mime === 'image/webp') {
      return fail(
        `webp 图片需要裁剪或降采样，但本工具不支持重新编码 webp：${input.path}。` +
          '请先用 bash/图像工具把它转成 png 再读。',
      );
    }

    // jimp 懒加载：只有真正需要解码时才付出加载成本
    let image;
    try {
      const { Jimp } = await import('jimp');
      image = await Jimp.read(buf);
    } catch (e) {
      return fail(`图片解码失败（文件损坏或格式不支持）：${(e as Error).message}`);
    }

    let delivery = '';
    if (input.region !== undefined) {
      const r = input.region;
      if (r.x + r.width > meta.width || r.y + r.height > meta.height) {
        return fail(
          `region 超出图片范围（原图 ${meta.width}×${meta.height}，区域 x=${r.x},y=${r.y},w=${r.width},h=${r.height}）。`,
        );
      }
      image.crop({ x: r.x, y: r.y, w: r.width, h: r.height });
      delivery = `已裁剪区域 (x=${r.x},y=${r.y},w=${r.width},h=${r.height}) 交付。`;
    }

    // getBuffer 的 options 类型按 mime 字面量收窄，联合类型下会塌缩成 undefined，故按字面量分支
    const mime = encodeMimeFor(meta);
    const encode = (quality: number): Promise<Buffer> =>
      mime === 'image/jpeg' ? image.getBuffer('image/jpeg', { quality }) : image.getBuffer('image/png');

    if (input.full_resolution !== true) {
      // 先等比缩到长边 ≤1568，再按双阶梯压进字节预算：
      // JPEG 走质量阶梯 [85,70,55,40]（PNG 无损，质量参数无效，直接进边长回退）；
      // 仍超预算则边长 ×0.8 回退，最多 6 轮。对齐主流视觉 CLI 的阶梯思路。
      let w = image.bitmap.width;
      let h = image.bitmap.height;
      const scale = Math.min(1, READ_MEDIA_MAX_EDGE_PX / Math.max(w, h));
      if (scale < 1) {
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        image.resize({ w, h });
      }
      const QUALITY_LADDER = [85, 70, 55, 40];
      // JPEG 走质量阶梯，PNG 无损直接编码一次；out 在两条分支都必然被赋值。
      let out: Buffer = await encode(mime === 'image/jpeg' ? QUALITY_LADDER[0]! : 85);
      if (mime === 'image/jpeg') {
        for (let i = 1; i < QUALITY_LADDER.length && out.length > READ_MEDIA_IMAGE_BYTE_BUDGET; i++) {
          out = await encode(QUALITY_LADDER[i]!);
        }
      }
      let shrink = 0;
      while (out.length > READ_MEDIA_IMAGE_BYTE_BUDGET && shrink < 6) {
        shrink++;
        w = Math.max(1, Math.round(w * 0.8));
        h = Math.max(1, Math.round(h * 0.8));
        image.resize({ w, h });
        out = await encode(mime === 'image/jpeg' ? 40 : 85);
      }
      if (out.length > READ_MEDIA_IMAGE_BYTE_BUDGET) {
        return fail(
          `多次降采样后仍有 ${out.length} 字节，超过 ${READ_MEDIA_IMAGE_BYTE_BUDGET} 预算。请用 region 参数分块读取。`,
        );
      }
      const dw = image.bitmap.width;
      const dh = image.bitmap.height;
      const resized = dw !== (input.region?.width ?? meta.width) || dh !== (input.region?.height ?? meta.height);
      if (input.region !== undefined) {
        delivery = resized
          ? `已裁剪区域 (x=${input.region.x},y=${input.region.y},w=${input.region.width},h=${input.region.height}) 并降采样到 ${dw}×${dh} 交付。`
          : `已裁剪区域 (x=${input.region.x},y=${input.region.y},w=${input.region.width},h=${input.region.height}) 交付。`;
      } else {
        delivery = resized ? `已降采样到 ${dw}×${dh} 交付。` : '原图未改动交付。';
      }
      return {
        content: buildNote(meta, buf.length, delivery),
        isError: false,
        images: [{ mediaType: mime, base64: out.toString('base64') }],
      };
    }

    // full_resolution + region：裁剪后按原格式交付，仍超预算则报错
    const out = await encode(95);
    if (out.length > READ_MEDIA_IMAGE_BYTE_BUDGET) {
      return fail(
        `裁剪后仍有 ${out.length} 字节，超过 ${READ_MEDIA_IMAGE_BYTE_BUDGET} 预算，full_resolution 下无法交付。请缩小 region。`,
      );
    }
    return {
      content: buildNote(meta, buf.length, delivery),
      isError: false,
      images: [{ mediaType: mime, base64: out.toString('base64') }],
    };
  },
};
