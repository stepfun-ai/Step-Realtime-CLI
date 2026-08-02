import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentStore, OFFLOAD_THRESHOLD, isStepref, STEPREF_PREFIX } from '../../src/session/attachments.js';
import { workdirKey } from '../../src/session/store.js';

let base: string;
let store: AttachmentStore;
const cwd = 'C:/some/project';

/** 生成长度 ≥ 阈值的规范 base64（可干净往返）。 */
function bigBase64(bytes = 4000): string {
  return Buffer.alloc(bytes, 7).toString('base64');
}

function attachmentsDir(): string {
  return join(base, workdirKey(cwd), 'attachments');
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stepcode-att-'));
  store = new AttachmentStore(base);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('AttachmentStore', () => {
  it('offload → rehydrate 往返一致', () => {
    const b64 = bigBase64();
    expect(b64.length).toBeGreaterThanOrEqual(OFFLOAD_THRESHOLD);
    const ref = store.offload(cwd, b64, 'image/png');
    expect(isStepref(ref)).toBe(true);
    expect(ref.startsWith(STEPREF_PREFIX)).toBe(true);
    expect(store.rehydrate(cwd, ref)).toBe(b64);
  });

  it('文件按 <sha256>.<ext> 命名，ext 由 mediaType 推', () => {
    const ref = store.offload(cwd, bigBase64(), 'image/png');
    const hash = ref.slice(STEPREF_PREFIX.length);
    const names = readdirSync(attachmentsDir());
    expect(names).toEqual([`${hash}.png`]);
  });

  it('hash 去重：同内容多次 offload 只写一份文件、返回同 stepref', () => {
    const b64 = bigBase64();
    const r1 = store.offload(cwd, b64, 'image/png');
    const r2 = store.offload(cwd, b64, 'image/png');
    expect(r1).toBe(r2);
    expect(readdirSync(attachmentsDir())).toHaveLength(1);
  });

  it('阈值：payload < 4KB 的小图不 offload、原样内联、不建文件', () => {
    const small = Buffer.alloc(100, 1).toString('base64');
    expect(small.length).toBeLessThan(OFFLOAD_THRESHOLD);
    const ref = store.offload(cwd, small, 'image/png');
    expect(ref).toBe(small);
    expect(isStepref(ref)).toBe(false);
    expect(existsSync(attachmentsDir())).toBe(false);
  });

  it('已是 stepref 时 offload 幂等返回', () => {
    const ref = store.offload(cwd, bigBase64(), 'image/png');
    expect(store.offload(cwd, ref, 'image/png')).toBe(ref);
  });

  it('缺失文件 rehydrate 返回 null', () => {
    // 从未 offload 过的 hash
    expect(store.rehydrate(cwd, `${STEPREF_PREFIX}${'a'.repeat(64)}`)).toBeNull();
    // offload 后删掉文件
    const ref = store.offload(cwd, bigBase64(), 'image/png');
    rmSync(attachmentsDir(), { recursive: true, force: true });
    expect(store.rehydrate(cwd, ref)).toBeNull();
  });

  it('非 stepref 输入 rehydrate 返回 null', () => {
    expect(store.rehydrate(cwd, 'not-a-ref')).toBeNull();
    expect(store.rehydrate(cwd, STEPREF_PREFIX)).toBeNull();
  });

  it('per-workdir 分桶：不同 cwd 落到不同附件目录', () => {
    const b64 = bigBase64();
    store.offload(cwd, b64, 'image/png');
    store.offload('D:/other', b64, 'image/png');
    expect(readdirSync(join(base, workdirKey(cwd), 'attachments'))).toHaveLength(1);
    expect(readdirSync(join(base, workdirKey('D:/other'), 'attachments'))).toHaveLength(1);
  });
});
