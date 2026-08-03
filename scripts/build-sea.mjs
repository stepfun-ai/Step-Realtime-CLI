/**
 * Node SEA 单文件可执行构建：
 *   dist-bundle/step.mjs → sea-config.json → node --experimental-sea-config 生成 blob
 *   → 复制目标平台 node 二进制作载体 → postject 注入 blob → dist-sea/step-code-<target>[.exe]
 * 前置：先跑 npm run build:bundle。产物运行时即载体 node 副本的版本。
 * 参考：Node 官方 Single Executable Applications 流程。
 *
 * 支持的 target：win32-x64、darwin-arm64、linux-x64。
 *
 * 不做交叉编译：载体必须是目标平台的 node 二进制，且 macOS 产物注入后必须用该平台的
 * codesign 重新签名，否则系统直接拒绝执行。因此 target 只能是本机平台，三平台产物由
 * CI 的三个 runner 各自构建（.github/workflows/release.yml）。
 *
 * 注意：ESM 入口的 SEA 需要 Node >= 25.7（nodejs/node#61813 引入，v24.x 未回 port，
 * 见 nodejs/node#62119）。本机 node 低于该版本时，自动下载官方 Node 发行版作为构建与
 * 载体运行时，缓存在 dist-sea/node-runtime/（已 gitignore）。
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { get } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';
import { inject } from 'postject';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'dist-bundle/step.mjs');
const outDir = join(root, 'dist-sea');

/** 兜底构建运行时版本：>= 25.7 才支持 ESM SEA。 */
const FALLBACK_NODE_VERSION = 'v26.5.0';

/**
 * 各 target 的差异集中在此：官方发行版目录名、压缩格式、包内 node 路径、产物后缀。
 * mach-o 需要 postject 的 machoSegmentName，其他平台不传。
 */
const TARGETS = {
  'win32-x64': {
    platform: 'win32',
    arch: 'x64',
    nodeDist: (v) => `node-${v}-win-x64`,
    archive: 'zip',
    nodeBinInDist: 'node.exe',
    exeSuffix: '.exe',
  },
  'darwin-arm64': {
    platform: 'darwin',
    arch: 'arm64',
    nodeDist: (v) => `node-${v}-darwin-arm64`,
    archive: 'tar.gz',
    nodeBinInDist: 'bin/node',
    exeSuffix: '',
    machoSegmentName: 'NODE_SEA',
  },
  'linux-x64': {
    platform: 'linux',
    arch: 'x64',
    nodeDist: (v) => `node-${v}-linux-x64`,
    archive: 'tar.gz',
    nodeBinInDist: 'bin/node',
    exeSuffix: '',
  },
};

/** 解析 target：显式 --target=<name> 优先，否则取本机平台。 */
function resolveTarget() {
  const explicit = process.argv.find((a) => a.startsWith('--target='))?.slice('--target='.length);
  const native = `${process.platform}-${process.arch}`;
  const name = explicit ?? native;
  const spec = TARGETS[name];
  if (!spec) {
    console.error(
      `不支持的 target: ${name}\n  可选: ${Object.keys(TARGETS).join(', ')}\n` +
        '  本机平台不在列表中时，请在对应平台的 runner 上构建。',
    );
    process.exit(1);
  }
  if (spec.platform !== process.platform || spec.arch !== process.arch) {
    console.error(
      `target ${name} 与本机 ${native} 不一致：SEA 不支持交叉编译（载体二进制与签名都必须来自目标平台）。\n` +
        '  三平台产物请交给 CI 的对应 runner 构建。',
    );
    process.exit(1);
  }
  return { name, spec };
}

/** 当前 node 是否支持 ESM 入口的 SEA（>= 25.7）。 */
function supportsEsmSea(version) {
  const [major, minor] = version.split('.').map(Number);
  return major > 25 || (major === 25 && minor >= 7);
}

