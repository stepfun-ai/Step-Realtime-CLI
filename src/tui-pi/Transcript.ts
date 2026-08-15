/**
 * 转录区容器：持有全部消息块，并提供一个「安全阀」级别的裁剪。
 *
 * 裁剪策略是被实测推翻后重定的（数据见设计档案「M1 实测记录」）：
 * 原计划照 Kimi Code 做两级裁剪（15 轮 + 轮内折叠），但实测发现**任何裁剪都必然触发一次
 * 全屏重绘并清掉 scrollback**——裁剪删的是最老的行，删完所有内容上移，首个变化行落在
 * 上一帧视口顶部之上，pi-tui 的差分渲染此时只有 `fullRender(true)` 一条路，
 * 而它带 CSI 3J。关掉 clearOnShrink 挡不住这条路径（那个开关只管「内容变短」这一种触发）。
 *
 * 反过来，不裁剪的成本实测很低：12000 行历史（约 3000 轮）下流式单帧 3.47ms、零全量重绘。
 * 在 50ms 合帧节奏下这是 7% 的帧预算。所以默认不裁剪，保留 maxTurns 作为防内存失控的
 * 安全阀（默认 2000 轮），只有跑到那个量级才接受一次清屏。
 */
import type { Component } from '@earendil-works/pi-tui';
import type { DisplayItem } from '../chat/types.js';
import { ItemBlock } from './blocks.js';
import { c } from './theme.js';

/** 安全阀：保留的最近 turn 数。默认值高到日常用不到，纯防内存失控。 */
export const DEFAULT_MAX_TURNS = 2000;
/** 迟滞：超过 maxTurns + 迟滞才裁一次，避免每轮都动组件树。 */
export const TURN_HYSTERESIS = 50;
/** 单个 turn 内保留的块数上限（同为安全阀，日常回合远达不到）。 */
export const DEFAULT_MAX_BLOCKS_PER_TURN = 2000;

export interface TranscriptOptions {
  maxTurns?: number;
  maxBlocksPerTurn?: number;
}

export class Transcript implements Component {
  private blocks: ItemBlock[] = [];
  private readonly maxTurns: number;
  private readonly maxBlocksPerTurn: number;
  /** 被裁掉的轮数累计（>0 时顶部显示一行折叠提示）。 */
  private foldedTurns = 0;
  /** 被折叠的块数累计（turn 内裁剪产生）。 */
  private foldedBlocks = 0;

  constructor(options: TranscriptOptions = {}) {
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.maxBlocksPerTurn = options.maxBlocksPerTurn ?? DEFAULT_MAX_BLOCKS_PER_TURN;
  }

  invalidate(): void {
    for (const b of this.blocks) b.invalidate();
  }

  /** 当前块数（测试与调试用）。 */
  size(): number {
    return this.blocks.length;
  }

  items(): DisplayItem[] {
    return this.blocks.map((b) => b.getItem());
  }

  push(item: DisplayItem): void {
    this.blocks.push(new ItemBlock(item));
    this.trim();
  }

  /** 整体替换（/new、/resume、历史回放）。 */
  reset(items: readonly DisplayItem[], foldedTurns = 0): void {
    this.blocks = items.map((it) => new ItemBlock(it));
    this.foldedTurns = foldedTurns;
    this.foldedBlocks = 0;
  }

  /** 原地更新第 index 块（负数从尾部数）。越界为空操作。 */
  update(index: number, item: DisplayItem): void {
    const i = index < 0 ? this.blocks.length + index : index;
    this.blocks[i]?.setItem(item);
  }

  /** 找到最后一个满足条件的块并更新（工具状态回填用）。返回是否命中。 */
  updateLastWhere(pred: (item: DisplayItem) => boolean, next: (item: DisplayItem) => DisplayItem): boolean {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]!;
      if (pred(b.getItem())) {
        b.setItem(next(b.getItem()));
        return true;
      }
    }
    return false;
  }

  /** 末块（流式追加正文时判断能否续接）。 */
  lastItem(): DisplayItem | undefined {
    return this.blocks[this.blocks.length - 1]?.getItem();
  }

  /**
   * 两级裁剪。turn 边界按 user 条目切分：
   * 1. turn 数超过 MAX_TURNS + HYSTERESIS 时，丢弃最老的若干 turn，只累计计数；
   * 2. 末尾 turn 内块数超过 MAX_BLOCKS_PER_TURN 时，丢弃该 turn 靠前的块。
   */
  private trim(): void {
    // turn 起始下标
    const starts: number[] = [];
    for (let i = 0; i < this.blocks.length; i++) {
      if (this.blocks[i]!.getItem().kind === 'user') starts.push(i);
    }
    if (starts.length > this.maxTurns + TURN_HYSTERESIS) {
      const dropTurns = starts.length - this.maxTurns;
      const cutAt = starts[dropTurns]!;
      this.blocks = this.blocks.slice(cutAt);
      this.foldedTurns += dropTurns;
      return;
    }
    // turn 内裁剪：只看最后一个 turn（长回合的工具调用是块数膨胀的主要来源）
    const lastStart = starts.length > 0 ? starts[starts.length - 1]! : 0;
    const inTurn = this.blocks.length - lastStart;
    if (inTurn > this.maxBlocksPerTurn) {
      const drop = inTurn - this.maxBlocksPerTurn;
      // 保留 turn 的首块（user 消息本体），从它之后开始丢
      this.blocks = [...this.blocks.slice(0, lastStart + 1), ...this.blocks.slice(lastStart + 1 + drop)];
      this.foldedBlocks += drop;
    }
  }

  render(width: number): string[] {
    const out: string[] = [];
    if (this.foldedTurns > 0) {
      out.push(c.dim(`· 更早的 ${this.foldedTurns} 轮已从屏幕折叠（仍在会话历史与 scrollback 中）`), '');
    }
    if (this.foldedBlocks > 0) {
      out.push(c.dim(`· 本轮 ${this.foldedBlocks} 个条目已折叠`), '');
    }
    for (const b of this.blocks) out.push(...b.render(width));
    return out;
  }
}
