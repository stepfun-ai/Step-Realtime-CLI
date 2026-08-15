import { describe, expect, it } from 'vitest';
import {
  STREAM_JSON_PROTOCOL_VERSION,
  SUBAGENT_SUMMARY_MAX,
  subagentTextLine,
  toSubagentStreamEvent,
  errorEventFromThrown,
  agentEventLine,
  sessionNotFoundEvent,
  resultEvent,
} from '../../src/session/streamJson.js';
import { resumeHintMeta } from '../../src/session/resumeHint.js';
import type { SubagentProgressEvent } from '../../src/agent/events.js';

/**
 * 回归依据：2026-08-02 发现 `-p --output-format stream-json` 下子 agent 事件全部丢失
 * （cli.ts onEvent 无条件写 stderr、丢弃 id、只处理 5 种 kind 中的 2 种）。
 * 本文件钉死修复后的三条契约：五种事件全覆盖、id 保留、信封判别式统一为顶层 type。
 */
describe('streamJson 子 agent 事件信封', () => {
  const all: SubagentProgressEvent[] = [
    { kind: 'start', subagentType: 'explore', description: '查资料' },
    { kind: 'tool', name: 'read_file' },
    { kind: 'usage', tokens: 1234 },
    { kind: 'error', message: 'boom' },
    { kind: 'end', isError: false },
  ];

  it('五种 kind 全部有映射，无遗漏', () => {
    const types = all.map((ev) => toSubagentStreamEvent('a1', ev).type);
    expect(types).toEqual([
      'subagent.start',
      'subagent.tool',
      'subagent.usage',
      'subagent.error',
      'subagent.end',
    ]);
  });

  it('id 存在时作为 subagent_id 保留（并行子 agent 归属锚点）', () => {
    for (const ev of all) {
      expect(toSubagentStreamEvent('a1', ev)).toHaveProperty('subagent_id', 'a1');
    }
  });

  it('id 缺省时省略字段而非填空串', () => {
    const ev = toSubagentStreamEvent(undefined, { kind: 'tool', name: 'bash' });
    expect(ev).not.toHaveProperty('subagent_id');
    expect(ev).toEqual({ type: 'subagent.tool', name: 'bash' });
  });

  it('字段名转 snake_case，隔离内部 camelCase 改名', () => {
    expect(toSubagentStreamEvent('a1', all[0])).toEqual({
      type: 'subagent.start',
      subagent_id: 'a1',
      subagent_type: 'explore',
      description: '查资料',
    });
    expect(toSubagentStreamEvent('a1', all[4])).toEqual({
      type: 'subagent.end',
      subagent_id: 'a1',
      is_error: false,
    });
  });

  it('每个事件可序列化为单行 JSON', () => {
    for (const ev of all) {
      expect(JSON.stringify(toSubagentStreamEvent('a1', ev))).not.toContain('\n');
    }
  });
});

describe('streamJson text 模式渲染', () => {
  it('只渲染 tool 与 error，保持 stdout 可管道', () => {
    expect(subagentTextLine({ kind: 'tool', name: 'read_file' })).toBe('  [subagent] read_file\n');
    expect(subagentTextLine({ kind: 'error', message: 'boom' })).toBe('  [subagent:error] boom\n');
  });

  it('start / usage / end 不进 text 输出', () => {
    expect(subagentTextLine({ kind: 'start', subagentType: 'explore', description: 'x' })).toBeNull();
    expect(subagentTextLine({ kind: 'usage', tokens: 1 })).toBeNull();
    expect(subagentTextLine({ kind: 'end', isError: false })).toBeNull();
  });
});

describe('stream-json 信封统一', () => {
  it('三个事件族共用顶层 type 判别式，无需第二套判别', () => {
    const events: Array<{ type: string }> = [
      toSubagentStreamEvent('a1', { kind: 'tool', name: 'bash' }),
      resumeHintMeta('s1'),
      // AgentEvent 本身即扁平 { type, ... }
      { type: 'text' },
    ];
    for (const ev of events) {
      expect(typeof ev.type).toBe('string');
      expect(ev.type.length).toBeGreaterThan(0);
    }
  });

  it('子 agent 事件不带已废弃的 role 字段', () => {
    expect(toSubagentStreamEvent('a1', { kind: 'tool', name: 'bash' })).not.toHaveProperty('role');
  });

  it('协议版本号已定义', () => {
    expect(STREAM_JSON_PROTOCOL_VERSION).toBe(3);
  });
});

