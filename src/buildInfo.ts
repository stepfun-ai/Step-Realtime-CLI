/**
 * 构建标识的运行时读取：让每个产物能自证「是哪次构建」，而不只是报一个发布周期才变一次的版本号。
 *
 * 两条来源，按可靠性排序：
 *
 * 1. `__STEP_BUILD_INFO__`：单文件产物（bundle / SEA 可执行文件）在打包阶段由 esbuild define 固化
 *    进来的 JSON 字面量。SEA 内部读不到外部文件，只能走这条。
 * 2. `build-info.json`：tsc 产物旁边的 sidecar 文件，由 scripts/gen-build-info.mjs 在构建时写入。
 *
 * 两条都没有时返回 null，`versionLine()` 退回只报版本号——从源码目录直接跑（`pnpm dev`）、或从
 * 无 .git 的 tarball 构建都属于这种情况，不是异常。
 *
 * 注意：`VERSION` 本身刻意不掺构建信息。它要进 MCP 客户端声明和 HTTP user-agent，那些是给程序读的
 * 字段，格式必须稳定；构建标识只出现在给人看的两处（`--version` 输出与欢迎框）。
 */
import { readFileSync } from 'node:fs';
import { VERSION } from './version.js';

export interface BuildInfo {
  /** 短 commit 哈希；无 git 信息时为 'unknown' */
  commit: string;
  /** 构建时工作区是否有未提交改动。true 意味着这个产物不对应任何一个 commit */
  dirty: boolean;
  /** 构建时间，UTC ISO 到秒 */
  time: string;
}

// 由 esbuild define 注入；未注入时该标识不存在，靠 typeof 探测（typeof 对未声明标识不抛错）
declare const __STEP_BUILD_INFO__: string | undefined;

function fromDefine(): BuildInfo | null {
  try {
    if (typeof __STEP_BUILD_INFO__ === 'string') return JSON.parse(__STEP_BUILD_INFO__) as BuildInfo;
  } catch {
    // 注入内容坏了就当没有，不能让版本显示把进程搞崩
  }
  return null;
}

function fromSidecar(): BuildInfo | null {
  try {
    return JSON.parse(readFileSync(new URL('./build-info.json', import.meta.url), 'utf-8')) as BuildInfo;
  } catch {
    return null;
  }
}

export const BUILD_INFO: BuildInfo | null = fromDefine() ?? fromSidecar();

/** 拼版本行。单独导出便于测试各分支，调用方用无参的 `versionLine()`。 */
export function formatVersionLine(info: BuildInfo | null): string {
  if (info === null) return VERSION;
  const dirty = info.dirty ? '+dirty' : '';
  return `${VERSION} (${info.commit}${dirty} ${info.time})`;
}

/** `--version` 与欢迎框显示的版本行：有构建标识时附带 commit 与构建时间。 */
export function versionLine(): string {
  return formatVersionLine(BUILD_INFO);
}
