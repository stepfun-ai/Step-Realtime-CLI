import { describe, expect, it } from 'vitest';
import {
  advanceContinuation,
  checkContinuationSafety,
  findRepeatingTail,
  initialContinuationState,
  type ContinuationState,
} from '../../src/agent/continuation.js';

/** 造一个干净的初始状态（首轮正文给定）。 */
function st(firstText = '第一轮写到一半的正文', over: Partial<ContinuationState> = {}): ContinuationState {
  return { ...initialContinuationState(firstText), ...over };
}

describe('findRepeatingTail：尾部周期性重复检测', () => {
  it('长片段精确重复 3 次即命中（≥20 字符周期）', () => {
    const unit = '好的，我来继续写这一部分的内容与说明。'; // 19 字 → 不够，下面用更长的
    const long = unit + '补足到二十字符以上。'; // ≥20 字，走「3 次」档
    expect(long.length).toBeGreaterThanOrEqual(20);
    const p = findRepeatingTail('前面是正常内容。' + long.repeat(3));
    expect(p).not.toBeNull();
    expect(long.length % p!).toBe(0);
  });

  it('长片段只重复 2 次不算异常（可能是修辞或结构对称）', () => {
    const unit = '这是一段足够长的、超过二十个字符的内容片段。';
    expect(findRepeatingTail('开头。' + unit.repeat(2))).toBeNull();
  });

  it('中等周期（5~19 字符）要求 6 次以上', () => {
    const unit = '继续写下去'; // 5 字
    expect(findRepeatingTail('正文。' + unit.repeat(5))).toBeNull();
    expect(findRepeatingTail('正文。' + unit.repeat(6))).not.toBeNull();
  });

  it('短周期（≤4 字符）要求 20 次以上——否则会误伤正常排版', () => {
    expect(findRepeatingTail('结论。' + '哈'.repeat(10))).toBeNull();
    expect(findRepeatingTail('结论。' + '哈'.repeat(20))).not.toBeNull();
  });

  it('正常排版不误伤：分隔线 / 省略号 / 列表前缀 / 缩进', () => {
    // 这几种都是长输出里的常见形态，任何一条被判成「复读」都会中断正常任务
    const cases = [
      '## 小节标题\n\n' + '-'.repeat(12) + '\n正文继续。',
      '他停顿了一下……然后接着说……最后总结……',
      '清单：\n- [ ] 第一项\n- [ ] 第二项\n- [ ] 第三项\n- [ ] 第四项\n',
      '```\n' + '    缩进行内容\n'.repeat(4) + '```',
      '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n',
      '=' .repeat(16) + '\n边框标题\n' + '='.repeat(16),
    ];
    for (const c of cases) {
      expect(findRepeatingTail(c), `不应误判为复读: ${JSON.stringify(c.slice(0, 30))}`).toBeNull();
    }
  });

  it('太短的字符串直接返回 null（不足以构成周期）', () => {
    expect(findRepeatingTail('')).toBeNull();
    expect(findRepeatingTail('ab')).toBeNull();
  });

  it('重复段在尾部才算；只在开头重复不命中（尾部才代表当前卡住）', () => {
    const unit = '这是一段足够长的、超过二十个字符的内容片段。';
    const s = unit.repeat(3) + '后来模型恢复正常并写出了新的内容，这段不重复。';
    expect(findRepeatingTail(s)).toBeNull();
  });
});

