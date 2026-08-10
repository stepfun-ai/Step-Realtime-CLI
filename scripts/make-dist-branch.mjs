/**
 * 生成 dist-npm 分发分支的内容（默认输出到 dist-branch/）。
 *
 * 用途：让用户能用 `npm i -g github:<owner>/<repo>#dist-npm` 直接装，且**不在用户机器上做
 * 任何构建**。npm 从 git 源安装时只有声明了 prepare 才会装 devDependencies 并编译；分发
 * 分支的 package.json 刻意不带任何 scripts，于是 npm 只做「解包 + 链接 bin」两件事。
 *
 * 分支内容只有四样：单文件产物 step.mjs、精简 package.json、许可文件、一份说明 README。
 * bin 指向 esbuild 打出的零依赖单文件，因此 dependencies 为空——用户装的时候不会拉任何
 * 依赖，这也是它比源码安装快一个数量级的原因。
 *
 * 前置：先跑 npm run build:bundle（需要 dist-bundle/step.mjs）。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'dist-bundle/step.mjs');
const outArg = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
const outDir = outArg ? join(root, outArg) : join(root, 'dist-branch');

if (!existsSync(bundle)) {
  console.error('缺少 dist-bundle/step.mjs，请先执行 npm run build:bundle');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1. 单文件产物。首行 shebang 由 esbuild 保留，npm 链接 bin 时会自动补执行权限。
copyFileSync(bundle, join(outDir, 'step.mjs'));

// 2. 精简 package.json：无 scripts（安装时零钩子）、无 devDependencies、dependencies 为空。
const distPkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  type: 'module',
  bin: { step: 'step.mjs' },
  files: ['step.mjs', 'licenses', 'LICENSE'],
  engines: pkg.engines,
  repository: pkg.repository,
  homepage: pkg.homepage,
  bugs: pkg.bugs,
  keywords: pkg.keywords,
  author: pkg.author,
  license: pkg.license,
};
writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(distPkg, null, 2)}\n`);

// 3. 许可文件跟着产物走（单文件里打进了第三方依赖代码）
if (existsSync(join(root, 'LICENSE'))) copyFileSync(join(root, 'LICENSE'), join(outDir, 'LICENSE'));
if (existsSync(join(root, 'licenses'))) cpSync(join(root, 'licenses'), join(outDir, 'licenses'), { recursive: true });

// 4. 分支说明：这个分支会出现在仓库分支列表里，进来的人得知道它不是开发分支
writeFileSync(
  join(outDir, 'README.md'),
  `# step-code · 预构建分发分支

本分支由 CI 在发布时自动生成，**内容会被整体覆盖，请勿在此分支提交代码**。
源码与开发请回主分支。

## 安装

\`\`\`bash
npm i -g github:${pkg.repository.url.replace(/^git\+https:\/\/github\.com\//, '').replace(/\.git$/, '')}#dist-npm
step --version
\`\`\`

装的是 \`step.mjs\`（打包好的单文件，零运行时依赖），不会在你机器上编译，也不会拉依赖。
需要 Node \`${pkg.engines?.node ?? '>=22'}\`。

当前版本：\`${pkg.version}\`
`,
);

console.log(`分发分支内容已生成: ${outDir}`);
console.log(`  step.mjs / package.json（v${pkg.version}, 0 dependencies）/ LICENSE / licenses/ / README.md`);
