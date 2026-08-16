/**
 * thinking 块与正文块的**块序**回归。
 *
 * 与 `streamBuffer.test.ts` 的分工：那边断言事件序（StreamBuffer 吐给下游的顺序），
 * 这边断言块序（用户在屏幕上看到的顺序）。事件序对但落块规则错、或落块规则对但事件序错，
 * 都会表现成同一个现象——thinking 文本泄漏到正文附近、正文被劈成两段。所以两层都要测。
 *
 * 用真实 Transcript + 真实 StreamBuffer + 真实 reducer 串起来跑，只把 PiChat 里那些
 * 纯副作用（activity spinner、状态栏数字、重绘请求）省掉——PiChat 本体构造时会
 * `new ProcessTerminal()` 摸真实 tty，测试环境实例化不了。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { AgentEvent } from '../../src/agent/events.js';
import { StreamBuffer } from '../../src/chat/streamBuffer.js';
import { appendText, settleThinking } from '../../src/chat/streamReducer.js';
import { Transcript } from '../../src/tui-pi/Transcript.js';

afterEach(() => {
  vi.useRealTimers();
});

/**
 * PiChat.applyEvent 的块序部分（副作用剥离版）。改 PiChat 那段逻辑时这里要同步，
 * 两边都只剩三行，漂移风险低于「为了可测把 PiChat 拆散」的代价。
 *
 * `finishTurn` 对应 PiChat 的 `finally { streamBuffer.drain(); ...兜底 settle }`：
 * 回合收尾时把残留思考落块。`pendingThinking` 只为测试能直接看见「残留」这个中间态。
 */
function makeApply(t: Transcript): {
  apply: (ev: AgentEvent) => void;
  finishTurn: () => void;
  pendingThinking: () => string;
} {
  let accum = '';
  return {
    apply(ev: AgentEvent): void {
      if (ev.type === 'thinking_start') return;
      if (ev.type === 'thinking_delta') {
        accum += ev.text;
        return;
      }
      if (ev.type === 'usage') return; // 状态数字，不终结思考段
      if (settleThinking(t, accum)) accum = '';
      if (ev.type === 'thinking_end') return;
      if (ev.type === 'text') appendText(t, ev.text);
      if (ev.type === 'tool_start') {
        t.push({ kind: 'tool', id: ev.id, name: ev.name, input: ev.input, status: 'running', startedAt: 0 });
      }
    },
    finishTurn(): void {
      if (settleThinking(t, accum)) accum = '';
    },
    pendingThinking(): string {
      return accum;
    },
  };
}

/** 块序摘要：kind:文本前若干字，便于直观断言。 */
function seq(t: Transcript): string[] {
  return t.items().map((it) => {
    if (it.kind === 'thinking' || it.kind === 'assistant') return `${it.kind}:${it.text}`;
    return it.kind;
  });
}

describe('thinking 与正文的块序', () => {
  it('思考尾巴与正文开头同窗口：thinking 块在正文块之前，正文不被劈开', () => {
    vi.useFakeTimers();
    const t = new Transcript();
    const buf = new StreamBuffer(makeApply(t).apply);
    buf.ingest({ type: 'thinking_start' });
    buf.ingest({ type: 'thinking_delta', text: '两个 README 都写好了，' });
    // 同一 50ms 窗口内思考收尾、正文开始
    buf.ingest({ type: 'thinking_delta', text: '现在可以给用户汇报了' });
    buf.ingest({ type: 'text', text: '两个 README 都写好了，' });
    vi.advanceTimersByTime(50);
    buf.ingest({ type: 'text', text: '没有重复文件。' });
    vi.advanceTimersByTime(50);
    buf.drain();
    // 修复前：assistant 先落块，思考尾巴另起 thinking 块排在它之后，
    // 后续正文因末块不是 assistant 又新开一块 → 三块且顺序错乱
    expect(seq(t)).toEqual([
      'thinking:两个 README 都写好了，现在可以给用户汇报了',
      'assistant:两个 README 都写好了，没有重复文件。',
    ]);
  });

  it('思考全程独占窗口时同样只落一个 thinking 块', () => {
    vi.useFakeTimers();
    const t = new Transcript();
    const buf = new StreamBuffer(makeApply(t).apply);
    buf.ingest({ type: 'thinking_delta', text: '想' });
    vi.advanceTimersByTime(50);
    buf.ingest({ type: 'thinking_delta', text: '一想' });
    vi.advanceTimersByTime(50);
    buf.ingest({ type: 'text', text: '结论' });
    buf.drain();
    expect(seq(t)).toEqual(['thinking:想一想', 'assistant:结论']);
  });

  it('usage 夹在思考中间不切断思考段（一段思考仍是一块）', () => {
    vi.useFakeTimers();
    const t = new Transcript();
    const buf = new StreamBuffer(makeApply(t).apply);
    buf.ingest({ type: 'thinking_delta', text: '前半' });
    buf.ingest({ type: 'usage', totalTokens: 1200 });
    vi.advanceTimersByTime(50);
    buf.ingest({ type: 'thinking_delta', text: '后半' });
    buf.ingest({ type: 'text', text: '正文' });
    buf.drain();
    expect(seq(t)).toEqual(['thinking:前半后半', 'assistant:正文']);
  });

  it('工具调用打断：思考 → 工具 → 思考 → 正文，四块按序（interleaved thinking）', () => {
    vi.useFakeTimers();
    const t = new Transcript();
    const buf = new StreamBuffer(makeApply(t).apply);
    buf.ingest({ type: 'thinking_delta', text: '先查文件' });
    // 结构事件立即消费，先把思考残篇吐净
    buf.ingest({ type: 'tool_start', id: 't1', name: 'read_file', input: {} });
    buf.ingest({ type: 'thinking_delta', text: '看懂了' });
    buf.ingest({ type: 'text', text: '结论是' });
    vi.advanceTimersByTime(50);
    buf.drain();
    expect(seq(t)).toEqual(['thinking:先查文件', 'tool', 'thinking:看懂了', 'assistant:结论是']);
  });

  it('多段正文连续追加时续接同一块，不因合帧新开块', () => {
    vi.useFakeTimers();
    const t = new Transcript();
    const buf = new StreamBuffer(makeApply(t).apply);
    buf.ingest({ type: 'text', text: '一' });
    vi.advanceTimersByTime(50);
    buf.ingest({ type: 'text', text: '二' });
    vi.advanceTimersByTime(50);
    buf.ingest({ type: 'text', text: '三' });
    buf.drain();
    expect(seq(t)).toEqual(['assistant:一二三']);
  });
});