describe('checkContinuationSafety：三层守卫', () => {
  it('正常推进 → safe', () => {
    expect(checkContinuationSafety('接着写出了新的一段内容。', st(), 10)).toEqual({ safe: true });
  });

  it('① 空内容 / 纯空白 → no_progress（确定性，无阈值）', () => {
    expect(checkContinuationSafety('', st(), 10)).toMatchObject({ safe: false, reason: 'no_progress' });
    expect(checkContinuationSafety('   \n\t ', st(), 10)).toMatchObject({
      safe: false,
      reason: 'no_progress',
    });
  });

  it('② 与上一轮完全相同 → identical_to_previous', () => {
    const chunk = '这一段和上轮一模一样。';
    const s = st('首轮', { lastChunk: chunk });
    expect(checkContinuationSafety(chunk, s, 10)).toMatchObject({
      safe: false,
      reason: 'identical_to_previous',
    });
  });

  it('② 只差一个字就不算完全相同（判据是严格相等，不是相似）', () => {
    const s = st('首轮', { lastChunk: '这一段和上轮几乎一样。' });
    expect(checkContinuationSafety('这一段和上轮几乎一样！', s, 10)).toEqual({ safe: true });
  });

  it('③ 开头与首轮相同 → restarted_from_beginning', () => {
    const first = '好的，我来从头介绍这个方案的全部内容，包括背景与动机。';
    const s = st(first);
    expect(checkContinuationSafety(first + '（后面又写了一遍）', s, 10)).toMatchObject({
      safe: false,
      reason: 'restarted_from_beginning',
    });
  });

  it('③ 首轮正文短于阈值时跳过该判定——短开头不足以作为特征（曾静默失效的缺陷）', () => {
    // 首轮只有几个字时，「好的」这类通用开场会让正常续写被误判为从头重来，
    // 故短首轮直接跳过该判定。同时这条也钉住修复前的 bug：
    // 修复前 headOf 固定截 80 字符，首轮短于 80 时比较永远不等，判定形同不存在。
    const shortFirst = '好的。';
    expect(checkContinuationSafety('好的。接着往下写新的内容。', st(shortFirst), 10)).toEqual({
      safe: true,
    });
  });

  it('③ 首轮长于阈值但短于 80 字符时判定仍然有效（修复点）', () => {
    // 25 字左右：≥ MIN_HEAD_FOR_RESTART(20) 但 < HEAD_LEN(80)。
    // 修复前这个区间是判定的盲区。
    const first = '我先说明这个方案的整体背景与设计动机所在。';
    expect(first.length).toBeGreaterThanOrEqual(20);
    expect(first.length).toBeLessThan(80);
    expect(checkContinuationSafety(first + '然后又重复了一遍。', st(first), 10)).toMatchObject({
      safe: false,
      reason: 'restarted_from_beginning',
    });
  });

  it('④ 尾部复读 → repeating_tail，并带出周期长度供诊断', () => {
    const unit = '我需要继续完成这个任务的剩余部分的内容。'; // 20 字，走「3 次」档
    expect(unit.length).toBeGreaterThanOrEqual(20);
    const v = checkContinuationSafety('正常开头。' + unit.repeat(3), st(), 10);
    expect(v).toMatchObject({ safe: false, reason: 'repeating_tail' });
    expect((v as { detail: number }).detail).toBeGreaterThan(0);
  });

  it('⑤ 连续低产 3 轮 → stalled；前两轮不停', () => {
    const tiny = '好的。';
    // 第 1、2 轮低产：计数累积但不停
    expect(checkContinuationSafety(tiny, st('首轮', { stalledStreak: 0 }), 10)).toEqual({ safe: true });
    expect(checkContinuationSafety(tiny, st('首轮', { stalledStreak: 1 }), 10)).toEqual({ safe: true });
    // 第 3 轮触发
    expect(checkContinuationSafety(tiny, st('首轮', { stalledStreak: 2 }), 10)).toMatchObject({
      safe: false,
      reason: 'stalled',
    });
  });

  it('⑤ 一次正常产出会清零 stalled 计数（偶发短输出不该累积）', () => {
    const s = advanceContinuation('这是一段足够长的正常续写内容，超过二十字符。', st('首轮', { stalledStreak: 2 }));
    expect(s.stalledStreak).toBe(0);
  });

  it('⑥ 达到次数上限 → max_continues', () => {
    expect(checkContinuationSafety('正常新内容。', st('首轮', { count: 9 }), 10)).toMatchObject({
      safe: false,
      reason: 'max_continues',
    });
  });

  it('maxContinues = 0 → 直接关闭自动续写', () => {
    expect(checkContinuationSafety('正常新内容。', st(), 0)).toMatchObject({
      safe: false,
      reason: 'max_continues',
    });
  });

  it('确定性判据优先于阈值判据：同时命中时报更根本的那条', () => {
    // 内容既与上轮完全相同、又是尾部复读；应报 identical_to_previous（更根本）
    const unit = '我需要继续完成这个任务的剩余部分内容。';
    const chunk = unit.repeat(3);
    const s = st('首轮', { lastChunk: chunk });
    expect(checkContinuationSafety(chunk, s, 10)).toMatchObject({
      safe: false,
      reason: 'identical_to_previous',
    });
  });
});

describe('advanceContinuation：状态推进', () => {
  it('累加轮数、记住本轮内容、保留首轮开头', () => {
    const s0 = initialContinuationState('首轮正文开头很长足够作为判据使用');
    const s1 = advanceContinuation('第二轮内容，这一段足够长不会触发龟速判定。', s0);
    expect(s1.count).toBe(1);
    expect(s1.lastChunk).toBe('第二轮内容，这一段足够长不会触发龟速判定。');
    expect(s1.firstHead).toBe(s0.firstHead);
    expect(s1.stalledStreak).toBe(0);
  });

  it('低产轮累加 stalledStreak', () => {
    let s = initialContinuationState('首轮');
    s = advanceContinuation('短。', s);
    s = advanceContinuation('也短。', s);
    expect(s.stalledStreak).toBe(2);
    expect(s.count).toBe(2);
  });

  it('是纯函数：不修改入参', () => {
    const s0 = initialContinuationState('首轮');
    const snapshot = JSON.stringify(s0);
    advanceContinuation('新内容，足够长的一段续写文本内容。', s0);
    expect(JSON.stringify(s0)).toBe(snapshot);
  });
});
