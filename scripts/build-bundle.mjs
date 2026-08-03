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
  // 纵深防御（不替代 dist/main.js 的运行时引导）：react 与 react-reconciler 的 CJS 入口按
  // process.env.NODE_ENV 分流成 production / development 两套构建，两者错配时 reconciler 调度
  // 静默失效（render() 返回、根组件不被调用、零输出、无异常——2026-08-03 实测的空白屏事故）。
  // bundle 场景把该表达式静态折叠成 "production"，两个包的分流在打包期即被定死，运行时 env
  // 再怎么变都不可能错配。
  //
  // 为什么这不能替代运行时引导：define 只在「经过 esbuild」这条路径上生效，而 tsc 直出的
  // dist/（默认分发形态）与 tsx 直跑的开发模式都不经打包器。三种形态里它只覆盖一种，
  // 因此定位是加固而非防线。
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  // 静音 assign-to-define：唯一预期来源是 dist/main.js 那行
  // `process.env.NODE_ENV ??= 'production'`（运行时引导，服务 tsc 直出与 tsx 直跑两条
  // 不经打包器的路径）。esbuild 看到「被 define 的表达式出现在赋值左侧」即报警，但这里
  // 两者是分工而非矛盾，见上方 define 注释。
  //
  // 2026-08-03 实测过三种消除警告的写法，都不采用：
  //   - `process.env['NODE_ENV'] ??= ...`（方括号）→ define 同样匹配，警告照旧
  //   - `const e = process.env; e['NODE_ENV'] ??= ...`（别名）→ 警告消失，但 tests/env.test.ts
  //     里防「cli.tsx 设置 NODE_ENV」的静态断言会失效（别名赋值无法可靠静态识别），
  //     等于用一个真实回归缺口换日志干净
  //   - 删掉运行时赋值只留 define → 非打包路径失去分流保证，即 2026-08-03 空白屏事故的成因
  //
  // 静音的代价是失去「esbuild 未来真的改写赋值左值」这一行为变化的提示（那会产出
  // `"production" ??= "production"`，运行时语法错误）。该风险改由 tests/env.test.ts 的
  // 产物校验用例承担：它在 dist-bundle 存在时断言那行仍是合法赋值。
  //
  // 若这条警告出现在别处，说明有新的 define 冲突点，应先查来源再决定是否仍然静音。
  logOverride: {
    'assign-to-define': 'silent',
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
