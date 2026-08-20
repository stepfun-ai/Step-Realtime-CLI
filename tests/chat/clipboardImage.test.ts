import { describe, expect, it } from 'vitest';
import { parseWinOutput, readClipboardImage } from '../../src/chat/clipboardImage.js';

describe('Windows PowerShell 输出解析（parseWinOutput）', () => {
  it('IMG: 前缀 + base64 → 图片字节（输出含换行/空白要剥掉）', () => {
    const r = parseWinOutput('IMG:aGVsbG8=\r\n');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('img');
    if (r!.kind === 'img') expect(r!.bytes.toString()).toBe('hello');
  });
  it('FMT: 前缀 → 格式清单（诊断路径）', () => {
    const r = parseWinOutput('FMT:DeviceIndependentBitmap,WeChatScreenshotFormat\r\n');
    expect(r).toEqual({ kind: 'fmt', formats: 'DeviceIndependentBitmap,WeChatScreenshotFormat' });
  });
  it('空剪贴板标记 → fmt', () => {
    expect(parseWinOutput('FMT:<empty>')).toEqual({ kind: 'fmt', formats: '<empty>' });
  });
  it('无法识别的输出 → null', () => {
    expect(parseWinOutput('')).toBeNull();
    expect(parseWinOutput('some powershell error text')).toBeNull();
    expect(parseWinOutput('IMG:')).toBeNull();
    expect(parseWinOutput('IMG:   \n  ')).toBeNull();
  });
});

describe('clipboardImage Windows 全链路', () => {
  // 当前剪贴板内容不可控，只断言契约：必须 resolve、结构合法、不抛错。
  it.runIf(process.platform === 'win32')('readClipboardImage resolve 且结构合法', async () => {
    const r = await readClipboardImage();
    if (r.image !== null) {
      expect(r.image.base64.length).toBeGreaterThan(0);
      expect(r.image.mediaType).toMatch(/^image\//);
      expect(r.image.width).toBeGreaterThan(0);
      expect(r.image.height).toBeGreaterThan(0);
    } else {
    // 失败时 formats 要么带清单（诊断成功）、要么为 null（进程级失败），不允许 undefined
      expect(r.formats === null || typeof r.formats === 'string').toBe(true);
    }
  }, 15_000);
});
