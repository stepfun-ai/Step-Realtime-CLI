/**
 * thinking 流死循环检测（纯函数，无 IO）。
 *
 * 思考型模型在难任务上会在 thinking 阶段反复输出同一段话，直到 max_tokens 耗尽。预算
 * 降档只在收到 stop_reason=max_tokens 时介入，本模块在流式中途提前检出，省掉无效 token。
 *
 * 看流末尾与更早内容的关系，避开中部合理的重复（代码/列表）：
 *  - 短周期：末尾存在周期 ≤ SHORT_PERIOD_MAX 的精确复读。
 *  - 长重复：末尾连续窗口在更早内容中紧凑周期出现（按平均间距判定，非散落引用）。
 * 维护累积文本，每次只扫尾部，O(1) 摊销；阈值从严，宁漏不误报。
 */

/** 检测窗口大小（字符）。取 100：对齐 Gemini CLI，减少中文巧合命中概率。 */
const WINDOW = 100;
/** 一个窗口在更早内容中出现 ≥ 该次数，计为「重复」。 */
const REPEAT_THRESHOLD = 5;
/** 距离比：平均间距 ≤ WINDOW × 该值 → 判定为周期性循环。
 *  取 2.0：4 次出现挤在 600 字符以内（67% 重复率）才算循环，几乎排除散落引用。 */
const DISTANCE_RATIO = 2.0;
/** 末尾连续命中窗口数 ≥ 该值，判定为「循环进行中」。2 个窗口 = 至少 200 字符仍在重复。 */
const CONSECUTIVE_TAIL_HITS = 3;
/** 短周期循环的最小重复次数：末尾周期 p 的单元重复 ≥ 该次数才判定。 */
const SHORT_PERIOD_MIN_REPEATS = 8;
/** 短周期的最大周期长度：超过即交给长重复路径。
 *  取 30：覆盖常见短语循环周期（如"这个方案的核心问题是"= 10 字符），
 *  同时不会误伤正常推理（30 字符精确重复 8 次 = 240 字符复读，正常思考不会这样）。 */
const SHORT_PERIOD_MAX = 30;
/** 触发检测的最小流长度：思考太短不可能成循环，避免开头误判。
 *  取 100：557 字符的 "elevation" 单字重复死循环（实测案例，调试包
 *  20260819054540）在 MIN_CHARS=1000 时根本没进入检测逻辑。降到 100 后
 *  短周期路径（p ∈ [1,30]，≥8 次）在 p=10 时末尾 80 字符全为复读单元，
 *  能正确命中。100 字符是正常推理的最小展开长度，不会误报。 */
const MIN_CHARS = 100;

export interface ThinkingLoopVerdict {
  /** 是否判定为死循环。 */
  looping: boolean;
  /** 命中的重复单元预览（截断），供提示文案展示。 */
  sample?: string;
  /** 重复次数（长重复路径的命中次数，或短周期路径的重复单元数）。 */
  repeats?: number;
}

/**
 * 思考流死循环检测器。每次 thinking_delta 到来时 ingest 增量文本，
 * 返回当前判定（只在状态翻转时由调用方消费，避免每帧都触发提示）。
 */
export function createThinkingLoopDetector(): {
  ingest: (delta: string) => ThinkingLoopVerdict;
  /** 当前累积的思考文本（供注入诱导时截取上下文）。 */
  text: () => string;
  reset: () => void;
} {
  let buf = '';
  let fired = false;

  function detect(): ThinkingLoopVerdict {
    if (buf.length < MIN_CHARS) return { looping: false };

    // --- 短周期循环（逐字复读）：末尾周期 p ∈ [1, SHORT_PERIOD_MAX] 的精确循环 ---
    for (let p = 1; p <= SHORT_PERIOD_MAX; p++) {
      if (buf.length < p * SHORT_PERIOD_MIN_REPEATS) break;
      const tail = buf.slice(-p * SHORT_PERIOD_MIN_REPEATS);
      const unit = tail.slice(0, p);
      let ok = true;
      for (let i = p; i < tail.length; i += p) {
        if (tail.slice(i, i + p) !== unit) {
          ok = false;
          break;
        }
      }
      if (ok) {
        return { looping: true, sample: unit, repeats: SHORT_PERIOD_MIN_REPEATS };
      }
    }

    // --- 长重复（段落级）：末尾连续 CONSECUTIVE_TAIL_HITS 个窗口各自在更早内容中重复 ---
    // 从尾向前取窗口，步长 WINDOW/2（重叠采样，避免窗口对齐恰好错过重复单元）。
    // 每个窗口不仅计数，还计算平均间距——只有紧凑周期排列才算命中（距离感知）。
    let consecutive = 0;
    let sample: string | undefined;
    let maxRepeats = 0;
    for (let end = buf.length; end - WINDOW >= MIN_CHARS / 2 && consecutive < CONSECUTIVE_TAIL_HITS; end -= Math.floor(WINDOW / 2)) {
      const win = buf.slice(end - WINDOW, end);
      const earlier = buf.slice(0, end - WINDOW);

      // 收集所有出现位置（上限 20，超过即停止收集——足够计算间距）
      const positions: number[] = [];
      let idx = earlier.indexOf(win);
      while (idx !== -1 && positions.length < 20) {
        positions.push(idx);
        idx = earlier.indexOf(win, idx + 1);
      }

      if (positions.length < REPEAT_THRESHOLD) break; // 出现次数不够 → 循环已停

      // 距离分析：计算相邻出现位置的平均间距
      let totalDist = 0;
      for (let i = 1; i < positions.length; i++) {
        totalDist += positions[i] - positions[i - 1];
      }
      const avgDist = totalDist / (positions.length - 1);

      maxRepeats = Math.max(maxRepeats, positions.length);

      if (avgDist <= WINDOW * DISTANCE_RATIO) {
        // 紧凑周期排列 → 命中
        consecutive++;
        sample = sample ?? win;
      } else {
        break; // 间距太大，是散落引用 → 不算循环
      }
    }
    if (consecutive >= CONSECUTIVE_TAIL_HITS) {
      return { looping: true, sample, repeats: maxRepeats };
    }
    return { looping: false };
  }

  return {
    ingest(delta: string): ThinkingLoopVerdict {
      buf += delta;
      if (fired) return { looping: false }; // 已触发过，本回合不再重复触发
      const v = detect();
      if (v.looping) fired = true;
      return v;
    },
    text: () => buf,
    reset: () => {
      buf = '';
      fired = false;
    },
  };
}
