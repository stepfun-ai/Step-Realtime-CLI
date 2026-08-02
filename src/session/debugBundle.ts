/**
 * 调试导出（export-debug-zip）：把当前会话的落盘产物 + 脱敏后的配置 + 运行日志现场 +
 * 环境自描述 manifest 打成一个 zip，供用户私下发给我们排查 bug。
 *
 * 设计取舍要点：
 * - 打包当前会话的 `<id>.json` + `<id>.full.jsonl`（会话本身就是 bug 复现脚本）。
 * - config.toml / mcp.json 按 key 名确定性脱敏后纳入（provider/model/MCP 列表对排查关键）。
 * - errors.log 取自 logger 的内存环形缓冲 dump。
 * - manifest.json 只放元数据（OS/node/app 版本/model/时间线/文件清单/脱敏标记）。
 * - 附件目录与 input-history 默认不打包（体积 + 隐私）。
 * - 正文脱敏是 best-effort，不保证完全——所以命令回显要提示"请勿公开分享"。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, arch, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { SessionStore } from './store.js';
import { dumpLogBuffer } from '../utils/logger.js';
import { redactByKeyName, redactSecrets } from '../utils/redact.js';

export interface ExportDebugBundleOptions {
  store: SessionStore;
  cwd: string;
  sessionId: string;
  /** 会话模型名，写入 manifest。缺省为 'unknown'。 */
  model?: string;
  /** ~/.step-code 数据根，用于定位 config.toml/mcp.json 与产物落点。测试可覆盖。 */
  dataDir?: string;
}

export interface ExportDebugBundleResult {
  zipPath: string;
  /** 实际打进包的条目名（相对 zip 根）。 */
  files: string[];
  /** 是否对纳入内容做过脱敏。 */
  redacted: boolean;
}

/** 从模块位置向上找 step-code 的 package.json，读真实版本（替代硬编码 '0.1.0'）。 */
function readAppVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const p = join(dir, 'package.json');
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version?: string };
        if (pkg.name === 'step-code' && typeof pkg.version === 'string') return pkg.version;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // 读不到就返回 unknown，不阻塞导出
  }
  return 'unknown';
}

/** 时间戳 YYYYMMDDHHMMSS（本地时间），用于产物命名。 */
function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** 脱敏 config.toml：解析 → 按 key 名 redact → 重新序列化 → 正文再擦一遍。解析失败退回正文擦除。 */
function redactToml(raw: string): string {
  try {
    const obj = parseToml(raw);
    redactByKeyName(obj);
    return redactSecrets(stringifyToml(obj));
  } catch {
    return redactSecrets(raw);
  }
}

/** 脱敏 mcp.json：JSON 解析 → 按 key 名 redact → 序列化 → 正文再擦一遍。解析失败退回正文擦除。 */
function redactJson(raw: string): string {
  try {
    const obj = JSON.parse(raw) as unknown;
    redactByKeyName(obj);
    return redactSecrets(JSON.stringify(obj, null, 2));
  } catch {
    return redactSecrets(raw);
  }
}

/**
 * 生成调试 zip。同步收集 + 打包（一次性操作，adm-zip 同步 API 足够），产物落 dataDir。
 * 返回产物路径、包含的条目清单、脱敏标记。
 */
export async function exportDebugBundle(opts: ExportDebugBundleOptions): Promise<ExportDebugBundleResult> {
  const { store, cwd, sessionId } = opts;
  const dataDir = opts.dataDir ?? join(homedir(), '.step-code');
  const model = opts.model ?? 'unknown';

  const zip = new AdmZip();
  const included: string[] = [];

  // 1) 当前会话落盘产物：快照 + 全量历史。正文做 best-effort 脱敏（不保证完全）。
  const paths = store.sessionPaths(cwd, sessionId);
  if (existsSync(paths.json)) {
    zip.addFile(`session/${sessionId}.json`, Buffer.from(redactSecrets(readFileSync(paths.json, 'utf8')), 'utf8'));
    included.push(`session/${sessionId}.json`);
  }
  if (existsSync(paths.full)) {
    zip.addFile(
      `session/${sessionId}.full.jsonl`,
      Buffer.from(redactSecrets(readFileSync(paths.full, 'utf8')), 'utf8'),
    );
    included.push(`session/${sessionId}.full.jsonl`);
  }
  // 事件日志（wire.jsonl）：会话状态机的事实源，调试复现同样需要
  if (existsSync(paths.wire)) {
    zip.addFile(
      `session/${sessionId}.wire.jsonl`,
      Buffer.from(redactSecrets(readFileSync(paths.wire, 'utf8')), 'utf8'),
    );
    included.push(`session/${sessionId}.wire.jsonl`);
  }

  // 2) 配置文件：按 key 名确定性脱敏后纳入（可能含 api_key）。
  const configPath = join(dataDir, 'config.toml');
  if (existsSync(configPath)) {
    zip.addFile('config.toml', Buffer.from(redactToml(readFileSync(configPath, 'utf8')), 'utf8'));
    included.push('config.toml');
  }
  const mcpPath = join(dataDir, 'mcp.json');
  if (existsSync(mcpPath)) {
    zip.addFile('mcp.json', Buffer.from(redactJson(readFileSync(mcpPath, 'utf8')), 'utf8'));
    included.push('mcp.json');
  }

  // 3) 运行日志现场：环形缓冲 dump（写入时已脱敏）。
  zip.addFile('errors.log', Buffer.from(dumpLogBuffer(), 'utf8'));
  included.push('errors.log');

  // 4) manifest：环境自描述，只放元数据、不放敏感值。
  const now = new Date();
  included.push('manifest.json');
  const manifest = {
    generatedAt: now.toISOString(),
    app: { name: 'step-code', version: readAppVersion() },
    os: { platform: platform(), release: release(), arch: arch() },
    node: process.version,
    model,
    session: { id: sessionId, cwd },
    terminal: { TERM: process.env['TERM'] ?? null, SHELL: process.env['SHELL'] ?? null },
    files: [...included],
    redacted: true,
    redactionNote:
      'config/mcp 按 key 名确定性脱敏；会话正文与日志为 best-effort 正则脱敏，不保证完全。请勿公开分享。',
  };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

  const zipPath = join(dataDir, `debug-${sessionId}-${stamp(now)}.zip`);
  mkdirSync(dataDir, { recursive: true });
  zip.writeZip(zipPath);

  return { zipPath, files: included, redacted: true };
}
