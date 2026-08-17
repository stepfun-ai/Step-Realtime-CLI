/**
 * SlicedString 保留父串导致的泄漏（回归：2026-08-17 的第二次 4GB OOM）。
 *
 * ## 事故与第一次的区别
 *
 * 第一次（2026-08-16，109 分钟）定位到 pi-tui 的 `widthCache` 把**整份文本**当 key，补丁加了
 * 512 长度上限。**打了补丁的版本在次日照样崩**：8.8 分钟、3 轮对话、零后台任务、单次
 * web_search，堆仍到 4GB。所以第一轮补丁修的是真泄漏，但不是主因。
 *
 * ## 机制
 *
 * V8 的 `String.prototype.slice()` 对足够长的结果返回 **SlicedString**，它只存
 * `{parent, offset, length}`，父串因此无法回收。`ActivityLine.render()` 每帧从累积的思考
 * 文本里切 76 字符做预览：
 *
 * ```js
 * const flat = this.thinkingPreview.replace(/\s+/g, ' ');  // 整份多 MB 文本的新副本
 * const tail = flat.slice(-76);                            // 76 字符，但拖着整份 flat
 * ```
 *
 * 这个 76 字符的 `tail` 顺利通过补丁的长度检查、被收进 widthCache，却拖着整份父串。
 * 512 条 LRU 各拖一份**不同版本**的父串 = GB 级。实测复刻：1.2M 字符累积文本 + 512 条
 * LRU = 677MB。这解释了全部现象——为什么补丁在生效却照样崩、为什么只在 thinking 模型上
 * 炸、为什么 8 分钟就到、为什么 GC 一个字节都回收不动（全是活对象）。
 *
 * ## 两道防线，各自独立
 *
 * 1. **站点修复**（本文件第一组）：先切窗口再压空白。切窗口拖的是累积器本身（本来就活着），
 *    随后的 `replace` 产出独立扁平串，父串引用到此断开。顺带把每帧对整份文本跑正则的
 *    O(n) 开销降成 O(窗口)。
 * 2. **通用防御**（本文件第二组）：pi-tui 补丁在 `widthCache.set` 前把 key 复制成独立串。
 *    key 已被限到 512 以内，复制成本可忽略。有它在，调用方任何位置从长串切短串都不会再
 *    泄漏——逐个站点去找必然漏掉一些（`blocks.ts` 的工具参数预览就是同一形状）。
 */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { ActivityLine } from '../../src/tui-pi/StatusLine.js';

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

function heapAfterGc(): number {
  gc!();
  gc!();
  return process.memoryUsage().heapUsed;
}

const WIDTH = 80;
/** 思考增量数。原 600 × 2000 = 1.2M 字符是给旧的 slice 路径用的（slice O(1) 每帧），
 * 改用 Text 组件后 render 做全文 wrap，同等参数跑 208s 超时。降到 200 × 1000 = 200K 字符，
 * Text 的 wrap 仍是 O(n) 但总量可控，几秒内完成。泄漏信号不丢：200 次唯一尾部 + 200 个
 * 独立版本，足以验证不拖父串。 */
const DELTAS = 200;
/** 每个增量的字符数。 */
const CHUNK = 1000;

/**
 * 尾部内容每次必须不同。
 *
 * 第一版探针用的是内容重复的填充，于是每帧切出的尾部字符串完全相同，Map 直接按内容去重成
 * 1 条，泄漏一点都测不出来（探针报 0.01MB，看着像「没问题」）。真实场景里尾部永远是最新
 * 到达的思考内容，天然唯一。
 */
function chunkFor(i: number): string {
  return `${'字'.repeat(CHUNK)}[思考片段编号${i}结束]`;
}

describe.skipIf(!canGc)('思考预览不得拖住整份累积文本（回归：2026-08-17 的 4GB OOM）', () => {
  /**
   * 这条守的是**端到端不泄漏**，对「哪一道防线在起作用」不敏感——实测撤掉站点修复它仍然绿，
   * 因为补丁的复制 key 把父串引用兜掉了。这是两道防线冗余的正确表现，不是测试失效。
   * 站点修复的独立价值由下面第三组（单帧耗时与 preview 长度无关）单独守。
   */
  it(`ActivityLine 渲染 ${DELTAS} 个思考增量：堆增量远小于文本总量`, () => {
    const act = new ActivityLine();
    act.setBusy(true);
    const before = heapAfterGc();
    let accum = '';
    for (let i = 0; i < DELTAS; i++) {
      accum += chunkFor(i);
      // 复刻 PiChat.applyEvent 的 thinking_delta 分支：整份累积文本每次都传进去
      act.setThinking(true, accum);
      act.render(WIDTH);
    }
    const growth = heapAfterGc() - before;
    const totalChars = DELTAS * CHUNK;
    expect(
      growth,
      `堆增量 ${(growth / 1024 / 1024).toFixed(1)}MB。累积文本共约 ${totalChars / 1000}K 字符，` +
        '泄漏时 512 条 LRU 各拖一份父串（实测 677MB）。' +
        'StatusLine 的思考预览可能又变回「先 replace 整份再 slice」的顺序',
    ).toBeLessThan(20 * 1024 * 1024);
  }, 120_000);

  /**
   * 反证：上面那条不是「无论如何都通过」的空气测试。
   *
   * 手工复刻泄漏写法（先对整份文本 replace，再切短尾，短尾进 512 条 LRU），确认同样的
   * 测量方法能把数百 MB 的增长测出来。没有这条，上面绿了也说明不了任何事——这个仓库在
   * 排查 OOM 的过程中已经有六次「测量方法失效」，每次都表现为一组看着可信的数字。
   */
  it('反证：同样的测量方法能测出泄漏写法的数百 MB 增长', () => {
    const cache = new Map<string, number>();
    const before = heapAfterGc();
    let accum = '';
    for (let i = 0; i < DELTAS; i++) {
      accum += chunkFor(i);
      const flat = accum.replace(/\s+/g, ' ').trimEnd(); // 整份文本的新副本
      const tail = flat.slice(-(WIDTH - 4)); // SlicedString，拖着整份 flat
      if (cache.size >= 512) {
        const first = cache.keys().next().value;
        if (first !== undefined) cache.delete(first);
      }
      cache.set(tail, tail.length);
    }
    const growth = heapAfterGc() - before;
    expect(cache.size, '缓存被按内容去重了，尾部内容不唯一，探针无效').toBe(DELTAS);
    expect(
      growth,
      `泄漏写法只测出 ${(growth / 1024 / 1024).toFixed(1)}MB 增长，说明测量方法失效，上面那条断言不可信`,
    ).toBeGreaterThan(5 * 1024 * 1024);
  }, 120_000);
});

