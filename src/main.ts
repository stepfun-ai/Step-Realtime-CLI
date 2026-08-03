#!/usr/bin/env node
/**
 * bin 引导入口。**本文件不得使用 JSX、不得 import 任何会拉起 react 的模块。**
 *
 * `react` 与 `react-reconciler` 的 CJS 入口在 require 那一刻按 `NODE_ENV` 分流
 * （production / development 两套构建），两者必须落在同一套，错配时 reconciler
 * 的调度静默失效：ink 的 render() 正常返回、根组件从未被调用、终端零输出、
 * 无任何异常——TUI 表现为「启动即卡死在空白屏」。
 *
 * 为什么这层兜底不能放在 cli.tsx 里：tsc 的 JSX transform 会在编译产物顶部
 * 自动注入 `import { jsx } from 'react/jsx-runtime'`，排在任何源码 import 之前，
 * 于是 react 在模块体执行前已按 development 分流完毕，`./env.js` 的赋值只来得及
 * 影响 ink 拉起的 react-reconciler——恰好造成 react(dev) + reconciler(prod) 的
 * 错配。只有把设置放进一个完全不含 JSX 的引导文件、再动态加载主模块，才能保证
 * react 与 reconciler 都在 NODE_ENV 就位之后才求值。
 *
 * 所以：bin 指向本文件的编译产物（dist/main.js）；TUI/headless 的真实入口在 ./cli.tsx。
 *
 * **cli.tsx 里不再有任何 NODE_ENV 兜底，这是刻意的。** 曾经它的首个 import 是
 * `./env.js`（只做 `process.env.NODE_ENV ??= 'production'`），2026-08-03 实测证明那道
 * 兜底净有害：它在本引导路径与 bundle 路径上都是 no-op，唯一真正生效的场合是有人直跑
 * `tsx src/cli.tsx` / `node dist/cli.js`——而在那里它只够得到 reconciler、够不到已被
 * jsx-runtime 抢跑分流的 react，于是把「两包一致走 dev、能正常工作」变成「错配、静默
 * 卡死」。实测（外部一律 `env -u NODE_ENV`）：有该 import 时 stdout **0 字节**；令两包
 * 一致（NODE_ENV=development）时 stdout 2000+ 字节。故已删除 `src/env.ts` 并改为在
 * cli.tsx 顶部写明禁令。
 *
 * 三条分发路径各自的保障：bin（本文件引导）→ 运行时先赋值再动态 import；bundle →
 * esbuild `define` 静态折叠；直跑 cli.tsx（仅开发调试）→ 不设即两包一致走 dev，可用。
 */

// 不覆盖显式设置：NODE_ENV=development 运行（含 pnpm dev）仍然生效。
//
// 这行与 bundle 脚本的 esbuild `define` 是**两条分发路径各自的手段**，不是重复：
//   - 经 esbuild 的 bundle / SEA：define 在打包期把读取点折叠为常量
//   - tsc 直出 dist/ 与 tsx 直跑开发：不经打包器，只有这行运行时赋值能保证分流正确
//
// esbuild 会为此报 assign-to-define 警告（它看到被 define 的表达式出现在赋值左侧）。
// 该警告在 `scripts/build-bundle.mjs` 里被显式静音，那里记录了完整理由与实测结论。
// **不要为消除警告改写这行的语法**：2026-08-03 实测 `process.env['NODE_ENV']`（方括号）
// 同样被 define 匹配、警告照旧；改用 `const e = process.env; e['NODE_ENV'] ??= ...`
// 虽能消警告，但会让 `tests/env.test.ts` 里防「cli.tsx 设置 NODE_ENV」的静态断言失效
// （别名赋值无法可靠地静态识别），等于用一个真实的回归缺口换一条日志的干净。
process.env.NODE_ENV ??= 'production';

await import('./cli.js');
