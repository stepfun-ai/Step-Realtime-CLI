/**
 * 流式内容事件 → 转录块的落位规则。
 *
 * 从 `PiChat.applyEvent` 抽出来的两条决策，抽出的理由是**可测**：PiChat 构造函数里
 * `new ProcessTerminal()` 直接摸真实 tty，测试环境无法实例化，于是「thinking 块与正文块
 * 的先后顺序」这个用户唯一能看见的东西一直没有回归保护——thinking 泄漏那一族 bug
 * （见设计档案《thinking 块序错乱根因》）就是在这个盲区里长出来的。
 *
 * 这里只做块的增删，不碰 activity / status / 重绘等副作用，那些留在 PiChat。
 */
import type { DisplayItem } from './types.js';

/** 转录区的最小写入面。Transcript 天然满足，测试可用数组替身。 */
export interface BlockSink {
  /** 末块（判断正文能否续接）。 */
  lastItem(): DisplayItem | undefined;
  push(item: DisplayItem): void;
  /** 原地更新第 index 块（负数从尾部数）。 */
  update(index: number, item: DisplayItem): void;
}

/**
 * 思考段收尾：累积的思考文本落成一个 thinking 块。
 *
 * 调用点必须在**任何内容流事件**（text / tool_start / error / …）落块之前，
 * 这条顺序是「thinking 块永远排在同一段正文之前」的唯一保证。上游 StreamBuffer
 * 保序（相邻同类合并、段间保持喂入序）保证了传进来的事件序本身没被打乱，两层合起来
 * 才成立：上游乱序时这里落定的时机就是错的，thinking 会跑到正文之后。
 *
 * 返回是否真的落了块（供调用方决定要不要重绘）。
 */
export function settleThinking(sink: BlockSink, accum: string): boolean {
  if (accum === '') return false;
  sink.push({ kind: 'thinking', text: accum });
  return true;
}

/**
 * 正文追加：末块是 assistant 就续接，否则新开一块。
 *
 * 「末块不是 assistant」的常见来源是中间插了 thinking / tool / note 块——此时新开一块是对的，
 * 那确实是被打断后的新一段正文。但如果上游把事件顺序弄反（正文之后才吐出思考尾巴），
 * 这条规则会把**同一段**正文劈成两块、中间夹一个 thinking 块，看起来就是「思考泄漏进正文」。
 * 所以这里不做补偿，顺序问题必须在上游解决。
 */
export function appendText(sink: BlockSink, text: string): void {
  const last = sink.lastItem();
  if (last !== undefined && last.kind === 'assistant') {
    sink.update(-1, { kind: 'assistant', text: last.text + text });
    return;
  }
  sink.push({ kind: 'assistant', text });
}
