/**
 * esbuild 单文件 bundle：把 tsc 产物 dist/main.js 打成零依赖单文件 ESM dist-bundle/step.mjs。
 * 用途：SEA exe 的前置输入，也顺带提供「单文件直接 node 跑」的分发形态。
 * 前置：先跑 `npm run build`（build:bundle 脚本已串联）。项目零原生模块，除
 * react-devtools-core 打空桩外（详见下方注释）不设 external、全量打包。
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [join(root, 'dist/main.js')],
  outfile: join(root, 'dist-bundle/step.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // dist/main.js 首行 shebang 会被 esbuild 原样保留（置于 banner 之前），banner 不重复加。
  // CJS 依赖（如 signal-exit）里的 require() 在 ESM 产物中会命中 esbuild 的 __require 兜底而抛
  // "Dynamic require is not supported"；用 banner 注入 createRequire 后 __require 走真实 CJS 解析。
  banner: {
    js: "import { createRequire as __bannerCreateRequire } from 'node:module'; const require = __bannerCreateRequire(import.meta.url);",
  },
  // react-devtools-core 是 ink 的可选 devtools 依赖（本仓库未安装）：
  // ink 的 devtools.js 里有对它的静态 import，直接 external 会让单文件 ESM 在启动时 eagerly 求值而崩溃。
  // ink 仅在 DEV=true 且 import.meta.resolve 成功时才动态 import devtools.js，
  // 因此把该模块打成空桩即可，正常渲染路径不会走到。
  plugins: [
    {
      name: 'stub-react-devtools-core',
      setup(b) {
        b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default {}' }));
      },
    },
  ],
  logLevel: 'info',
});

console.log('bundle 完成: dist-bundle/step.mjs');
