import { describe, expect, it, vi, afterEach } from 'vitest';
import type { AgentEvent } from '../../src/agent/events.js';
import { StreamBuffer } from '../../src/chat/streamBuffer.js';

/** 收集 apply 到的事件。 */
function collector(): { events: AgentEvent[]; apply: (ev: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, apply: (ev) => events.push(ev) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('StreamBuffer 流式节流', () => {
  it('高频 text 合帧：50ms 窗口内多条 text 合并为一次 apply', () => {
    vi.useFakeTimers();
    const { events, apply } = collector();
    const buf = new StreamBuffer(apply);
    buf.ingest({ type: 'text', text: '你' });
    buf.ingest({ type: 'text', text: '好' });
    buf.ingest({ type: 'text', text: '，' });
    buf.ingest({ type: 'text', text: '世界' });
    // 窗口内：尚未 flush，apply 未被调用
    expect(events).toHaveLength(0);
    // 推进 50ms 触发定时 flush
    vi.advanceTimersByTime(50);
    // 合并成一条 text 事件
    expect(events).toEqual([{ type: 'text', text: '你好，世界' }]);
  });

  it('thinking_delta 与 text 混流：按喂入顺序吐出，同类相邻才合并', () => {
    vi.useFakeTimers();
    const { events, apply } = collector();
    const buf = new StreamBuffer(apply);
    buf.ingest({ type: 'thinking_delta', text: '想一' });
    buf.ingest({ type: 'text', text: '正文' });
    buf.ingest({ type: 'thinking_delta', text: '想二' });
    vi.advanceTimersByTime(50);
    // 段序 = 喂入序。「想一」与「想二」中间隔了 text，不跨段合并
    expect(events).toEqual([
      { type: 'thinking_delta', text: '想一' },
      { type: 'text', text: '正文' },
      { type: 'thinking_delta', text: '想二' },
    ]);
  });

  it('回归：思考尾巴与正文开头落在同一窗口时，thinking 必须先于 text（think 泄漏根因）', () => {
    vi.useFakeTimers();
    const { events, apply } = collector();
    const buf = new StreamBuffer(apply);
    // 真实时序：模型思考收尾的同一 50ms 内正文已经开始吐字
    buf.ingest({ type: 'thinking_delta', text: '现在可以给用户汇报了' });
    buf.ingest({ type: 'text', text: '两个 README 都写好了' });
    vi.advanceTimersByTime(50);
    // 旧实现按「text 先、thinking 后」硬编码吐出，下游据此把思考尾巴落成
    // 排在正文之后的第二个 thinking 块，正文还会被劈成两段
    expect(events.map((e) => e.type)).toEqual(['thinking_delta', 'text']);
  });

  it('相邻同类仍合并为一条（合帧收益不因保序而丢失）', () => {
    vi.useFakeTimers();
    const { events, apply } = collector();
    const buf = new StreamBuffer(apply);
    buf.ingest({ type: 'thinking_delta', text: '想' });
    buf.ingest({ type: 'thinking_delta', text: '一想' });
    buf.ingest({ type: 'text', text: '正' });
    buf.ingest({ type: 'text', text: '文' });
    vi.advanceTimersByTime(50);
    expect(events).toEqual([
      { type: 'thinking_delta', text: '想一想' },
      { type: 'text', text: '正文' },
    ]);
  });

  it('usage 只保留最新一条，随下一次 flush 带出', () => {
    vi.useFakeTimers();
    const { events, apply } = collector();
    const buf = new StreamBuffer(apply);
    buf.ingest({ type: 'usage', totalTokens: 100 });
    buf.ingest({ type: 'usage', totalTokens: 250 });
    vi.advanceTimersByTime(50);
    expect(events).toEqual([{ type: 'usage', totalTokens: 250 }]);
  });

  it('结构事件（tool_start）立即消费，且先把缓冲残篇吐净（顺序：text 在前 tool 在后）', () => {
    vi.useFakeTimers();
    const { events, apply } = collector();
    const buf = new StreamBuffer(apply);
    buf.ingest({ type: 'text', text: '残篇' });
    // 未等到 50ms，结构事件立即触发 flushNow + 消费
    buf.ingest({ type: 'tool_start', id: 't1', name: 'bash', input: {} });
    // 不等 timer，已立即产出：先 text 残篇，再 tool_start
    expect(events).toEqual([
      { type: 'text', text: '残篇' },
      { type: 'tool_start', id: 't1', name: 'bash', input: {} },
    ]);
  });

  it('error 边界事件立即 flush：最后一帧不丢', () => {
    vi.useFakeTimers();
    const { events, apply } = collector();
    const buf = new StreamBuffer(apply);
    buf.ingest({ type: 'text', text: '半截' });
    buf.ingest({ type: 'error', message: 'boom' });
    expect(events).toEqual([
      { type: 'text', text: '半截' },
      { type: 'error', message: 'boom' },
    ]);
  });

  it('drain 强制吐净缓冲（回合收尾最后一帧不丢），幂等', () => {
    vi.useFakeTimers();
    const { events, apply } = collector();
    const buf = new StreamBuffer(apply);
    buf.ingest({ type: 'text', text: '尾巴' });
    buf.drain();
    expect(events).toEqual([{ type: 'text', text: '尾巴' }]);
    // 再 drain 无副作用
    buf.drain();
    expect(events).toHaveLength(1);
  });

  it('drain 后不再触发残留定时器（不会重复 flush）', () => {
    vi.useFakeTimers();
    const { events, apply } = collector();
    const buf = new StreamBuffer(apply);
    buf.ingest({ type: 'text', text: 'x' });
    buf.drain();
    // 推进时间，原定时器已清，不应再有产出
    vi.advanceTimersByTime(200);
    expect(events).toEqual([{ type: 'text', text: 'x' }]);
  });

  it('timer 不重复设置：连续 ingest 只排一个定时器（不会一事件一定时器）', () => {
    vi.useFakeTimers();
    const { events, apply } = collector();
    const buf = new StreamBuffer(apply, { flushMs: 50 });
    buf.ingest({ type: 'text', text: 'a' });
    buf.ingest({ type: 'text', text: 'b' });
    buf.ingest({ type: 'text', text: 'c' });
    // 推进足够长：只有一个 flush 周期触发，三条合并为一次 apply
    vi.advanceTimersByTime(100);
    expect(events).toEqual([{ type: 'text', text: 'abc' }]);
  });

  it('空缓冲的 flushNow / drain 不调用 apply', () => {
    const { events, apply } = collector();
    const buf = new StreamBuffer(apply);
    buf.flushNow();
    buf.drain();
    expect(events).toHaveLength(0);
  });
});
