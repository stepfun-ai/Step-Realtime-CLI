import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { workdirKey } from './store.js';

/** 附件引用哨兵前缀：StoredMessage 里图片 `source.data` 存 `stepref:<sha256>` 而非 base64。 */
export const STEPREF_PREFIX = 'stepref:';

/**
 * offload 阈值：base64 payload 长度 < 此值的小图不落盘、原样内联（省得为几百字节开文件）。
 * ≥ 此值才卸载成内容寻址附件文件。
 */
export const OFFLOAD_THRESHOLD = 4096;

/** 是否为附件引用哨兵串。 */
export function isStepref(data: string): boolean {
  return data.startsWith(STEPREF_PREFIX);
}

/** 从 mediaType 推文件后缀（如 image/png→png）；无从判断时用 bin。 */
function extFor(mediaType: string): string {
  const sub = mediaType.split('/')[1];
  return sub === undefined || sub === '' ? 'bin' : sub;
}

/**
 * 引用式附件存储：图片字节落盘为内容寻址文件，消息里只留 `stepref:<sha256>` 指针。
 *
 * 布局：<baseDir>/<workdirKey>/attachments/<sha256>.<ext>，与 SessionStore 共享 baseDir 与 per-workdir 分桶。
 * 文件名 = 内容 sha256 → 天然去重（同图只存一份，写时撞已存在即跳过）。不建索引/清单文件（会话即索引）。
 */
export class AttachmentStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), '.step-code', 'sessions');
  }

  private dirFor(cwd: string): string {
    return join(this.baseDir, workdirKey(cwd), 'attachments');
  }

  /**
   * 把图片 base64 卸载成附件文件，返回落盘时该图 `source.data` 应存的值：
   * - payload < OFFLOAD_THRESHOLD 的小图：原样返回 base64（内联，不落盘）。
   * - 已是 stepref：原样返回（幂等，不重复卸载）。
   * - 否则：算 sha256 写 attachments/<sha256>.<ext>（撞已存在则跳过，hash 去重），返回 `stepref:<sha256>`。
   */
  offload(cwd: string, base64: string, mediaType: string): string {
    if (isStepref(base64)) return base64;
    if (base64.length < OFFLOAD_THRESHOLD) return base64;
    const hash = createHash('sha256').update(base64).digest('hex');
    const dir = this.dirFor(cwd);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${hash}.${extFor(mediaType)}`);
    if (!existsSync(file)) {
      try {
        writeFileSync(file, Buffer.from(base64, 'base64'), { flag: 'wx' });
      } catch (e) {
        // wx 下并发/竞态导致的 EEXIST 无害（内容寻址，字节一致）；其它错误抛出
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    return `${STEPREF_PREFIX}${hash}`;
  }

  /**
   * 把 `stepref:<sha256>` 还原成 base64：按 hash 在 attachments/ 下找到附件文件（文件名带 ext，按 hash 前缀匹配）。
   * 文件缺失（被删/未落盘/传入非 stepref）返回 null，由调用方填占位。
   */
  rehydrate(cwd: string, stepref: string): string | null {
    if (!isStepref(stepref)) return null;
    const hash = stepref.slice(STEPREF_PREFIX.length);
    if (hash === '') return null;
    const dir = this.dirFor(cwd);
    if (!existsSync(dir)) return null;
    let name: string | undefined;
    try {
      name = readdirSync(dir).find((n) => n === hash || n.startsWith(`${hash}.`));
    } catch {
      return null;
    }
    if (name === undefined) return null;
    try {
      return readFileSync(join(dir, name)).toString('base64');
    } catch {
      return null;
    }
  }
}