describe('顶层异常转结构化 error 事件', () => {
  /**
   * 回归依据：2026-08-02 发现 `-p` 的 agent 循环无 try/catch，runPrint 顶层与调用点也没有，
   * 且全局无 unhandledRejection 兜底。任何冒泡异常 → Node 默认未捕获 rejection：
   * stream-json 消费方只拿到半截 JSON 流 + stderr 堆栈，收不到可判别的错误事件，
   * 且会话落盘与 resume 提示被整个跳过。
   */
  it('Error 抛出物取 message，并保留 cause 供子 agent runner 识别 429（对内元数据）', () => {
    const err = new Error('mid-stream failure');
    const ev = errorEventFromThrown(err);
    expect(ev.type).toBe('error');
    expect(ev.message).toBe('mid-stream failure');
    // 循环兜底路径的异常也要带 cause：子 agent runner 靠它识别 429 做重排队。
    // 对外 stream-json 由 agentEventLine 剥离（见下方「cause 剥离」describe），不泄漏认证。
    expect(ev.cause).toBe(err);
  });

  it('非 Error 抛出物（字符串/对象/undefined）一律 String 化，message 恒为字符串', () => {
    for (const thrown of ['plain string', { code: 500 }, undefined, null, 42]) {
      const ev = errorEventFromThrown(thrown);
      expect(ev.type).toBe('error');
      expect(typeof ev.message).toBe('string');
    }
  });

  it('产出的事件与 AgentEvent 同信封（顶层 type，可单行序列化）', () => {
    const ev = errorEventFromThrown(new Error('boom'));
    expect(ev.type).toBe('error');
    expect(JSON.stringify(ev)).not.toContain('\n');
  });

  it('中途异常场景：已产出的事件保留，错误追加在尾部而非丢弃整流', async () => {
    const events: Array<{ type: string }> = [];
    const emit = (ev: { type: string }): void => void events.push(ev);
    async function* boom(): AsyncGenerator<{ type: string; text?: string }> {
      yield { type: 'text', text: 'partial' };
      throw new Error('mid-stream failure');
    }
    try {
      for await (const ev of boom()) emit(ev);
    } catch (e) {
      emit(errorEventFromThrown(e));
    }
    expect(events.map((e) => e.type)).toEqual(['text', 'error']);
  });
});

describe('subagent.end 的信息量补齐（补 tool_uses / duration_ms 统计）', () => {
  it('summary / tool_uses / duration_ms 透传并转 snake_case', () => {
    expect(
      toSubagentStreamEvent('a1', {
        kind: 'end',
        isError: false,
        summary: '查完了，结论是 X',
        toolUses: 7,
        durationMs: 12345,
      }),
    ).toEqual({
      type: 'subagent.end',
      subagent_id: 'a1',
      is_error: false,
      summary: '查完了，结论是 X',
      tool_uses: 7,
      duration_ms: 12345,
    });
  });

  it('可选字段缺省时省略而非填 null（与 subagent_id 同一策略）', () => {
    const ev = toSubagentStreamEvent('a1', { kind: 'end', isError: true });
    expect(ev).toEqual({ type: 'subagent.end', subagent_id: 'a1', is_error: true });
    expect(ev).not.toHaveProperty('summary');
    expect(ev).not.toHaveProperty('tool_uses');
    expect(ev).not.toHaveProperty('duration_ms');
  });

  it('tool_uses 为 0 时仍输出（0 是有效值，不能被判空吞掉）', () => {
    const ev = toSubagentStreamEvent('a1', { kind: 'end', isError: false, toolUses: 0, durationMs: 0 });
    expect(ev).toHaveProperty('tool_uses', 0);
    expect(ev).toHaveProperty('duration_ms', 0);
  });

  it('含多行 summary 时仍可单行序列化（换行被 JSON 转义，不破坏逐行协议）', () => {
    const ev = toSubagentStreamEvent('a1', {
      kind: 'end',
      isError: false,
      summary: '第一行\n第二行\n第三行',
    });
    const line = JSON.stringify(ev);
    expect(line).not.toContain('\n');
    expect(JSON.parse(line).summary).toBe('第一行\n第二行\n第三行');
  });
});

