/**
 * 采集构建标识（commit / 构建时间 / 工作区是否有未提交改动），供两条消费路径使用：
 *
 * 1. tsc 产物：写一份 `dist/build-info.json`，运行时由 src/buildInfo.ts 读取（sidecar 方式）。
 * 2. 单文件产物：build-bundle.mjs 导入本模块，把同一份数据用 esbuild define 注入常量——
 *    SEA 可执行文件内部读不到外部文件，只能在打包时固化进去。
 *
 * 为什么需要它：package.json 的版本号一个发布周期才动一次，而同一个版本号下会产生无数次构建。
 * 只报 `0.1.0` 无法回答「当前跑的这个二进制是哪次构建、含没含未提交的改动」——本地全局命令软链到
 * 开发目录时尤其致命（别人一 build，你的命令就换了内容，版本号却纹丝不动）。
 *
 * 拿不到 git 信息时不报错：从 tarball 或无 .git 的目录构建是正常场景，此时 commit 记为 unknown。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 跑一条 git 命令，失败一律返回空串（无 .git、git 不在 PATH 等都属正常场景）。 */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** 采集本次构建的标识。时间取 UTC 到秒，避免毫秒噪音。 */
export function collectBuildInfo() {
  const commit = git(['rev-parse', '--short=7', 'HEAD']) || 'unknown';
  // porcelain 非空即有未提交改动：产物里带 +dirty 标记，提醒它不对应任何一个 commit
  const dirty = commit !== 'unknown' && git(['status', '--porcelain']) !== '';
  const time = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { commit, dirty, time };
}

/** 把构建标识写到指定目录的 build-info.json（默认 dist/）。 */
export function writeBuildInfo(outDir = join(root, 'dist')) {
  const info = collectBuildInfo();
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'build-info.json'), `${JSON.stringify(info)}\n`);
  return info;
}

// 直接执行时写 sidecar；被 import 时只提供函数
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const info = writeBuildInfo();
  console.log(`build-info: ${info.commit}${info.dirty ? '+dirty' : ''} ${info.time}`);
}