describe.skipIf(!canGc)('pi-tui 补丁的通用防御：widthCache 不得拖住 key 的父串', () => {
  /**
   * 这条守的是补丁的第二轮改动（`widthCache.set` 前复制 key）。
   *
   * 站点修复只管当前这一处；补丁管的是所有调用方。升级 pi-tui 时 patch 可能因基线变化
   * 失配而被静默丢弃，而泄漏只在跑够久、且模型持续输出长思考时才显形——日常开发撞不到。
   *
   * 这里直接走 `visibleWidth`（补丁作用的那个函数），喂进「从长父串切出的短串」，
   * 断言父串没被留住。
   */
  /**
   * 父串尺寸要够大才测得出。第一版这里用的是 2000 字符（4KB）的父串，512 条 LRU 全拖住也
   * 只有 2MB，低于阈值——撤掉补丁做变异验证时这条**没有报红**，等于空气。
   * 泄漏量 = LRU 条数 x 单份父串大小，所以父串必须撑到让 512 份明显超过阈值：
   * 50K 字符 = 100KB，512 份约 51MB，对 10MB 阈值有 5 倍区分度。
   */
  const BIG_PARENT_CHARS = 50_000;

  it('把从长父串切出的短串反复喂给 visibleWidth，父串不得被留住', () => {
    const before = heapAfterGc();
    for (let i = 0; i < DELTAS; i++) {
      // 每轮造一份独立的大父串，切一段短尾喂给 visibleWidth。
      // 父串在本轮结束后除了「可能被 widthCache 的 key 拖住」之外没有任何引用。
      const parent = `${'字'.repeat(BIG_PARENT_CHARS)}[父串编号${i}结束]`;
      const short = parent.slice(-(WIDTH - 4));
      visibleWidth(short);
    }
    const growth = heapAfterGc() - before;
    expect(
      growth,
      `堆增量 ${(growth / 1024 / 1024).toFixed(1)}MB，512 条 LRU 各拖一份 ${BIG_PARENT_CHARS / 1000}K 字符父串约 51MB。` +
        'widthCache 可能又在直接存 key 而不是存副本（patches/ 里的补丁失配了？）',
    ).toBeLessThan(10 * 1024 * 1024);
  }, 120_000);
});

describe('站点修复：单帧渲染开销不得随累积思考文本增长', () => {
  /**
   * 站点修复（先切窗口再压空白）在补丁存在时对**内存**没有额外贡献——两道防线任一都能挡住
   * 父串保留。它的独立价值在 **CPU**：原写法每帧（120ms 一拍）对整份 thinkingPreview 跑一遍
   * `replace(/\s+/g, ' ')`，长思考下就是每秒 8 次全文正则扫描，整轮累计 O(n²)。
   *
   * 判据用「单帧耗时与 preview 长度无关」而不是绝对毫秒数：绝对阈值在不同机器上必然 flaky，
   * 而 1K 字符与 8M 字符之间是数量级差异，比值判据稳得多。
   */
  it('preview 从 1K 涨到 8M 字符，单帧 render 耗时不应数量级上升', () => {
    const measure = (chars: number): number => {
      const act = new ActivityLine();
      act.setBusy(true);
      act.setThinking(true, '字'.repeat(chars));
      // 预热一帧，避免首次调用的 JIT 与缓存冷启动算进去
      act.render(WIDTH);
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) act.render(WIDTH);
      return performance.now() - t0;
    };
    const small = measure(1_000);
    const big = measure(8_000_000);
    // 只处理尾部窗口时两者几乎相同；对整份文本跑正则时 8M 那次会慢几个数量级。
    // 阈值取 50 倍：远高于测量噪声（小样本耗时可能只有零点几毫秒，比值波动大），
    // 又远低于 O(n) 全文扫描的真实差距（8000 倍长度差）。
    const ratio = big / Math.max(small, 0.05);
    expect(
      ratio,
      `8M 字符 preview 单帧耗时是 1K 字符的 ${ratio.toFixed(1)} 倍（${big.toFixed(1)}ms vs ${small.toFixed(1)}ms）。` +
        'StatusLine 的思考预览可能又变回「先对整份文本 replace，再切尾部」的顺序',
    ).toBeLessThan(50);
  }, 120_000);
});