describe('summary 截断与完整产出指针（逐行协议的行体积保护）', () => {
  it('超长 summary 被截断并置 summary_truncated，附 session_id 供取回全文', () => {
    const long = 'x'.repeat(SUBAGENT_SUMMARY_MAX + 200);
    const ev = toSubagentStreamEvent('a1', {
      kind: 'end',
      isError: false,
      summary: long,
      sessionId: 'sess-abc',
    }) as { summary: string; summary_truncated?: boolean; session_id?: string };
    expect(ev.summary).toHaveLength(SUBAGENT_SUMMARY_MAX + 1); // +1 为省略号
    expect(ev.summary.endsWith('…')).toBe(true);
    expect(ev.summary_truncated).toBe(true);
    expect(ev.session_id).toBe('sess-abc');
  });

  it('未超限时不截断，也不出现 summary_truncated 字段', () => {
    const ev = toSubagentStreamEvent('a1', { kind: 'end', isError: false, summary: '短结论' });
    expect(ev).toHaveProperty('summary', '短结论');
    expect(ev).not.toHaveProperty('summary_truncated');
  });

  it('恰好等于上限时不截断（边界不多砍一刀）', () => {
    const exact = 'y'.repeat(SUBAGENT_SUMMARY_MAX);
    const ev = toSubagentStreamEvent('a1', { kind: 'end', isError: false, summary: exact }) as {
      summary: string;
      summary_truncated?: boolean;
    };
    expect(ev.summary).toBe(exact);
    expect(ev.summary_truncated).toBeUndefined();
  });

  it('截断后单行 JSON 体积可控（实测子 agent 结论常达上千字符）', () => {
    const ev = toSubagentStreamEvent('a1', {
      kind: 'end',
      isError: false,
      summary: '真实结论'.repeat(500),
      sessionId: 's1',
      toolUses: 3,
      durationMs: 20914,
    });
    const line = JSON.stringify(ev);
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(1200);
  });
});

describe('error 事件的 cause 剥离（内部元数据不进对外流）', () => {
  it('cause 不出现在 wire 上——它可能挂着带认证头的 provider 响应对象', () => {
    const line = agentEventLine({
      type: 'error',
      message: 'rate limited',
      cause: { status: 429, headers: { authorization: 'Bearer sk-secret' } },
    });
    expect(line).not.toContain('authorization');
    expect(line).not.toContain('sk-secret');
    expect(line).not.toContain('cause');
    expect(JSON.parse(line)).toEqual({ type: 'error', message: 'rate limited' });
  });

  it('非 error 事件原样序列化（字段本就是对外契约）', () => {
    const ev = { type: 'tool_end', id: 'tu_1', name: 'read_file', result: 'ok', isError: false };
    expect(JSON.parse(agentEventLine(ev))).toEqual(ev);
  });

  it('输出恒为单行', () => {
    for (const ev of [
      { type: 'text', text: '多\n行\n文本' },
      { type: 'error', message: '换\n行', cause: new Error('x') },
    ]) {
      expect(agentEventLine(ev)).not.toContain('\n');
    }
  });
});

describe('session.not_found 事件', () => {
  it('结构包含 id、request_id 与 sessions_dir', () => {
    const ev = sessionNotFoundEvent('sess-abc', 'req-123', '/home/user/.step-code/sessions');
    expect(ev).toEqual({
      type: 'session.not_found',
      session_id: 'sess-abc',
      request_id: 'req-123',
      sessions_dir: '/home/user/.step-code/sessions',
    });
    expect(JSON.stringify(ev)).not.toContain('\n');
  });
});

describe('result 终态摘要事件', () => {
  it('success  subtype 结构完整', () => {
    const ev = resultEvent({
      text: '最终答复',
      durationMs: 4213,
      toolUses: 3,
      totalTokens: 9071,
      billedTotal: 5000,
      sessionId: '20260811-abc',
      subtype: 'success',
    });
    expect(ev).toEqual({
      type: 'result',
      subtype: 'success',
      text: '最终答复',
      durationMs: 4213,
      toolUses: 3,
      usage: { totalTokens: 9071, billedTotal: 5000 },
      sessionId: '20260811-abc',
    });
    expect(JSON.stringify(ev)).not.toContain('\n');
  });

  it('error subtype 在有错误事件时使用', () => {
    const ev = resultEvent({
      text: '部分完成',
      durationMs: 1000,
      toolUses: 1,
      totalTokens: 2000,
      billedTotal: 1500,
      sessionId: 's1',
      subtype: 'error',
    });
    expect(ev.subtype).toBe('error');
    expect(ev.type).toBe('result');
  });

  it('空文本与零 tool_uses 是有效值', () => {
    const ev = resultEvent({
      text: '',
      durationMs: 0,
      toolUses: 0,
      totalTokens: 0,
      billedTotal: 0,
      sessionId: 's1',
      subtype: 'success',
    });
    expect(ev.text).toBe('');
    expect(ev.toolUses).toBe(0);
  });
});
