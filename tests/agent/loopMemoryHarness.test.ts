/**
 * 主循环整条链路的内存 harness（回归：2026-08-16 的 4GB OOM）。
 *
 * 前两个泄漏点都是在隔离组件上量到的（pi-tui 的 widthCache、BackgroundManager 的终态条目），
 * 但事故堆到 4GB，量级上仍未逐字节归因。这个文件补的是「整条 runAgent 链路跑很多轮」这个
 * 形状：provider 流式解析、工具执行、事件分发、压缩预检、usage 累计全都真跑一遍。
 *
 * 测量设计上有一个关键决定：**每次迭代都用全新的短历史**。
 * 历史数组本身随轮次增长是合法行为（对话在变长），把它算进增量会得到一个必然线性上升的
 * 数字，然后无从判断那是泄漏还是正常。用完即弃的短历史把这项抵掉，于是跨迭代的任何堆增长
 * 都只能来自「本该随调用结束释放、实际却被某个容器留住」的东西。
 *
 * 只在能拿到 gc() 时跑：没有强制 GC，采到的是还没回收的垃圾，任何路径都像在漏。
 */
import Anthropic from '@anthropic-ai/sdk';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/loop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { makeFakeProvider, textBlock } from '../helpers/fakeProvider.js';

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

/**
 * 每回合的文本：40 段 × 约 1600 字符 ≈ 64K 字符（UTF-16 下约 128KB）。
 *
 * **必须按轮次生成唯一内容，不能用模块级常量数组。** 第一版把它写成常量，结果对照组
 * （故意每轮保留事件流）90 轮只涨 0.40MB——每轮复用的是同一批字符串对象，保留事件流
 * 只保留了指针，不产生副本，于是 harness 测不出任何「每轮留一份」的泄漏。真实场景里
 * 每轮文本都是网络新来的独立字符串，harness 必须复刻这一点。
 */
function makeChunks(turn: number): string[] {
  return Array.from(
    { length: 40 },
    (_, i) => `第${turn}轮第${i}段流式正文内容${String(turn * 40 + i).repeat(800)}`,
  );
}

/** 轮次计数器：给每轮的文本一个唯一前缀（Date.now 之类不可复现的东西不用）。 */
let turnSeq = 0;

/** 一次「用完即弃」的完整回合：新 provider、新历史、新事件收集器。 */
async function oneTurn(): Promise<void> {
  const chunks = makeChunks(turnSeq++);
  const { provider } = makeFakeProvider([
    {
      thinkingChunks: [`先想一下第${turnSeq}轮这个问题`, '再想一层'],
      textChunks: chunks,
      finalContent: [textBlock(chunks.join(''))],
    },
  ]);
  const messages: StoredMessage[] = [stored({ role: 'user', content: '请回答' }, { kind: 'user' })];
  const events: unknown[] = [];
  for await (const ev of runAgent({
    provider,
    system: 'sys',
    ctx: { cwd: process.cwd() },
    messages,
    // 压缩阈值给足，避免这条 harness 顺带触发摘要请求（那是另一条路径）
    compaction: { maxContextSize: 1_000_000, triggerRatio: 0.85, reservedTokens: 10 },
  })) {
    events.push(ev);
  }
  // events 本地持有到函数结束即释放；留着是为了防 V8 把整个循环优化掉
  if (events.length === 0) throw new Error('runAgent 一个事件都没产出，harness 失效');
}

/** 跑 n 轮，返回强制 GC 后的堆增量。 */
async function measure(n: number): Promise<number> {
  // 预热：模块加载、tools schema、V8 优化编译都不算进增量
  for (let i = 0; i < 5; i++) await oneTurn();
  const before = heapAfterGc();
  for (let i = 0; i < n; i++) await oneTurn();
  return heapAfterGc() - before;
}

/**
 * 泄漏判定线（90 轮口径）。
 *
 * 这个值不是猜的，两端都有实测垫底：干净路径 90 轮实测 0.10MB；对照组（故意每轮保留
 * 事件流）实测 1.93MB。取 1MB 落在两者中间，离噪声有 10 倍余量、离已知泄漏信号有 2 倍
 * 余量。原先写的 3MB 高于对照组信号，对照组自己都过不去——那种阈值等于没有判据。
 *
 * 另外一个反直觉的实测结果：把每轮文本量提到 3.2 倍，对照组增量不变（2.04 → 1.93MB）。
 * 说明事件流保留的是事件对象的固定开销（约 22KB/轮），正文并不随事件留存。所以这条
 * harness 对「按轮次累积对象」敏感，对「按文本长度累积」不敏感——后者由
 * tests/tui-pi/memoryGrowth.test.ts 覆盖（widthCache 那条就是那个形状）。
 */
const LEAK_LINE_90 = 1024 * 1024;