describe('回合边界：思考不得跨回合滞留', () => {
  /**
   * 这一族是真机才暴露的形态：块序在回合**内**全对，错的是回合**之间**。
   *
   * drain() 只把 StreamBuffer 缓冲吐给 apply，thinking_delta 到了 apply 里仍只累积不落块
   * （落块靠下一个内容流事件触发 settle）。所以「本回合最后一批事件是思考」时 accum 残留，
   * 下一轮首个 text 才 settle——那一刻末块已是新一轮的 user 消息，思考块落在它之后。
   */
  it('回合以思考结尾（流断在思考中、没有 turn_done）：收尾兜底落块，不滞留', () => {
    vi.useFakeTimers();
    const t = new Transcript();
    const a = makeApply(t);
    const buf = new StreamBuffer(a.apply);
    buf.ingest({ type: 'thinking_start' });
    buf.ingest({ type: 'thinking_delta', text: '想到这里流就断了' });
    buf.drain();
    // 复现残留这个中间态：缓冲已吐净，但思考仍未落块
    expect(a.pendingThinking(), 'drain 只吐缓冲，不负责落块').toBe('想到这里流就断了');
    expect(seq(t)).toEqual([]);
    // PiChat 的 finally 兜底
    a.finishTurn();
    expect(seq(t)).toEqual(['thinking:想到这里流就断了']);
    expect(a.pendingThinking()).toBe('');
  });

  it('无兜底时残留会插到下一轮 user 之后（这就是被报的「思考泄漏」形态）', () => {
    vi.useFakeTimers();
    const t = new Transcript();
    const a = makeApply(t);
    const buf = new StreamBuffer(a.apply);
    buf.ingest({ type: 'thinking_delta', text: '上一轮的思考尾巴' });
    buf.drain();
    // 故意不调 finishTurn，模拟修复前的行为
    t.push({ kind: 'user', text: '下一轮提问' });
    buf.ingest({ type: 'text', text: '这一轮的回答' });
    buf.drain();
    // 上一轮的思考块排在了这一轮 user 之后——顺序错乱的确切形态
    expect(seq(t)).toEqual(['user', 'thinking:上一轮的思考尾巴', 'assistant:这一轮的回答']);
  });

  it('有兜底时同样的序列顺序正确（思考在本轮、user 在后）', () => {
    vi.useFakeTimers();
    const t = new Transcript();
    const a = makeApply(t);
    const buf = new StreamBuffer(a.apply);
    buf.ingest({ type: 'thinking_delta', text: '上一轮的思考尾巴' });
    buf.drain();
    a.finishTurn();
    t.push({ kind: 'user', text: '下一轮提问' });
    buf.ingest({ type: 'text', text: '这一轮的回答' });
    buf.drain();
    expect(seq(t)).toEqual(['thinking:上一轮的思考尾巴', 'user', 'assistant:这一轮的回答']);
  });

  it('正常收尾（turn_done 已 settle）时兜底是空操作，不重复落块', () => {
    vi.useFakeTimers();
    const t = new Transcript();
    const a = makeApply(t);
    const buf = new StreamBuffer(a.apply);
    buf.ingest({ type: 'thinking_delta', text: '想' });
    buf.ingest({ type: 'text', text: '答' });
    buf.drain();
    a.finishTurn();
    a.finishTurn(); // 幂等
    expect(seq(t)).toEqual(['thinking:想', 'assistant:答']);
  });
});
