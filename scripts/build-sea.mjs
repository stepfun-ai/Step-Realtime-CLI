/**
 * Node SEA 单文件 exe 构建（win32-x64）：
 *   dist-bundle/step.mjs → sea-config.json → node --experimental-sea-config 生成 blob
 *   → 复制 node.exe → postject 注入 blob → dist-sea/step-code-win32-x64.exe
 * 前置：先跑 npm run build:bundle。产物运行时即载体 node 副本的版本。
 * 参考：Node 官方 Single Executable Applications 流程。
 *
 * 注意：ESM 入口的 SEA 需要 Node >= 25.7（nodejs/node#61813 引入，v24.x 未回 port，
 * 见 nodejs/node#62119）。本机 node 低于该版本时，自动下载官方 Node 25.9.0
 * 作为构建与载体运行时，缓存在 dist-sea/node-runtime/（已 gitignore）。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import AdmZip from 'adm-zip';
import { inject } from 'postject';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'dist-bundle/step.mjs');
const outDir = join(root, 'dist-sea');
const exeOut = join(outDir, 'step-code-win32-x64.exe');
const blobOut = join(outDir, 'sea-prep.blob');
const seaMain = join(outDir, 'sea-main.mjs');
const seaConfigPath = join(outDir, 'sea-config.json');

/** 兜底构建运行时：本仓库缓存的是 v26.5.0（>= 25.7，支持 ESM SEA）。 */
const FALLBACK_NODE_VERSION = 'v26.5.0';

/** 当前 node 是否支持 ESM 入口的 SEA（>= 25.7）。 */
function supportsEsmSea(version) {
  const [major, minor] = version.split('.').map(Number);
  return major > 25 || (major === 25 && minor >= 7);
}

/** 解析可用的 SEA 构建/载体 node.exe：本机版本够新就直接用，否则下载官方发行版到项目内缓存。 */
async function resolveSeaNode() {
  if (supportsEsmSea(process.versions.node)) return process.execPath;
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    console.error(
      `本机 node ${process.version} 不支持 ESM SEA（需 >= 25.7），` +
        `且自动下载仅覆盖 win32-x64；请手动切换 node 版本后重试`,
    );
    process.exit(1);
  }
  const dirName = `node-${FALLBACK_NODE_VERSION}-win-x64`;
  const nodeExe = join(outDir, 'node-runtime', dirName, 'node.exe');
  if (!existsSync(nodeExe)) {
    const zipPath = join(outDir, `${dirName}.zip`);
    const url = `https://nodejs.org/dist/${FALLBACK_NODE_VERSION}/${dirName}.zip`;
    console.log(`本机 node 不支持 ESM SEA，下载 ${url} ...`);
    await new Promise((resolvePromise, rejectPromise) => {
      get(url, (res) => {
        if (res.statusCode !== 200) {
          rejectPromise(new Error(`下载失败 HTTP ${res.statusCode}: ${url}`));
          return;
        }
        pipeline(res, createWriteStream(zipPath)).then(resolvePromise, rejectPromise);
      }).on('error', rejectPromise);
    });
    new AdmZip(zipPath).extractAllTo(join(outDir, 'node-runtime'), true);
    rmSync(zipPath);
  }
  return nodeExe;
}

if (!existsSync(bundle)) {
  console.error('缺少 dist-bundle/step.mjs，请先执行 npm run build:bundle');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

// SEA 入口不需要 shebang（exe 直接执行），剥掉避免 ESM 解析报错
writeFileSync(seaMain, readFileSync(bundle, 'utf-8').replace(/^#!.*\n/, ''));

const seaNode = await resolveSeaNode();
console.log(`SEA 构建运行时: ${seaNode}`);

// 1. 生成 SEA 配置并产出 blob（blob 与载体必须同源，用同一个 node 生成）
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: seaMain,
      output: blobOut,
      // ESM 入口必须显式声明（nodejs/node#61813 引入的 mainFormat 字段）
      mainFormat: 'module',
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false,
    },
    null,
    2,
  ),
);
const gen = spawnSync(seaNode, ['--experimental-sea-config', seaConfigPath], {
  cwd: root,
  stdio: 'inherit',
});
if (gen.status !== 0 || !existsSync(blobOut)) {
  console.error('生成 SEA blob 失败');
  process.exit(gen.status ?? 1);
}

// 2. 复制 node.exe 作为载体
copyFileSync(seaNode, exeOut);

// 3. postject 注入 blob。sentinel fuse 以载体 exe 内实际值为准：
// 官方文档写作双下划线，但近期 Node 发行版编进去的是单下划线，这里从二进制自动探测。
const exeText = readFileSync(exeOut).toString('latin1');
const fuseMatch = exeText.match(/NODE_SEA_FUSE_+[0-9a-f]{32}/);
if (!fuseMatch) {
  console.error('载体 node.exe 中找不到 SEA sentinel fuse，无法注入');
  process.exit(1);
}
await inject(exeOut, 'NODE_SEA_BLOB', readFileSync(blobOut), {
  sentinelFuse: fuseMatch[0],
});

console.log(`SEA 构建完成: ${exeOut}`);
