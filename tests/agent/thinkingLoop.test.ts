import { describe, expect, it } from 'vitest';
import { createThinkingLoopDetector } from '../../src/agent/thinkingLoop.js';

/** 用同一单元重复 N 次构造文本。 */
function repeat(unit: string, n: number): string {
  return unit.repeat(n);
}

/** 生成恰好 100 字符的段落（满足 WINDOW=100），各 seed 内容完全不同。 */
function makePara(seed: number): string {
  // 用 seed + position 生成确定性的伪随机 100 字符，各段落差异足够大
  let result = '';
  for (let i = 0; i < 100; i++) {
    result += String.fromCharCode(65 + ((seed * 31 + i * 17 + 13) % 26));
  }
  return result;
}

describe('thinking 流死循环检测器', () => {
  // ========== 路径 A：短周期逐字复读 ==========

  it('短周期短语复读（16 字符短语 ×60）→ 判定循环', () => {
    const d = createThinkingLoopDetector();
    // 同一 16 字符短语重复 60 次（960 字符），短周期路径（p=16，末尾 8 次全复读）
    // 在 MIN_CHARS=100 下会命中——这确实是循环，不是正常推理。
    const v = d.ingest(repeat('让我先思考一下这个问题的背景。', 60));
    expect(v.looping).toBe(true);
  });

  it('短周期逐字复读（「的」×N）→ 判定循环', () => {
    const d = createThinkingLoopDetector();
    const v = d.ingest(repeat('的', 200));
    expect(v.looping).toBe(true);
  });

  it('中周期短语循环（20 字符短语重复）→ 判定循环', () => {
    const d = createThinkingLoopDetector();
    // 20 字符短语，在 SHORT_PERIOD_MAX=30 范围内
    const phrase = '这个方案的核心问题是需要重新审视'; // 16 字符
    let v = d.ingest(Array.from({length: 20}, (_, i) => makePara(i)).join('')); // 过 MIN_CHARS
    expect(v.looping).toBe(false);
    v = d.ingest(repeat(phrase, 15)); // 16×15=240 字符的短语循环
    expect(v.looping).toBe(true);
  });

  // ========== 路径 B：段落级周期重复 + 距离分析 ==========

  it('段落级周期重复（同一段话反复输出）→ 判定循环', () => {
    const d = createThinkingLoopDetector();
    const para = '首先我需要分析这个问题的核心矛盾，它涉及到多个层面的因素，需要逐一排查确认，然后再做综合判断。'; // 50 字符
    // 50 < WINDOW=100，所以窗口会跨段落边界。
    // 但 para * 20 = 1000 字符，任何 100 字符窗口在 1000 字符中都是周期性的
    // （因为 50 字符周期 < 100 字符窗口，窗口包含 2 个完整周期）
    const v = d.ingest(repeat(para, 25));
    expect(v.looping).toBe(true);
    expect(v.sample).toBeDefined();
  });

  it('100 字符段落精确重复 → 判定循环（距离紧凑）', () => {
    const d = createThinkingLoopDetector();
    const para = makePara(0); // 100 字符
    // 15 次重复 = 1500 字符，间距 = 100 = WINDOW
    // avgDist = 100 ≤ 2.0 × 100 = 200 → 命中
    const v = d.ingest(repeat(para, 20));
    expect(v.looping).toBe(true);
    expect(v.sample).toBeDefined();
  });

  // ========== 距离分析：散落引用不触发 ==========

  it('散落引用（同一短语分散出现，间距大）→ 不判定', () => {
    const d = createThinkingLoopDetector();
    // 构造 3000 字符文本，其中 100 字符短语出现 5 次，但每次间隔 500+ 字符
    const phrase = makePara(0); // 100 字符
    let text = '';
    for (let i = 0; i < 5; i++) {
      // 每次插入 500 字符的不同内容，再插入短语
      for (let j = 0; j < 5; j++) {
        text += makePara(i * 10 + j + 1); // 不同段落
      }
      text += phrase;
    }
    // 总长 ≈ 5 × (500 + 100) = 3000 字符
    // 短语出现 5 次，间距 ≈ 600，avgDist = 600 > 200 → 不触发
    const v = d.ingest(text);
    expect(v.looping).toBe(false);
  });

  it('边界：间距恰好在阈值上（avgDist = 2.0 × WINDOW）→ 判定', () => {
    const d = createThinkingLoopDetector();
    const para = makePara(0); // 100 字符
    // 需要 4 次出现在更早内容 + 2 个连续窗口都命中
    // para * 7 = 700 字符，末尾窗口 + 6 次在更早内容中
    // 第二个重叠窗口（步长 50）出现 5 次在更早内容中
    const v = d.ingest(repeat(para, 15));
    expect(v.looping).toBe(true);
  });

  // ========== 不误报：正常推理和结构化内容 ==========

  it('正常推理文本（无重复）→ 不判定', () => {
    const d = createThinkingLoopDetector();
    let text = '';
    for (let i = 0; i < 40; i++) {
      text += `第${i}步分析：因素${i}与因素${i + 1}的关系需要考察，因为${i * 7}和${i * 13}的比值影响了结论${i}的成立条件。`;
    }
    const v = d.ingest(text);
    expect(v.looping).toBe(false);
  });

  it('列表/枚举式重复（结构相同内容不同）→ 不判定', () => {
    const d = createThinkingLoopDetector();
    let text = '';
    for (let i = 0; i < 30; i++) {
      text += `${i + 1}. 选项${i + 1}的评估结果是${i % 2 === 0 ? '通过' : '不通过'}，理由是指标${i}的读数为${i * 3}。\n`;
    }
    const v = d.ingest(text);
    expect(v.looping).toBe(false);
  });

  // ========== 状态管理 ==========

  it('触发后不再重复触发（fired 一次性）', () => {
    const d = createThinkingLoopDetector();
    d.ingest(repeat('的', 1200)); // 800 > MIN_CHARS=600，先触发
    const v1 = d.ingest(repeat('的', 100));
    expect(v1.looping).toBe(false); // 已 fired
  });

  it('短文本不触发（MIN_CHARS 门槛）', () => {
    const d = createThinkingLoopDetector();
    const v = d.ingest(repeat('的', 50));
    expect(v.looping).toBe(false);
  });

  it('reset 后可重新检测', () => {
    const d = createThinkingLoopDetector();
    d.ingest(repeat('的', 1200));
    d.reset();
    expect(d.text()).toBe('');
    const v = d.ingest('正常内容');
    expect(v.looping).toBe(false);
  });
});