describe.skipIf(!canGc)('主循环跑多轮不得累积堆（回归：4GB OOM）', () => {
  /**
   * 判据用「线性性」而不是「绝对值」：绝对阈值要么松到测不出小泄漏，要么紧到被噪声打红。
   * 泄漏若存在，30 轮与 90 轮的增量比应接近 3；不存在时两者都在噪声量级，比值失去意义。
   */
  it('30 轮与 90 轮的堆增量不呈线性（每轮用完即弃的历史）', async () => {
    const g30 = await measure(30);
    const g90 = await measure(90);
    const mb = (n: number) => (n / 1024 / 1024).toFixed(2);
    // 每轮约 20KB 文本。真有「每轮留一份」的泄漏，90 轮就是 90 × 20KB ≈ 1.8MB 起，
    // 且严格三倍于 30 轮。阈值取 3MB 绝对值 + 不得超过 30 轮增量的 2.5 倍双重判据。
    expect(
      g90,
      `90 轮堆增量 ${mb(g90)}MB（30 轮 ${mb(g30)}MB），超过 1MB 判定线（干净路径实测 0.10MB）`,
    ).toBeLessThan(LEAK_LINE_90);
    // 30 轮增量本身可能是负数（GC 把预热期的垃圾也收了），此时线性判据无意义，跳过
    if (g30 > 512 * 1024) {
      expect(
        g90 / g30,
        `增量比 ${(g90 / g30).toFixed(2)} 接近轮次比 3，说明每轮各留一份（30 轮 ${mb(g30)}MB / 90 轮 ${mb(g90)}MB）`,
      ).toBeLessThan(2.5);
    }
  }, 300_000);

  /**
   * 断流 retry 路径单独量：正文已进 UI 但流未正常收尾，这条路径要重建请求、清理思考残段，
   * 是最容易把上一次的缓冲留在手里的地方。事故当时走的正是 openai 通道且有 retry。
   */
  /**
   * 轮数取 30 而不是 90：retry 退避是真 sleep（RETRY_BASE_MS = 300，指数上去），60 轮实测
   * 22 秒全是纯等待，每次跑测试都要付。按比例收紧判定线保住灵敏度——「每轮留一份」的信号
   * 是约 22KB/轮（见 LEAK_LINE_90 注释的实测），30 轮即 0.66MB，判定线取 0.5MB；而干净路径
   * 90 轮只有 0.10MB，折到 30 轮约 0.03MB，仍有 16 倍余量。
   */
  it('断流 retry 跑 30 轮不累积（正文吐一半后断连）', async () => {
    const broken = async (): Promise<void> => {
      const { provider } = makeFakeProvider([
        {
          textChunks: makeChunks(turnSeq++),
          throwAfterChunks: new Anthropic.APIError(500, undefined, 'terminated', undefined),
          finalContent: [textBlock('unused')],
        },
        { textChunks: [`重试后的回答${turnSeq}`], finalContent: [textBlock(`重试后的回答${turnSeq}`)] },
      ]);
      const messages: StoredMessage[] = [stored({ role: 'user', content: '请回答' }, { kind: 'user' })];
      try {
        for await (const _ of runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages })) {
          // 只驱动，不留引用
        }
      } catch {
        // 重试耗尽后抛错是预期行为，这里只关心内存
      }
    };
    for (let i = 0; i < 3; i++) await broken();
    const before = heapAfterGc();
    for (let i = 0; i < 30; i++) await broken();
    const growth = heapAfterGc() - before;
    expect(
      growth,
      `断流 retry 30 轮堆增量 ${(growth / 1024 / 1024).toFixed(2)}MB，超过 0.5MB 判定线`,
    ).toBeLessThan(LEAK_LINE_90 / 2);
  }, 300_000);
});

describe.skipIf(!canGc)('对照组：这套测量必须能测出「每轮留一份」', () => {
  /**
   * 故意把每轮的事件流留在一个外部数组里——这正是「每轮各留一份」的泄漏形状。
   * 这条**必须**同时突破绝对阈值和线性判据；突不破说明 harness 是空气，上面两条绿了
   * 也说明不了任何事（这个仓库已经因为测量失效误判过四次，见 OOM 档案第三节）。
   */
  it('故意每轮保留事件流：绝对阈值与线性判据都能报出来', async () => {
    const leaked: unknown[][] = [];
    const leakyTurn = async (): Promise<void> => {
      const chunks = makeChunks(turnSeq++);
      const { provider } = makeFakeProvider([
        { textChunks: chunks, finalContent: [textBlock(chunks.join(''))] },
      ]);
      const messages: StoredMessage[] = [stored({ role: 'user', content: '请回答' }, { kind: 'user' })];
      const events: unknown[] = [];
      for await (const ev of runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages })) {
        events.push(ev);
      }
      leaked.push(events); // 唯一的差别就在这一行
    };
    const run = async (n: number): Promise<number> => {
      const before = heapAfterGc();
      for (let i = 0; i < n; i++) await leakyTurn();
      return heapAfterGc() - before;
    };
    for (let i = 0; i < 5; i++) await leakyTurn();
    const g30 = await run(30);
    const g90 = await run(90);
    const mb = (n: number) => (n / 1024 / 1024).toFixed(2);
    expect(
      g90,
      `对照组 90 轮只涨 ${mb(g90)}MB，没突破 1MB 判定线，说明 harness 测不出「每轮留一份」`,
    ).toBeGreaterThan(LEAK_LINE_90);
    expect(
      g90 / g30,
      `对照组增量比 ${(g90 / g30).toFixed(2)} 不呈线性（30 轮 ${mb(g30)}MB / 90 轮 ${mb(g90)}MB），线性判据无效`,
    ).toBeGreaterThan(2.5);
    expect(leaked).toHaveLength(125);
  }, 300_000);
});

// 数字留档：干净路径与对照组各自的实测增量（跑一次打印，便于日后对比阈值是否还合理）
describe.skipIf(!canGc)('实测数字留档', () => {
  it('打印干净路径 90 轮的堆增量', async () => {
    const g = await measure(90);
    console.log(`[harness] 干净路径 90 轮堆增量：${(g / 1024 / 1024).toFixed(2)}MB`);
    expect(g).toBeLessThan(LEAK_LINE_90);
  }, 300_000);
});
