/**
 * npm 从 git 源安装时的构建钩子（`npm i -g github:<owner>/<repo>#<branch>`）。
 *
 * 为什么必须是 prepare：`dist/` 不入库，而 `bin.step` 指向 `dist/main.js`。npm 处理 git
 * 依赖的顺序是 clone → 安装 devDependencies → 运行 prepare → 按 `files` 打包 → 安装，
 * 只有 prepare 落在「装完 devDependencies、还没打包」这个窗口里。prepack 与
 * prepublishOnly 在这条路径上都不执行——实测只声明 prepack 时，装出来的包里只剩
 * package.json，bin 指向的文件根本不存在。
 *
 * 同一个钩子在本地 `pnpm install` 之后也会触发，所以 dist/main.js 已存在时直接跳过，
 * 免得每次装依赖都全量编译一次。需要强制跳过时设 STEP_CODE_SKIP_PREPARE=1。
 *
 * 直接调用 typescript 自带的 tsc.js 而不是 `npm run build`：这个脚本会在 npm 与 pnpm
 * 两种环境下被调用，绕开包管理器差异最省事。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'dist/main.js');
const tsc = join(root, 'node_modules/typescript/lib/tsc.js');

if (process.env.STEP_CODE_SKIP_PREPARE === '1') {
  console.log('[prepare] STEP_CODE_SKIP_PREPARE=1，跳过构建');
  process.exit(0);
}

if (existsSync(entry)) {
  console.log('[prepare] dist/main.js 已存在，跳过构建');
  process.exit(0);
}

if (!existsSync(tsc)) {
  console.error(
    '[prepare] 找不到 node_modules/typescript/lib/tsc.js，无法构建 dist/。\n' +
      '  从 git 源安装时 npm 应当先装好 devDependencies；若是手工执行本脚本，先跑一次依赖安装。\n' +
      '  只想跳过构建（例如仅取源码阅读）时设 STEP_CODE_SKIP_PREPARE=1。',
  );
  process.exit(1);
}

console.log('[prepare] 构建 dist/ ...');
const res = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], {
  cwd: root,
  stdio: 'inherit',
});
if (res.status !== 0) {
  console.error('[prepare] 构建失败，dist/ 未生成，`step` 命令不可用');
  process.exit(res.status ?? 1);
}

// 构建标识：让装出来的这份产物能自证是哪次构建（从 git 源安装时通常拿不到 commit，会记为 unknown）
const info = spawnSync(process.execPath, [join(root, 'scripts/gen-build-info.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
if (info.status !== 0) console.error('[prepare] 构建标识写入失败，不影响运行，版本号将只报 version');

console.log('[prepare] 构建完成: dist/main.js');
