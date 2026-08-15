import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseImageMeta } from '../tools/imageMeta.js';

export interface ClipboardImage {
  mediaType: string;
  base64: string;
  width: number;
  height: number;
}

const READ_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 1_500;

// ── Windows：一次 PowerShell 调用，多路径尝试 ──────────────────
// 顺序：WinForms GetImage（CF_DIB/BITMAP）→ "PNG" 格式（浏览器/QQ 常放）
// → FileDrop 里的图片文件（微信聊天图「复制」等入口只给文件不给位图）
// → 都失败时输出剪贴板实际格式清单，让 UI 能给出诊断而非一句「没有图片」。
const WIN_PS = [
  'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
  '$d=[System.Windows.Forms.Clipboard]::GetDataObject();',
  'if($d -eq $null){"FMT:<empty>";exit}',
  '$img=[System.Windows.Forms.Clipboard]::GetImage();',
  'if($img){$ms=New-Object System.IO.MemoryStream;',
  '$img.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png);',
  '"IMG:"+[Convert]::ToBase64String($ms.ToArray());exit}',
  'if($d.GetDataPresent("PNG")){$s=$d.GetData("PNG");',
  '$ms=New-Object System.IO.MemoryStream;$s.CopyTo($ms);',
  '"IMG:"+[Convert]::ToBase64String($ms.ToArray());exit}',
  '$files=$d.GetData("FileDrop");',
  'if($files){foreach($f in $files){',
  'if($f -match "\\.(?i:png|jpe?g|gif|bmp|webp)$"){',
  '"IMG:"+[Convert]::ToBase64String([System.IO.File]::ReadAllBytes($f));exit}}}',
  '"FMT:"+($d.GetFormats() -join ",")',
].join('');

/** Windows 读取结果：图片字节 / 剪贴板格式清单（诊断用）/ null（进程级失败）。 */
export type WinRead = { kind: 'img'; bytes: Buffer } | { kind: 'fmt'; formats: string } | null;

/** 解析 Windows PowerShell 输出（纯函数，导出供单测直测）。 */
export function parseWinOutput(raw: string): WinRead {
  const out = raw.trim();
  if (out.startsWith('IMG:')) {
    const b64 = out.slice(4).replace(/\s+/g, '');
    if (b64.length === 0) return null;
    try {
      return { kind: 'img', bytes: Buffer.from(b64, 'base64') };
    } catch {
      return null;
    }
  }
  if (out.startsWith('FMT:')) {
    return { kind: 'fmt', formats: out.slice(4).trim() };
  }
  return null;
}

function readWindows(): Promise<WinRead> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', WIN_PS], {
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, READ_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || out.trim().length === 0) {
        resolve(null);
        return;
      }
      resolve(parseWinOutput(out));
    });
  });
}

// ── macOS：osascript 把剪贴板 PNG 写到临时文件再读回 ──────────
// 直接从剪贴板取 «class PNGf» 数据存文件，避免二进制走 stdout 的编码问题。
function readMacOs(): Promise<Buffer | null> {
  const tmp = join(tmpdir(), `step-clip-${randomUUID()}.png`);
  const script = [
    `set thePath to "${tmp}"`,
    'try',
    '  set pngData to the clipboard as «class PNGf»',
    'on error',
    '  return "no-image"',
    'end try',
    'set fp to open for access POSIX file thePath with write permission',
    'set eof fp to 0',
    'write pngData to fp',
    'close access fp',
    'return "ok"',
  ].join('\n');

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('osascript', ['-e', script], {});
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, READ_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (out.trim() !== 'ok') {
        resolve(null);
        return;
      }
      try {
        const bytes = readFileSync(tmp);
        resolve(bytes.length > 0 ? bytes : null);
      } catch {
        resolve(null);
      } finally {
        try {
          unlinkSync(tmp);
        } catch {
          // ignore
        }
      }
    });
  });
}

// ── Linux：Wayland 用 wl-paste，X11 用 xclip ────────────────
const IMG_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function isWayland(): boolean {
  return Boolean(process.env['WAYLAND_DISPLAY']) || process.env['XDG_SESSION_TYPE'] === 'wayland';
}

function readLinuxWlPaste(): Promise<Buffer | null> {
  return new Promise((resolve) => {
    // 先列出剪贴板类型，选一个受支持的图片 MIME
    let types: string;
    try {
      const r = spawnSync('wl-paste', ['--list-types'], { timeout: PROBE_TIMEOUT_MS });
      if (r.status !== 0) {
        resolve(null);
        return;
      }
      types = (r.stdout ?? Buffer.alloc(0)).toString();
    } catch {
      resolve(null);
      return;
    }
    const available = types.split(/\r?\n/).map((t) => t.trim());
    const mime = IMG_TYPES.find((m) => available.includes(m));
    if (mime === undefined) {
      resolve(null);
      return;
    }
    const child = spawn('wl-paste', ['--type', mime, '--no-newline']);
    collectBinary(child, resolve);
  });
}

