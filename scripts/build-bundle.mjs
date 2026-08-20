/**
 * esbuild 单文件 bundle：把 tsc 产物 dist/main.js 打成零依赖单文件 ESM dist-bundle/step.mjs。
 * 用途：SEA exe 的前置输入，也顺带提供「单文件直接 node 跑」的分发形态。
 * 前置：先跑 `npm run build`（build:bundle 脚本已串联）。项目零原生模块、无 external，
 * 全量打包（Ink 时代为它的可选 devtools 依赖打的空桩已随 Ink 一并移除）。
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectBuildInfo } from './gen-build-info.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 单文件产物读不到 dist/build-info.json（SEA 更是没有外部文件），构建标识只能在这里固化进代码
const buildInfo = collectBuildInfo();
console.log(`build-info 注入: ${buildInfo.commit}${buildInfo.dirty ? '+dirty' : ''} ${buildInfo.time}`);

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
  // 两项 define 必须写在同一个对象里。**曾经它们分成两个 `define:` 键**，而对象字面量后键
  // 覆盖前键——`__STEP_BUILD_INFO__` 因此从未真正注入过，bundle 与 SEA 产物只能退回读
  // sidecar（SEA 里根本读不到），`--version` 与欢迎框的构建标识静默丢失。合并即修复。
  //
  // process.env.NODE_ENV → "production"：Ink 时代它是纵深防御，防 react 与 react-reconciler
  // 的 CJS 入口按 NODE_ENV 分流成两套构建而错配（2026-08-03 空白屏事故）。M5 删掉 Ink 后
  // 那个具体故障不再可能，但折叠仍保留两个作用：让打包产物与 dist/main.js 引导（运行时
  // `??= 'production'`）在三条分发路径上行为一致，且第三方依赖里按 NODE_ENV 分支的代码
  // （开发期告警、额外校验）在产物中被静态消除。
  define: {
    __STEP_BUILD_INFO__: JSON.stringify(JSON.stringify(buildInfo)),
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
  //     里防「cli.ts 设置 NODE_ENV」的静态断言会失效（别名赋值无法可靠静态识别），
  //     等于用一个真实回归缺口换日志干净
  //   - 删掉运行时赋值只留 define → 非打包路径失去 production 默认，与打包形态行为分叉
  //
  // 静音的代价是失去「esbuild 未来真的改写赋值左值」这一行为变化的提示（那会产出
  // `"production" ??= "production"`，运行时语法错误）。该风险改由 tests/env.test.ts 的
  // 产物校验用例承担：它在 dist-bundle 存在时断言那行仍是合法赋值。
  //
  // 若这条警告出现在别处，说明有新的 define 冲突点，应先查来源再决定是否仍然静音。
  logOverride: {
    'assign-to-define': 'silent',
  },
  logLevel: 'info',
});

console.log('bundle 完成: dist-bundle/step.mjs');
