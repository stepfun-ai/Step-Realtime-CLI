/**
 * 内存泄漏回归：流式渲染不得随文本增长而累积堆。
 *
 * 2026-08-16 的 OOM 事故：跑 109 分钟后堆到 4GB，FATAL ERROR: Ineffective mark-compacts。
 * 根因在 pi-tui 0.84.1 的 `visibleWidth()`——它把**整份文本**作为 widthCache（512 条 LRU）
 * 的 key。流式渲染时每帧文本都是新版本，于是 512 条各钉住一份完整历史文本，占用
 * = 512 × 文本大小，与帧数无关。单条消息涨到几 MB 时 512 份就是数 GB。
 *
 * 已通过 `patches/@earendil-works__pi-tui@0.84.1.patch` 修掉（长度超 512 的 key 不缓存；
 * 长文本在那里命中率为零，实测不缓存无性能损失：16291ms → 16306ms）。
 *
 * 这条测试守的是那个补丁：升级 pi-tui 时 patch 可能因基线变化而失配、被静默丢弃，
 * 而泄漏只在跑够久之后才显形，日常开发根本撞不到。所以在这里量。
 *
 * 只在有 --expose-gc 时跑：没有强制 GC，采到的是「还没回收的垃圾」，任何路径都像在漏。
 */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { Markdown } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { Transcript } from '../../src/tui-pi/Transcript.js';

/**
 * 运行时拿到 gc()，而不是要求用 --expose-gc 启动。
 *
 * vitest 会覆盖 worker 的 execArgv，`poolOptions.forks.execArgv` 传不进去（实测 worker 里
 * 的 execArgv 只有 vitest 自己那几项）。而 `describe.skipIf(!canGc)` 的后果是**静默跳过**：
 * 守卫看着在、实际从不执行。所以这里自己把 flag 打开再取函数，让测试不依赖启动方式。
 */
function acquireGc(): (() => void) | undefined {
  if (typeof global.gc === 'function') return global.gc.bind(global);
  try {
    setFlagsFromString('--expose-gc');
    const fn = runInNewContext('gc') as unknown;
    return typeof fn === 'function' ? (fn as () => void) : undefined;
  } catch {
    return undefined;
  }
}

const gc = acquireGc();
const canGc = gc !== undefined;

/** 强制 GC 两轮再采样：一轮可能留下待终结对象。 */
function heapAfterGc(): number {
  gc!();
  gc!();
  return process.memoryUsage().heapUsed;
}

/**
 * 流式追加 + 每帧重渲，返回堆增量（字节）。
 *
 * @param render 每次追加后怎么渲染（分别覆盖 pi-tui 组件与我们的 Transcript 两条路径）
 */
function measureStreamingGrowth(iterations: number, render: (text: string) => void): number {
  const CHUNK = '这是流式追加的一小段内容。';
  let text = '';
  // 预热：让一次性分配（模块、解析器、主题表）不算进增量
  for (let i = 0; i < 100; i++) {
    text += CHUNK;
    render(text);
  }
  const before = heapAfterGc();
  for (let i = 0; i < iterations; i++) {
    text += CHUNK;
    render(text);
  }
  return heapAfterGc() - before;
}

describe.skipIf(!canGc)('流式渲染的内存增长（回归：2026-08-16 的 4GB OOM）', () => {
  it('pi-tui Markdown 组件：2000 帧流式渲染，堆增长不超过 3MB', () => {
    const md = new Markdown('', 0, 0, undefined, undefined, undefined);
    const growth = measureStreamingGrowth(2000, (text) => {
      md.setText(text);
      md.render(100);
    });
    // 补丁前实测 20.6MB 且线性上升；补丁后 0.3MB。3MB 阈值留足噪声空间，
    // 又能在补丁失效时（20MB 量级）稳定报红。
    expect(
      growth,
      `堆增长 ${(growth / 1024 / 1024).toFixed(1)}MB，超过 3MB。` +
        'pi-tui 的 widthCache 补丁可能已失效（升级后 patch 失配？），见 patches/ 目录',
    ).toBeLessThan(3 * 1024 * 1024);
  }, 120_000);

  it('Transcript 末块流式追加：2000 帧，堆增长不超过 3MB', () => {
    const t = new Transcript();
    t.push({ kind: 'assistant', text: '' });
    const growth = measureStreamingGrowth(2000, (text) => {
      t.update(-1, { kind: 'assistant', text });
      t.render(100);
    });
    expect(
      growth,
      `堆增长 ${(growth / 1024 / 1024).toFixed(1)}MB，超过 3MB（我方渲染路径）`,
    ).toBeLessThan(3 * 1024 * 1024);
  }, 120_000);

  /**
   * 反证：这两条断言不是「无论如何都通过」的空气测试。
   *
   * 手工模拟泄漏机制（512 条 LRU 各持一份独立的全文副本），确认同样的测量方法能把
   * 20MB 量级的增长测出来。没有这条，上面两条绿了也说明不了测量有效。
   *
   * 注意副本必须是**独立扁平串**：`text += chunk` 得到的是 V8 rope，512 个版本共享
   * 同一条 ConsString 链，总占用几乎等于末态一份，测不出任何增长（第一版反证就是这么
   * 写的，结果自己不通过）。pi-tui 那边的 key 来自渲染管线，本就是独立扁平串。
   */
  it('反证：同样的测量方法能测出人为的 512 条全文缓存（否则上面两条是空气）', () => {
    const fakeCache = new Map<string, number>();
    const growth = measureStreamingGrowth(2000, (text) => {
      // Array.from().join() 强制生成独立扁平副本，复刻修复前 widthCache 的持有效果
      const flatCopy = Array.from(text).join('');
      if (fakeCache.size >= 512) {
        const first = fakeCache.keys().next().value;
        if (first !== undefined) fakeCache.delete(first);
      }
      fakeCache.set(flatCopy, flatCopy.length);
    });
    expect(
      growth,
      '人为构造的 512 条全文缓存都没测出增长，说明测量方法失效，上面两条断言不可信',
    ).toBeGreaterThan(5 * 1024 * 1024);
  }, 120_000);
});
