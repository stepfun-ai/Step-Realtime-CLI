import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * 默认 5000ms 对本项目的进程级测试不够。
     *
     * 需要余量的是那些真 spawn 子进程的用例：首帧冒烟要等 `dist/main.js` 完整启动并画出
     * 一帧（本机约 2.4s，冷启动更久），bash 工具与后台任务的用例也各自等真实进程。
     * 这类耗时在 16 核并发下互相抢 CPU 会被放大数倍，表现为「每次失败的 case 都不同」的
     * 跨文件漂移——调度竞争的特征，不是某个用例的逻辑缺陷（涉事用例单跑全部稳定通过）。
     *
     * 提到 20s 是给调度抖动留够余量。这不会掩盖真实的死锁或死循环——那类问题一样会超时，
     * 只是多等 15 秒。而假阳性会训练人忽略红灯，代价更高。
     *
     * （Ink 时代此处的理由是组件树渲染 + 167 处 `delay(n)` 硬等待；M5 删除 Ink 后那批
     * 用例已不存在，但进程级用例的余量需求仍在。）
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