function readLinuxXclip(): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let targets: string[] = [];
    try {
      const r = spawnSync('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], {
        timeout: PROBE_TIMEOUT_MS,
      });
      if (r.status === 0) {
        targets = (r.stdout ?? Buffer.alloc(0)).toString().split(/\r?\n/).map((t) => t.trim());
      }
    } catch {
      resolve(null);
      return;
    }
    const preferred = IMG_TYPES.find((m) => targets.includes(m));
    const tryTypes = preferred !== undefined ? [preferred, ...IMG_TYPES] : IMG_TYPES;
    // 依次尝试各图片类型，第一个非空即用
    const attempt = (idx: number): void => {
      if (idx >= tryTypes.length) {
        resolve(null);
        return;
      }
      const child = spawn('xclip', ['-selection', 'clipboard', '-t', tryTypes[idx]!, '-o']);
      collectBinary(child, (buf) => {
        if (buf !== null && buf.length > 0) resolve(buf);
        else attempt(idx + 1);
      });
    };
    attempt(0);
  });
}

/** 把子进程二进制 stdout 收集成 Buffer；出错/超时返回 null。 */
function collectBinary(
  child: ReturnType<typeof spawn>,
  resolve: (buf: Buffer | null) => void,
): void {
  const chunks: Buffer[] = [];
  const timer = setTimeout(() => {
    child.kill();
    resolve(null);
  }, READ_TIMEOUT_MS);
  child.stdout?.on('data', (d: Buffer) => chunks.push(d));
  child.on('error', () => {
    clearTimeout(timer);
    resolve(null);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code !== 0 || chunks.length === 0) {
      resolve(null);
      return;
    }
    resolve(Buffer.concat(chunks));
  });
}

// ── 工具可用性探测（供友好提示用）──────────────────────────
function commandExists(cmd: string): boolean {
  try {
    // Windows 用 where，其余用 which；给短超时避免卡顿
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(probe, [cmd], { timeout: PROBE_TIMEOUT_MS });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * 当剪贴板读图失败时，判断是否因为缺少平台命令行工具，返回一条安装提示；
 * 工具齐全（只是没图片）时返回 null。供 UI 在拿到 null 后决定提示语。
 */
export function clipboardToolHint(): string | null {
  if (process.platform === 'win32') return null; // PowerShell 系统自带
  if (process.platform === 'darwin') {
    // osascript 系统自带，理论上不会缺；缺了也没别的可装
    return commandExists('osascript') ? null : '未找到 osascript（应为 macOS 自带）。';
  }
  if (process.platform === 'linux') {
    if (isWayland()) {
      return commandExists('wl-paste')
        ? null
        : '图片粘贴需要 wl-clipboard（提供 wl-paste）。请安装：sudo apt install wl-clipboard（或对应包管理器）。';
    }
    return commandExists('xclip')
      ? null
      : '图片粘贴需要 xclip。请安装：sudo apt install xclip（或对应包管理器）。';
  }
  return null;
}

/**
 * 剪贴板读取结果。image 为 null 时，formats 给出剪贴板实际格式清单（诊断用，
 * 仅 Windows 路径能提供）；formats 也为 null 表示连格式枚举都失败（进程级失败）。
 */
export interface ClipboardReadResult {
  image: ClipboardImage | null;
  formats: string | null;
}

/**
 * 从系统剪贴板异步读取图片。无图片、格式不支持、或缺少平台工具时 image 为 null
 * （缺工具的提示通过 clipboardToolHint 获取；Windows 失败时 formats 带格式清单）。
 * 异步执行以免阻塞 Ink 渲染循环。
 *
 * 平台支持：
 * - Windows：PowerShell（系统自带），依次尝试 WinForms GetImage（CF_DIB/BITMAP）、
 *   "PNG" 格式、FileDrop 里的图片文件；全部失败返回剪贴板格式清单供诊断
 * - macOS：osascript（系统自带）导出剪贴板 PNG
 * - Linux Wayland：wl-paste（需 wl-clipboard）
 * - Linux X11：xclip（需 xclip）
 * 宽高统一由纯 JS 解析图片头得到，不依赖外部命令或原生模块。
 */
export async function readClipboardImage(): Promise<ClipboardReadResult> {
  let bytes: Buffer | null = null;
  let formats: string | null = null;
  if (process.platform === 'win32') {
    const r = await readWindows();
    if (r === null) return { image: null, formats: null };
    if (r.kind === 'fmt') return { image: null, formats: r.formats };
    bytes = r.bytes;
  } else if (process.platform === 'darwin') {
    bytes = await readMacOs();
  } else if (process.platform === 'linux') {
    bytes = isWayland() ? await readLinuxWlPaste() : await readLinuxXclip();
  } else {
    return { image: null, formats: null };
  }

  if (bytes === null || bytes.length === 0) return { image: null, formats };

  const meta = parseImageMeta(bytes);
  if (meta === null) return { image: null, formats }; // 不是受支持的图片格式

  return {
    image: {
      mediaType: meta.mime,
      base64: bytes.toString('base64'),
      width: meta.width,
      height: meta.height,
    },
    formats: null,
  };
}
