import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * 默认 5000ms 对本项目的 TUI 测试不够。
     *
     * Ink 测试要真实渲染组件树，并靠 `delay(n)` 等待异步 flush——全套件 167 处
     * 硬等待、累计 5.3 秒。单个 case 内也会累积：promptInput 有个用例逐字符删除
     * 21 字符占位符、每步 delay(25)，光硬等待就 525ms，串行渲染叠加后单跑约 1.2s。
     *
     * 单跑时余量看着够（1.2s vs 5s），但 16 核并发下这些 case 互相抢 CPU，
     * 放大 3 倍就撞线。表现为「每次失败的 case 都不同」——三次全量跑分别挂在
     * promptInput 的两个不同用例和 markdownBodyRepro 上，跨文件漂移。
     * 这是调度竞争的特征，不是某个用例的逻辑缺陷：涉事用例单独跑全部稳定通过。
     *
     * 提到 20s 是给调度抖动留够余量。这不会掩盖真实的死锁或死循环——
     * 那类问题一样会超时，只是多等 15 秒。而假阳性会训练人忽略红灯，代价更高。
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
    /**
     * .teams/ 是 team 模式的工作间目录（git worktree 挂在仓内）。不 exclude 的话，
     * 每个活跃工作间里的测试副本会被 vitest 重复扫描执行（同一用例跑 N+1 遍，
     * 还会因 worktree 缺 node_modules 报出误导性失败）。
     */
    exclude: ['**/node_modules/**', '**/.teams/**'],
  },
});
