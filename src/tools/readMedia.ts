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
/**
 * 交付给模型的视频字节预算（原始字节）：超出直接拒绝。
 * 32MB：覆盖常见社媒视频与录屏片段；视频只能 inline base64（v1 无文件上传通道），
 * base64 膨胀 1.33 倍后请求体约 43MB，是愿意承担的上限。可按别名 video_budget_bytes 放大。
 */
export const READ_MEDIA_VIDEO_BYTE_BUDGET = 32 * 1024 * 1024;

const schema = z.object({
  path: z.string().describe('要读取的图片或视频文件路径，相对当前工作目录或绝对路径。'),
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
  probe: z
    .boolean()
    .optional()
    .describe('true = 只探测元数据（格式/尺寸/字节数/建议分块），不交付图片。用于分块读大图前获取精确尺寸，避免盲目猜 region。'),
});

type Input = z.infer<typeof schema>;

/** 视频/音频魔数嗅探：视频走 video_in 门控的交付路径，音频仍明说 v1 不支持（区别于「不是图片」的笼统报错）。 */
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

/**
 * 视频容器的 media_type 判定：ftyp major brand 'qt  ' → quicktime，其余 ISO-BMFF → mp4；
 * EBML 头（sniffMediaKind 已确认是视频）→ webm。brand 误判的风险由端点容错与降级链兜底。
 */
