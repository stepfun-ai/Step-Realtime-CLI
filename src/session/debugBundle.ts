/**
 * 调试导出（export-debug-zip）：把当前会话的落盘产物 + 脱敏后的配置 + 运行日志现场 +
 * 环境自描述 manifest 打成一个 zip，供用户私下发给我们排查 bug。
 *
 * 设计取舍：
 * - 打包当前会话的 `<id>.json` + `<id>.wire.jsonl`（会话本身就是 bug 复现脚本）。
 * - config.toml / mcp.json 按 key 名确定性脱敏后纳入（provider/model/MCP 列表对排查关键）。
 * - errors.log 取自 logger 的内存环形缓冲 dump。
 * - manifest.json 只放元数据（OS/node/app 版本/model/时间线/文件清单/脱敏标记）。
 * - 附件目录与 input-history 默认不打包（体积 + 隐私）。
 * - 正文脱敏是 best-effort，不保证完全——所以命令回显要提示"请勿公开分享"。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, arch, platform, release } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { SessionStore } from './store.js';
import { dumpLogBuffer } from '../utils/logger.js';
import { redactByKeyName, redactPaths, redactSecrets, redactWireLineVendor } from '../utils/redact.js';
import { VERSION } from '../version.js';

/**
 * 脱敏级别：
 * - internal：只擦密钥（现有行为，给内部排查用）
 * - vendor：擦密钥 + 路径 + 知识库内容 + AGENTS.md（默认，给外部厂商排查用）
 */
export type RedactLevel = 'internal' | 'vendor';

export interface ExportDebugBundleOptions {
  store: SessionStore;
  cwd: string;
  sessionId: string;
  /** 会话模型名，写入 manifest。缺省为 'unknown'。 */
  model?: string;
  /** ~/.step-code 数据根，用于定位 config.toml/mcp.json 与产物落点。测试可覆盖。 */
  dataDir?: string;
  /** 脱敏级别，缺省 vendor。 */
  level?: RedactLevel;
}

export interface ExportDebugBundleResult {
  zipPath: string;
  /** 实际打进包的条目名（相对 zip 根）。 */
  files: string[];
  /** 是否对纳入内容做过脱敏。 */
  redacted: boolean;
}

/** 版本号取自 src/version.ts 单一来源（曾按 package.json 的 name==='step-code' 匹配，
 *  仓库改名 step-code-pi 后永远落空退回 'unknown'）。 */

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
  const level: RedactLevel = opts.level ?? 'vendor';
  const isVendor = level === 'vendor';

  const zip = new AdmZip();
  const included: string[] = [];

  // 1) 当前会话落盘产物：快照 + 事件日志（wire.jsonl，会话状态机的事实源）。
  // internal 级别：正文 best-effort 脱敏。
  // vendor 级别：wire.jsonl 逐行结构化脱敏（路径 + 知识库内容 + AGENTS.md）。
  const paths = store.sessionPaths(cwd, sessionId);
  if (existsSync(paths.json)) {
    const raw = readFileSync(paths.json, 'utf8');
    const content = isVendor ? redactPaths(redactSecrets(raw)) : redactSecrets(raw);
    zip.addFile(`session/${sessionId}.json`, Buffer.from(content, 'utf8'));
    included.push(`session/${sessionId}.json`);
  }
  if (existsSync(paths.wire)) {
    const raw = readFileSync(paths.wire, 'utf8');
    let content: string;
    if (isVendor) {
      // vendor 级别逐行处理：结构化脱敏（知识库内容 / AGENTS.md / 路径）
      content = raw
        .split('\n')
        .map((line) => (line.trim() ? redactWireLineVendor(line) : line))
        .join('\n');
    } else {
      content = redactSecrets(raw);
    }
    zip.addFile(`session/${sessionId}.wire.jsonl`, Buffer.from(content, 'utf8'));
    included.push(`session/${sessionId}.wire.jsonl`);
  }

  // 2) 配置文件：按 key 名确定性脱敏后纳入（可能含 api_key）。
  // vendor 级别：再跑一轮路径脱敏。
  const configPath = join(dataDir, 'config.toml');
  if (existsSync(configPath)) {
    let content = redactToml(readFileSync(configPath, 'utf8'));
    if (isVendor) content = redactPaths(content);
    zip.addFile('config.toml', Buffer.from(content, 'utf8'));
    included.push('config.toml');
  }
  const mcpPath = join(dataDir, 'mcp.json');
  if (existsSync(mcpPath)) {
    let content = redactJson(readFileSync(mcpPath, 'utf8'));
    if (isVendor) content = redactPaths(content);
    zip.addFile('mcp.json', Buffer.from(content, 'utf8'));
    included.push('mcp.json');
  }

  // 3) 运行日志现场：环形缓冲 dump（写入时已脱敏）。
  // vendor 级别：再跑一轮路径脱敏。
  const logContent = dumpLogBuffer();
  zip.addFile('errors.log', Buffer.from(isVendor ? redactPaths(logContent) : logContent, 'utf8'));
  included.push('errors.log');

  // 4) manifest：环境自描述，只放元数据、不放敏感值。
  const now = new Date();
  included.push('manifest.json');
  const manifest: Record<string, unknown> = {
    generatedAt: now.toISOString(),
    app: { name: 'step-code', version: VERSION },
    os: { platform: platform(), release: release(), arch: arch() },
    node: process.version,
    model,
    session: { id: sessionId, cwd: isVendor ? redactPaths(cwd) : cwd },
    terminal: { TERM: process.env['TERM'] ?? null, SHELL: process.env['SHELL'] ?? null },
    files: [...included],
    redacted: true,
    redactionLevel: level,
    redactionNote: isVendor
      ? 'config/mcp 按 key 名确定性脱敏 + 路径脱敏；wire.jsonl 做结构化脱敏（知识库内容与 AGENTS.md 已擦除）。仍为 best-effort，请勿公开分享。'
      : 'config/mcp 按 key 名确定性脱敏；会话正文与日志为 best-effort 正则脱敏，不保证完全。请勿公开分享。',
  };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

  const zipPath = join(dataDir, `debug-${sessionId}-${stamp(now)}.zip`);
  mkdirSync(dataDir, { recursive: true });
  zip.writeZip(zipPath);

  return { zipPath, files: included, redacted: true };
}