async function download(url, dest) {
  await new Promise((resolvePromise, rejectPromise) => {
    const req = (u) =>
      get(u, (res) => {
        // 官方发行版偶尔走 302，跟随一次即可
        if (res.statusCode === 301 || res.statusCode === 302) {
          if (!res.headers.location) {
            rejectPromise(new Error(`重定向缺少 location: ${u}`));
            return;
          }
          res.resume();
          req(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          rejectPromise(new Error(`下载失败 HTTP ${res.statusCode}: ${u}`));
          return;
        }
        pipeline(res, createWriteStream(dest)).then(resolvePromise, rejectPromise);
      }).on('error', rejectPromise);
    req(url);
  });
}

/** 解析可用的 SEA 构建/载体 node：本机版本够新就直接用，否则下载官方发行版到项目内缓存。 */
async function resolveSeaNode(spec) {
  if (supportsEsmSea(process.versions.node)) return process.execPath;

  const distName = spec.nodeDist(FALLBACK_NODE_VERSION);
  const runtimeDir = join(outDir, 'node-runtime');
  const nodeBin = join(runtimeDir, distName, spec.nodeBinInDist);
  if (!existsSync(nodeBin)) {
    const archivePath = join(outDir, `${distName}.${spec.archive}`);
    const url = `https://nodejs.org/dist/${FALLBACK_NODE_VERSION}/${distName}.${spec.archive}`;
    console.log(`本机 node ${process.version} 不支持 ESM SEA，下载 ${url} ...`);
    mkdirSync(runtimeDir, { recursive: true });
    await download(url, archivePath);
    if (spec.archive === 'zip') {
      new AdmZip(archivePath).extractAllTo(runtimeDir, true);
    } else {
      // macOS / Linux runner 自带 tar；用系统 tar 免得为一次解压引入依赖
      const untar = spawnSync('tar', ['-xzf', archivePath, '-C', runtimeDir], { stdio: 'inherit' });
      if (untar.status !== 0) {
        console.error(`解压失败: ${archivePath}`);
        process.exit(untar.status ?? 1);
      }
    }
    rmSync(archivePath);
    if (spec.platform !== 'win32') chmodSync(nodeBin, 0o755);
  }
  return nodeBin;
}

/** macOS 的 codesign 调用；ok=false 时给出可诊断的报错。 */
function codesign(args, label) {
  const res = spawnSync('codesign', args, { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`codesign ${label} 失败（mach-o 产物未签名将无法执行）`);
    process.exit(res.status ?? 1);
  }
}

const { name: target, spec } = resolveTarget();
const exeOut = join(outDir, `step-code-${target}${spec.exeSuffix}`);
const blobOut = join(outDir, `sea-prep-${target}.blob`);
const seaMain = join(outDir, `sea-main-${target}.mjs`);
const seaConfigPath = join(outDir, `sea-config-${target}.json`);

if (!existsSync(bundle)) {
  console.error('缺少 dist-bundle/step.mjs，请先执行 npm run build:bundle');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
console.log(`SEA target: ${target}`);

// SEA 入口不需要 shebang（可执行文件直接执行），剥掉避免 ESM 解析报错
writeFileSync(seaMain, readFileSync(bundle, 'utf-8').replace(/^#!.*\n/, ''));

const seaNode = await resolveSeaNode(spec);
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

// 2. 复制 node 二进制作为载体
copyFileSync(seaNode, exeOut);
if (spec.platform !== 'win32') chmodSync(exeOut, 0o755);

// macOS 的载体自带签名，注入前必须先摘掉，否则改动二进制会让签名失效且注入报错
if (spec.platform === 'darwin') codesign(['--remove-signature', exeOut], '摘除载体签名');

// 3. postject 注入 blob。sentinel fuse 以载体内实际值为准：
// 官方文档写作双下划线，但近期 Node 发行版编进去的是单下划线，这里从二进制自动探测。
const exeText = readFileSync(exeOut).toString('latin1');
const fuseMatch = exeText.match(/NODE_SEA_FUSE_+[0-9a-f]{32}/);
if (!fuseMatch) {
  console.error('载体 node 二进制中找不到 SEA sentinel fuse，无法注入');
  process.exit(1);
}
await inject(exeOut, 'NODE_SEA_BLOB', readFileSync(blobOut), {
  sentinelFuse: fuseMatch[0],
  ...(spec.machoSegmentName ? { machoSegmentName: spec.machoSegmentName } : {}),
});

// macOS 注入后必须重新签名（ad-hoc 即可），否则 Gatekeeper 直接拒绝执行
if (spec.platform === 'darwin') codesign(['--sign', '-', exeOut], '重新签名');
if (spec.platform !== 'win32') chmodSync(exeOut, 0o755);

// 4. 生成 sha256 校验文件。放在脚本里而不是 workflow 里：三个平台的命令行工具各不相同
// （certutil / shasum / sha256sum），输出格式也不一致，用 node 算一次保证三端格式相同。
const digest = createHash('sha256').update(readFileSync(exeOut)).digest('hex');
const shaFile = `${exeOut}.sha256`;
writeFileSync(shaFile, `${digest}  step-code-${target}${spec.exeSuffix}\n`);

console.log(`SEA 构建完成: ${exeOut}`);
console.log(`sha256: ${digest}`);