function sniffVideoMediaType(buf: Buffer): string {
  if (buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    return buf.subarray(8, 12).toString('ascii') === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  return 'video/webm';
}

/** jimp 可重新编码的目标格式：jpeg→jpeg，其余（png/gif/bmp/tiff）→png。webp jimp 不支持，调用方已拦。 */
function encodeMimeFor(meta: ImageMeta): 'image/jpeg' | 'image/png' {
  return meta.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
}

/**
 * 分类懒加载解码依赖的报错：依赖缺失（环境故障，如改名/装包时 node_modules 受损）与
 * 图片真正损坏要分开报。否则模型会把「解析不到 jimp」误判成文件坏、对同一张图反复重试。
 */
export function classifyJimpError(msg: string): string {
  if (/cannot find package|cannot find module|err_module_not_found/i.test(msg)) {
    return `图像解码依赖（jimp）缺失：${msg}。这是环境问题而非图片损坏，请在所用 step 变体目录执行 pnpm install 修复。`;
  }
  return `图片解码失败（文件损坏或格式不支持）：${msg}`;
}

/** 组装 <system> 旁注：格式/原始字节/原始宽高/交付方式 + 两条固定提醒。 */
function buildNote(meta: ImageMeta, rawBytes: number, delivery: string): string {
  return (
    `<system>已读取图片：${meta.mime}，原始 ${rawBytes} 字节，原始尺寸 ${meta.width}×${meta.height}。${delivery}` +
    '坐标请按原始尺寸换算，不要量显示副本。生成或编辑图片后应重新调用本工具读取结果。</system>'
  );
}

/**
 * 组装 probe 旁注：元数据 + 建议分块方案。
 *
 * 建议分块的口径：按交付预算反推每个 region 的最大边长，让单次 region 读取
 * 既不超字节预算也不触发降采样（文字清晰度最优）。长图（高远大于宽）按高度
 * 方向切，宽图按宽度方向切；短边图直接说「无需分块」。
 *
 * 边界对齐：最后一块用 min(剩余, 块高) 收尾，调用方直接照抄即可不超界——
 * 这是「region 超出图片范围」试错的主要消除手段。
 */
function buildProbeNote(meta: ImageMeta, rawBytes: number, maxEdge: number, byteBudget: number): string {
  const { width, height, mime } = meta;
  const longEdge = Math.max(width, height);
  const base =
    `<system>图片元数据：${mime}，原始 ${rawBytes} 字节，原始尺寸 ${width}×${height}。`;

  // 短边图（长边 ≤ 交付上限）：无需分块
  if (longEdge <= maxEdge && rawBytes <= byteBudget) {
    return base + '尺寸与字节均在交付预算内，无需分块，直接读取即可。</system>';
  }

  // 建议块高：按交付长边上限切（每块长边不超上限，降采样后文字仍清晰）
  const isTall = height > width;
  const chunkSpan = maxEdge;
  const count = Math.ceil((isTall ? height : width) / chunkSpan);
  const regions: string[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * chunkSpan;
    const span = Math.min(chunkSpan, (isTall ? height : width) - start);
    if (span <= 0) break;
    regions.push(
      isTall
        ? `{x:0,y:${start},width:${width},height:${span}}`
        : `{x:${start},y:0,width:${span},height:${height}}`,
    );
  }
  const axis = isTall ? '高度' : '宽度';
  return (
    base +
    `超出交付预算，建议分 ${count} 块按${axis}方向读取。建议 region（原图坐标，直接可用）：` +
    regions.join('、') +
    '。最后一块已按剩余边界收窄，照抄不会超界。</system>'
  );
}

export const readMediaTool: ToolDef<Input> = {
  name: 'read_media',
  description:
    '读取本地图片或视频文件，把媒体内容回传给模型看。图片支持 png/jpeg/gif/bmp/webp；超预算（>4MB 或长边 >1568px）会自动等比降采样，可用 region 只看原图某个区域。读大图/长图前先用 probe:true 拿精确尺寸与建议分块，避免盲目猜 region 报错。视频（mp4/mov/webm 等）要求当前模型声明 video_in 能力，按原始字节 inline 交付，默认预算 32MB；音频 v1 暂不支持。',
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

    // 交付预算：模型别名可声明 image_max_edge_px / image_budget_bytes 按渠道放宽；
    // 未声明回退全局保守值（1568px / 256KB，主流视觉模型的最小公分母）。
    const maxEdge = ctx.imageMaxEdgePx ?? READ_MEDIA_MAX_EDGE_PX;
    const byteBudget = ctx.imageBudgetBytes ?? READ_MEDIA_IMAGE_BYTE_BUDGET;

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
        // 能力门控（与 image_in 同一口径）：显式声明了 capabilities 且不含 video_in 才拒绝；
        // capabilities undefined（裸模型/未命中别名）放行，由投影/降级链兜底。
        if (ctx.capabilities !== undefined && !ctx.capabilities.includes('video_in')) {
          return fail(
            `当前模型未声明视频输入能力（capabilities 无 video_in），无法用 read_media 读取视频。` +
              `可 /model 切换到声明了 video_in 的模型，或用 ffmpeg 抽帧后按图片读取。`,
          );
        }
        const videoBudget = ctx.videoBudgetBytes ?? READ_MEDIA_VIDEO_BYTE_BUDGET;
        if (st.size > videoBudget) {
          return fail(
            `视频过大（${st.size} 字节，超过交付预算 ${videoBudget}），无法用 read_media 交付给模型。` +
              `可在别名配置 video_budget_bytes 放大预算，或剪短/抽帧后再读。`,
          );
        }
        const mediaType = sniffVideoMediaType(buf);
        return {
          content: `已读取视频 ${input.path}（${mediaType}，${st.size} 字节，原始字节 inline 交付）。`,
          isError: false,
          videos: [{ mediaType, base64: buf.toString('base64') }],
        };
      }
      if (kind === 'audio') {
        return fail(`这是音频文件，read_media v1 暂不支持读取音频：${input.path}`);
      }
      return fail(`不是可识别的图片文件：${input.path}`);
    }

    // probe 模式：只回元数据，不交付图片。给出建议分块让调用方一次算准 region，
    // 不再靠「猜 region → 报错 → 再猜」的试错循环（30000px 长图场景的真实痛点）。
    if (input.probe === true) {
      return {
        content: buildProbeNote(meta, buf.length, maxEdge, byteBudget),
        isError: false,
      };
    }

    const longEdge = Math.max(meta.width, meta.height);
    const withinBudget = buf.length <= byteBudget && longEdge <= maxEdge;

    // 直通：无裁剪、不超预算 → 原始字节直接交付，不重新编码（webp 也只能走这条，jimp 不支持 webp）
    if (input.region === undefined && (withinBudget || (input.full_resolution === true && buf.length <= byteBudget))) {
      const base64 = buf.toString('base64');
      return {
        content: buildNote(meta, buf.length, '原图未改动交付。'),
        isError: false,
        images: [{ mediaType: meta.mime, base64 }],
      };
    }

    // full_resolution：跳过降采样；超字节预算显式报错并建议 region
    if (input.full_resolution === true && input.region === undefined && buf.length > byteBudget) {
      return fail(
        `图片原始字节 ${buf.length} 超过 ${byteBudget} 预算，full_resolution 下无法交付。` +
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
      return fail(classifyJimpError((e as Error).message));
    }

    let delivery = '';
    if (input.region !== undefined) {
      const r = input.region;
      if (r.x + r.width > meta.width || r.y + r.height > meta.height) {
        // 给出可立即重试的建议 region：起点 clamp 到图内、跨度按剩余收窄。
        // 消除「猜 region → 超界报错 → 再猜」的循环（30000px 长图真实痛点）。
        const x2 = Math.min(r.x, Math.max(0, meta.width - 1));
        const y2 = Math.min(r.y, Math.max(0, meta.height - 1));
        const w2 = Math.min(r.width, meta.width - x2);
        const h2 = Math.min(r.height, meta.height - y2);
        return fail(
          `region 超出图片范围（原图 ${meta.width}×${meta.height}，区域 x=${r.x},y=${r.y},w=${r.width},h=${r.height}）。` +
            `建议改用 region {x:${x2},y:${y2},width:${w2},height:${h2}}（已按边界收窄）。` +
            '或先用 probe:true 拿完整分块方案。',
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
      // 先等比缩到长边不超上限（缺省 1568，别名可声明 image_max_edge_px 放宽），再按双阶梯压进字节预算：
      // JPEG 走质量阶梯 [85,70,55,40]（PNG 无损，质量参数无效，直接进边长回退）；
      // 仍超预算则边长 ×0.8 回退，最多 6 轮。对齐主流视觉 CLI 的阶梯思路。
      let w = image.bitmap.width;
      let h = image.bitmap.height;
      const scale = Math.min(1, maxEdge / Math.max(w, h));
      if (scale < 1) {
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        image.resize({ w, h });
      }
      const QUALITY_LADDER = [85, 70, 55, 40];
      // JPEG 走质量阶梯，PNG 无损直接编码一次；out 在两条分支都必然被赋值。
      let out: Buffer = await encode(mime === 'image/jpeg' ? QUALITY_LADDER[0]! : 85);
      if (mime === 'image/jpeg') {
        for (let i = 1; i < QUALITY_LADDER.length && out.length > byteBudget; i++) {
          out = await encode(QUALITY_LADDER[i]!);
        }
      }
      let shrink = 0;
      while (out.length > byteBudget && shrink < 6) {
        shrink++;
        w = Math.max(1, Math.round(w * 0.8));
        h = Math.max(1, Math.round(h * 0.8));
        image.resize({ w, h });
        out = await encode(mime === 'image/jpeg' ? 40 : 85);
      }
      if (out.length > byteBudget) {
        return fail(
          `多次降采样后仍有 ${out.length} 字节，超过 ${byteBudget} 预算。请用 region 参数分块读取。`,
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
    if (out.length > byteBudget) {
      return fail(
        `裁剪后仍有 ${out.length} 字节，超过 ${byteBudget} 预算，full_resolution 下无法交付。请缩小 region。`,
      );
    }
    return {
      content: buildNote(meta, buf.length, delivery),
      isError: false,
      images: [{ mediaType: mime, base64: out.toString('base64') }],
    };
  },
};
