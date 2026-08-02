/**
 * 从图片字节解析格式与宽高——纯 JS 读文件头，不依赖任何原生模块或外部命令。
 *
 * 支持 PNG / JPEG / GIF / WebP（与剪贴板图片附件支持的格式一致）。
 * 各格式宽高都在文件头的固定/可扫描位置，读头即可，无需解码整图。
 * 无法识别时返回 null。
 */

export interface ImageMeta {
  mime: string;
  width: number;
  height: number;
}

export function parseImageMeta(buf: Uint8Array): ImageMeta | null {
  return parsePng(buf) ?? parseGif(buf) ?? parseWebp(buf) ?? parseJpeg(buf);
}

/** PNG：签名 8 字节 + IHDR，宽高是 IHDR 数据前 8 字节的两个大端 uint32（偏移 16、20）。 */
function parsePng(b: Uint8Array): ImageMeta | null {
  if (b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) return null;
  const width = readU32BE(b, 16);
  const height = readU32BE(b, 20);
  return { mime: 'image/png', width, height };
}

/** GIF：签名 GIF87a/GIF89a，宽高在偏移 6、8 的两个小端 uint16。 */
function parseGif(b: Uint8Array): ImageMeta | null {
  if (b.length < 10) return null;
  if (b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return null; // "GIF"
  const width = b[6]! | (b[7]! << 8);
  const height = b[8]! | (b[9]! << 8);
  return { mime: 'image/gif', width, height };
}

/** WebP：RIFF....WEBP，再分 VP8 / VP8L / VP8X 三种子格式各自的宽高编码。 */
function parseWebp(b: Uint8Array): ImageMeta | null {
  if (b.length < 30) return null;
  if (
    b[0] !== 0x52 || b[1] !== 0x49 || b[2] !== 0x46 || b[3] !== 0x46 || // "RIFF"
    b[8] !== 0x57 || b[9] !== 0x45 || b[10] !== 0x42 || b[11] !== 0x50 // "WEBP"
  ) {
    return null;
  }
  const fourcc = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
  if (fourcc === 'VP8 ') {
    // 有损：宽高在偏移 26、28 的 14 位小端（去掉高 2 位缩放标志）
    const width = (b[26]! | (b[27]! << 8)) & 0x3fff;
    const height = (b[28]! | (b[29]! << 8)) & 0x3fff;
    return { mime: 'image/webp', width, height };
  }
  if (fourcc === 'VP8L') {
    // 无损：偏移 21 起 4 字节里，宽 14 位 + 高 14 位（各减 1 存储）
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { mime: 'image/webp', width, height };
  }
  if (fourcc === 'VP8X') {
    // 扩展：偏移 24 起，宽高各 24 位小端（存储值 = 实际 - 1）
    const width = (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1;
    const height = (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1;
    return { mime: 'image/webp', width, height };
  }
  return null;
}

/** JPEG：扫描 SOF 段（0xFFC0..0xCF，排除非 SOF 的 C4/C8/CC），宽高在段内偏移 5、3 的大端 uint16。 */
function parseJpeg(b: Uint8Array): ImageMeta | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null; // SOI
  let off = 2;
  while (off + 9 < b.length) {
    if (b[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = b[off + 1]!;
    // SOF0..SOF15（0xC0-0xCF），但 C4(DHT)/C8(JPG)/CC(DAC) 不是 SOF
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      const height = readU16BE(b, off + 5);
      const width = readU16BE(b, off + 7);
      return { mime: 'image/jpeg', width, height };
    }
    // 跳过该段：段长在 marker 后 2 字节（大端），含长度本身
    const segLen = readU16BE(b, off + 2);
    if (segLen < 2) return null;
    off += 2 + segLen;
  }
  return null;
}

function readU32BE(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

function readU16BE(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}
