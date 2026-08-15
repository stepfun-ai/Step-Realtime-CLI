#!/usr/bin/env node
/**
 * bin 引导入口。**本文件不得有任何静态 import。**
 *
 * 职责只有一件：在任何应用模块求值之前把 `NODE_ENV` 设好，然后动态加载真实入口
 * `./cli.js`。之所以要单独一个文件来做，是因为静态 import（以及 Ink 时代 tsc JSX
 * transform 自动注入的 `react/jsx-runtime`）都会排在模块体之前执行——赋值写在 cli 里
 * 就已经晚了。
 *
 * 历史：Ink 时代 `react` 与 `react-reconciler` 按 require 时的 `NODE_ENV` 分流成两套
 * 构建，错配时 reconciler 调度静默失效（终端零字节、不抛异常，功能测试全绿）。
 * 2026-08-03 因此确立本引导结构并删除了 `src/env.ts`。M5 移除 Ink 与 react 后那个具体
 * 故障不再可能，结构保留的理由变成「设置点唯一 + 早于一切模块」：依赖里按 NODE_ENV
 * 分支的代码在分发形态下一律走 production，与 bundle 的 esbuild define 折叠一致。
 *
 * 三条分发路径各自的保障：bin（本文件引导）→ 运行时先赋值再动态 import；bundle →
 * esbuild `define` 静态折叠；直跑 `tsx src/cli.ts`（仅开发调试）→ 不设即默认 development。
 *
 * 回归护栏见 tests/env.test.ts（静态断言：本文件无静态 import、先赋值后加载、cli 不设）。
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
// 虽能消警告，但会让 `tests/env.test.ts` 里防「cli.ts 设置 NODE_ENV」的静态断言失效
// （别名赋值无法可靠地静态识别），等于用一个真实的回归缺口换一条日志的干净。
process.env.NODE_ENV ??= 'production';

// 用 .then/catch 而非顶层 await import：cli.ts 是顶层 await 模块，其内部任何
// process.exit（如首次运行引导里用户按 Esc 取消）都发生在模块执行中途。若此处
// 顶层 await，进程退出时 main 的 await 仍未 settle，Node 24 打
// 「Detected unsettled top-level await」警告。改为 .then 后本模块立即执行完、
// 进程靠 cli 的事件循环存活，警告消除，且 cli 内 process.exit 的退出码不受影响。
// 加载失败（语法错误/缺依赖）由 catch 打印并以码 1 退出。
import('./cli.js').catch((e) => {
  console.error(e);
  process.exit(1);
});
