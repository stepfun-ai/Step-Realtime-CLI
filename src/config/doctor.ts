/**
 * 无头（脱离 Ink/TTY）的 `step doctor config <path>` 子命令逻辑。
 *
 * 用途：配置文件覆盖写入前的独立校验（内置 update-config skill 变更协议的第 4 步），
 * 以及用户自查。只读，不改任何文件；退出码 0 = 通过（可有警告），非 0 = 失败。
 *
 * 与 loadConfig 的关系：两者共用 diagnostics.ts 的同一份警告规则，差别只在入口与时机——
 * 本模块对**指定路径**做校验（可在覆盖写入前先验一份草稿），loadConfig 只读固定路径且
 * 在启动时自检。语义校验复用 config.ts 导出的校验件：resolveThinkingConfig /
 * resolvePermissionMode / resolveProxy 是 loadConfig 会抛配置错误的环节，原样复用其报错；
 * 其余 resolver 对非法值静默跳过/钳制，统一降级为警告（未知顶层键、非法渠道 type、
 * 别名引用不可用渠道、hooks 非法 event 等），不改变既有加载行为。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { resolvePermissionMode, resolveProxy, resolveThinkingConfig } from './config.js';
import { collectConfigWarnings, formatWarningZh } from './diagnostics.js';

/**
 * 顶层键清单的事实源已移到 diagnostics.ts（与启动自检共用同一份规则）。
 * 此处 re-export 保持既有导入路径可用（tests/skill/updateConfigDrift.test.ts 从本模块导入）。
 */
export { CONFIG_TOP_LEVEL_KEYS } from './diagnostics.js';

export interface DoctorConfigResult {
  /** 进程退出码：0 通过（可有警告），1 失败。 */
  code: 0 | 1;
  /** 通过/警告信息（含结尾换行），供调用点写 stdout。 */
  stdout?: string;
  /** 失败原因（含结尾换行），供调用点写 stderr。 */
  stderr?: string;
}

/** max_tokens 缺省基准（= config.ts 的 DEFAULT_MAX_TOKENS，未导出，此处保持一致）。 */
const DEFAULT_MAX_TOKENS = 65536;

/**
 * 校验一份 config.toml：语法错误 / thinking 语义错误 → code 1；
 * 未知顶层键、非法渠道 type、hooks 非法 event 等 → 警告（code 0，逐条列出）。
 * @param path 要校验的文件路径；缺省为 ~/.step-code/config.toml
 */
export function runDoctorConfig(path?: string): DoctorConfigResult {
  const target = path ?? join(homedir(), '.step-code', 'config.toml');
  if (!existsSync(target)) {
    return { code: 1, stderr: `error: 配置文件不存在：${target}\n` };
  }
  let toml: unknown;
  try {
    toml = parseToml(readFileSync(target, 'utf8'));
  } catch (e) {
    return { code: 1, stderr: `error: TOML 解析失败：${(e as Error).message}\n` };
  }
  if (typeof toml !== 'object' || toml === null || Array.isArray(toml)) {
    return { code: 1, stderr: `error: 配置文件顶层必须是 TOML 表：${target}\n` };
  }
  const t = toml as Record<string, unknown>;

  // thinking 语义校验：复用 loadConfig 的抛错路径（budget 余量、default_level 命中）
  try {
    const maxTokens =
      typeof t['max_tokens'] === 'number' && Number.isFinite(t['max_tokens'])
        ? (t['max_tokens'] as number)
        : DEFAULT_MAX_TOKENS;
    resolveThinkingConfig(t['thinking'], maxTokens);
    // permission_mode 非法值同属 loadConfig 抛错路径（安全相关配置，不降级为警告）
    resolvePermissionMode(t['permission_mode']);
    // proxy 形态非法同属 loadConfig 抛错路径
    resolveProxy(t['proxy']);
  } catch (e) {
    return { code: 1, stderr: `error: ${(e as Error).message}\n` };
  }

  // 警告级问题（loadConfig 静默跳过/降级的项）走与启动自检共用的规则表
  const lines = [`ok: ${target} 解析与校验通过`];
  for (const w of collectConfigWarnings(t)) lines.push(`warn: ${formatWarningZh(w)}`);
  return { code: 0, stdout: `${lines.join('\n')}\n` };
}
