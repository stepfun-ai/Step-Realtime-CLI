import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import {
  createRoundLoopDetector,
  fingerprintRound,
  type RoundLoopVerdict,
} from '../../src/agent/roundLoop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { runAgent } from '../../src/agent/loop.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';

/* ------------------------------------------------------------------ */
/* 测试辅助                                                           */
/* ------------------------------------------------------------------ */

/** 构造一条 StoredMessage（测试用，id/ts 不影响指纹）。 */
function sm(
  message: Anthropic.MessageParam,
  origin: 'user' | 'assistant' | 'tool' = 'user',
): StoredMessage {
  return stored(message, { kind: origin });
}

/** 构造 tool_result user 消息块。 */
function toolResultBlock(
  toolUseId: string,
  content: string | Anthropic.ToolResultContentBlock[],
  isError = false,
): Anthropic.ToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError };
}

/**
 * 造一条完整的「原始 user → assistant → tool_result user」消息序列（作为 messages 尾部）。
 *
 * 顺序与 runTurn 运行时完全一致：
 *   用户输入 → runTurn 产出 assistant(tool_use) → 工具执行 → push tool_result user 消息
 * 即 messages 尾部为 [原始user, assistant(tool_use), tool_result_user]。
 *
 * @param assistantContent  assistant 消息的 content 块数组
 * @param results           tool_result 块数组
 * @param priorUser         原始 user 消息内容（缺省为通用搜索指令）
 */
function makeRound(
  assistantContent: Anthropic.ContentBlock[],
  results: Anthropic.ToolResultBlockParam[],
  priorUser: Anthropic.MessageParam = { role: 'user', content: '请帮我搜索文件。' },
): StoredMessage[] {
  return [
    sm(priorUser, 'user'),
    sm({ role: 'assistant', content: assistantContent }, 'assistant'),
    sm({ role: 'user', content: results }, 'tool'),
  ];
}

/* ------------------------------------------------------------------ */
/* fingerprintRound：指纹生成                                        */
/* ------------------------------------------------------------------ */

describe('fingerprintRound：指纹生成', () => {
  it('基本形态：text 块 + 单个 tool_use + 字符串 tool_result', () => {
    const messages = makeRound(
      [textBlock('我来搜索。'), toolUseBlock('c1', 'grep', { query: 'foo' })],
      [toolResultBlock('c1', '找到了 3 处匹配。')],
    );
    const f1 = fingerprintRound(messages);
    expect(f1).not.toBeNull();
    expect(f1).toContain('我来搜索。');
    expect(f1).toContain('grep');
    expect(f1).toContain(JSON.stringify({ query: 'foo' }));
    expect(f1).toContain('找到了 3 处匹配。');
    // id 不在指纹里
    expect(f1).not.toContain(messages[2]!.id);
  });

  it('tool_use id 不参与指纹（不同 id 但其余相同 → 指纹相同）', () => {
    const msgsA = makeRound(
      [textBlock('搜索中。'), toolUseBlock('id-A', 'grep', { query: 'foo' })],
      [toolResultBlock('id-A', '3 处匹配。')],
    );
    const msgsB = makeRound(
      [textBlock('搜索中。'), toolUseBlock('id-B', 'grep', { query: 'foo' })],
      [toolResultBlock('id-B', '3 处匹配。')],
    );
    expect(fingerprintRound(msgsA)).toBe(fingerprintRound(msgsB));
  });

  it('tool_use name 变化 → 指纹不同', () => {
    const msgsA = makeRound(
      [textBlock('搜索。'), toolUseBlock('c1', 'grep', { query: 'foo' })],
      [toolResultBlock('c1', '3 处匹配。')],
    );
    const msgsB = makeRound(
      [textBlock('搜索。'), toolUseBlock('c1', 'read_file', { path: 'x.ts' })],
      [toolResultBlock('c1', '文件内容。')],
    );
    expect(fingerprintRound(msgsA)).not.toBe(fingerprintRound(msgsB));
  });

  it('tool_use input 变化 → 指纹不同', () => {
    const msgsA = makeRound(
      [textBlock('搜索。'), toolUseBlock('c1', 'grep', { query: 'foo' })],
      [toolResultBlock('c1', '3 处匹配。')],
    );
    const msgsB = makeRound(
      [textBlock('搜索。'), toolUseBlock('c1', 'grep', { query: 'bar' })],
      [toolResultBlock('c1', '3 处匹配。')],
    );
    expect(fingerprintRound(msgsA)).not.toBe(fingerprintRound(msgsB));
  });

  it('tool_result content 变化 → 指纹不同', () => {
    const msgsA = makeRound(
      [textBlock('搜索。'), toolUseBlock('c1', 'grep', { query: 'foo' })],
      [toolResultBlock('c1', '3 处匹配。')],
    );
    const msgsB = makeRound(
      [textBlock('搜索。'), toolUseBlock('c1', 'grep', { query: 'foo' })],
      [toolResultBlock('c1', '5 处匹配。')],
    );
    expect(fingerprintRound(msgsA)).not.toBe(fingerprintRound(msgsB));
  });

  it('tool_result content 相同 → 指纹相同', () => {
    const msgsA = makeRound(
      [textBlock('搜索。'), toolUseBlock('c1', 'grep', { query: 'foo' })],
      [toolResultBlock('c1', '3 处匹配。')],
    );
    const msgsB = makeRound(
      [textBlock('搜索。'), toolUseBlock('c1', 'grep', { query: 'foo' })],
      [toolResultBlock('c1', '3 处匹配。')],
    );
    expect(fingerprintRound(msgsA)).toBe(fingerprintRound(msgsB));
  });

  it('assistant text 块变化 → 指纹不同', () => {
    const msgsA = makeRound(
      [textBlock('我来搜索。'), toolUseBlock('c1', 'grep', { query: 'foo' })],
      [toolResultBlock('c1', '3 处匹配。')],
    );
    const msgsB = makeRound(
      [textBlock('我来读取。'), toolUseBlock('c1', 'grep', { query: 'foo' })],
      [toolResultBlock('c1', '3 处匹配。')],
    );
    expect(fingerprintRound(msgsA)).not.toBe(fingerprintRound(msgsB));
  });

  it('is_error=true 参与指纹：错误复读也是复读', () => {
    const msgsA = makeRound(
      [textBlock('执行。'), toolUseBlock('c1', 'bash', { cmd: 'ls' })],
      [toolResultBlock('c1', 'command not found', true)],
    );
    const msgsB = makeRound(
      [textBlock('执行。'), toolUseBlock('c1', 'bash', { cmd: 'ls' })],
      [toolResultBlock('c1', 'command not found', false)], // is_error 不同
    );
    expect(fingerprintRound(msgsA)).not.toBe(fingerprintRound(msgsB));
  });

  it('is_error 相同 → 指纹相同', () => {
    const msgsA = makeRound(
      [textBlock('执行。'), toolUseBlock('c1', 'bash', { cmd: 'ls' })],
      [toolResultBlock('c1', 'command not found', true)],
    );
    const msgsB = makeRound(
      [textBlock('执行。'), toolUseBlock('c1', 'bash', { cmd: 'ls' })],
      [toolResultBlock('c1', 'command not found', true)],
    );
    expect(fingerprintRound(msgsA)).toBe(fingerprintRound(msgsB));
  });

  it('多工具并行：按数组顺序稳定拼接', () => {
    const msgs = makeRound(
      [
        textBlock('并行搜索。'),
        toolUseBlock('c1', 'grep', { query: 'foo' }),
        toolUseBlock('c2', 'grep', { query: 'bar' }),
      ],
      [
        toolResultBlock('c1', 'foo 结果'),
        toolResultBlock('c2', 'bar 结果'),
      ],
    );
    const f = fingerprintRound(msgs);
    expect(f).not.toBeNull();
    const idxFoo = f!.indexOf('foo 结果');
    const idxBar = f!.indexOf('bar 结果');
    expect(idxFoo).toBeGreaterThanOrEqual(0);
    expect(idxBar).toBeGreaterThanOrEqual(0);
    expect(idxFoo).toBeLessThan(idxBar);
  });

  it('tool_result 块数组形态：取所有 text 块拼接', () => {
    const innerBlocks: Anthropic.ToolResultContentBlock[] = [
      { type: 'text', text: '第一部分' },
      { type: 'text', text: '第二部分' },
    ];
    const msgs = makeRound(
      [textBlock('搜索。'), toolUseBlock('c1', 'grep', { query: 'foo' })],
      [toolResultBlock('c1', innerBlocks)],
    );
    expect(fingerprintRound(msgs)).toContain('第一部分第二部分');
  });

  it('tool_result 块数组含图片块：只取 text 块，图片块不参与', () => {
    const innerBlocks: Anthropic.ToolResultContentBlock[] = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BASE64IMG' } },
      { type: 'text', text: '有图结果' },
    ];
    const msgs = makeRound(
      [textBlock('看图。'), toolUseBlock('c1', 'read_media', { path: 'photo.png' })],
      [toolResultBlock('c1', innerBlocks)],
    );
    expect(fingerprintRound(msgs)).toContain('有图结果');
    expect(fingerprintRound(msgs)).not.toContain('BASE64IMG');
  });

  it('空 tool_result（无 content）记为空串，不崩溃', () => {
    const msgs = makeRound(
      [textBlock('搜索。'), toolUseBlock('c1', 'grep', { query: 'foo' })],
      [{ type: 'tool_result', tool_use_id: 'c1' } as Anthropic.ToolResultBlockParam],
    );
    expect(fingerprintRound(msgs)).not.toBeNull();
  });

  it('尾部不是 assistant → null', () => {
    const messages = [
      sm({ role: 'user', content: 'hi' }, 'user'),
      sm({ role: 'user', content: 'tool result' }, 'tool'),
    ];
    expect(fingerprintRound(messages)).toBeNull();
  });

  it('assistant 后不是 user（缺 tool_result）→ null', () => {
    const messages = [
      sm({ role: 'user', content: 'hi' }, 'user'),
      sm({ role: 'assistant', content: [textBlock('ok')] }, 'assistant'),
      sm({ role: 'assistant', content: [textBlock('又一轮 assistant')] }, 'assistant'),
    ];
    expect(fingerprintRound(messages)).toBeNull();
  });

  it('空 messages → null', () => {
    expect(fingerprintRound([])).toBeNull();
  });

  it('仅 1 条消息 → null', () => {
    expect(fingerprintRound([sm({ role: 'user', content: 'hi' }, 'user')])).toBeNull();
  });

  it('assistant 无有效 content（空数组）→ null', () => {
    const messages = [
      sm({ role: 'user', content: 'hi' }, 'user'),
      sm({ role: 'assistant', content: [] }, 'assistant'),
      sm({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] }, 'tool'),
    ];
    expect(fingerprintRound(messages)).toBeNull();
  });

  it('assistant 只有 text 无 tool_use → 指纹只含 text', () => {
    const messages = [
      sm({ role: 'user', content: 'hi' }, 'user'),
      sm({ role: 'assistant', content: [textBlock('纯文本回复。')] }, 'assistant'),
      sm({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] }, 'tool'),
    ];
    const f = fingerprintRound(messages);
    expect(f).toBe('t:纯文本回复。||o:ok');
  });

  it('消息 ts 与 id 不同（同内容）→ 指纹相同', () => {
    // 两条消息的内容完全相同，只有 id/ts 不同（stored() 自动生成）
    const msgsA = makeRound(
      [textBlock('搜索。'), toolUseBlock('c1', 'grep', { query: 'foo' })],
      [toolResultBlock('c1', '3 处匹配。')],
    );
    const msgsB = makeRound(
      [textBlock('搜索。'), toolUseBlock('c1', 'grep', { query: 'foo' })],
      [toolResultBlock('c1', '3 处匹配。')],
    );
    // 不同调用产生不同 id/ts，但内容相同
    expect(msgsA[2]!.id).not.toBe(msgsB[2]!.id);
    expect(fingerprintRound(msgsA)).toBe(fingerprintRound(msgsB));
  });
});

/* ------------------------------------------------------------------ */
/* createRoundLoopDetector：判定逻辑                                   */
/* ------------------------------------------------------------------ */

describe('createRoundLoopDetector：判定逻辑', () => {
  function makeDetector() {
    return createRoundLoopDetector();
  }

  function observe(det: ReturnType<typeof makeDetector>, fp: string | null): RoundLoopVerdict {
    return det.observe(fp);
  }

  describe('基础行为', () => {
    it('首次指纹 → none（streak 1，不干预）', () => {
      const d = makeDetector();
      expect(observe(d, 'fp-A')).toEqual({ action: 'none' });
    });

    it('第 2 次相同指纹 → none（streak 2，不干预）', () => {
      const d = makeDetector();
      observe(d, 'fp-A');
      expect(observe(d, 'fp-A')).toEqual({ action: 'none' });
    });

    it('第 3 次相同指纹 → warn', () => {
      const d = makeDetector();
      observe(d, 'fp-A');
      observe(d, 'fp-A');
      expect(observe(d, 'fp-A')).toEqual({ action: 'warn', streak: 3 });
    });

    it('第 4 次相同指纹 → stop', () => {
      const d = makeDetector();
      observe(d, 'fp-A');
      observe(d, 'fp-A');
      observe(d, 'fp-A'); // warn
      expect(observe(d, 'fp-A')).toEqual({ action: 'stop', streak: 4 });
    });

    it('第 5 次仍相同 → stop（保持有定义行为）', () => {
      const d = makeDetector();
      observe(d, 'fp-A');
      observe(d, 'fp-A');
      observe(d, 'fp-A');
      observe(d, 'fp-A');
      expect(observe(d, 'fp-A')).toEqual({ action: 'stop', streak: 5 });
    });
  });

  describe('streak 清零', () => {
    it('指纹不同 → streak 清零，下一轮重新累计', () => {
      const d = makeDetector();
      const r1 = observe(d, 'fp-A');
      const r2 = observe(d, 'fp-A');
      const r3 = observe(d, 'fp-A');
      expect(r3).toEqual({ action: 'warn', streak: 3 });
      // 第 4 轮换指纹
      expect(observe(d, 'fp-B')).toEqual({ action: 'none' }); // streak 清零后 1
      expect(observe(d, 'fp-B')).toEqual({ action: 'none' }); // streak 2
      // 第 3 次 fp-B → warn（streak 3）
      expect(observe(d, 'fp-B')).toEqual({ action: 'warn', streak: 3 });
    });

    it('null 输入 → streak 清零', () => {
      const d = makeDetector();
      observe(d, 'fp-A');
      observe(d, 'fp-A');
      expect(observe(d, null)).toEqual({ action: 'none' });
      // streak 已清零，再给 fp-A 应从 1 开始
      expect(observe(d, 'fp-A')).toEqual({ action: 'none' });
    });
  });

  describe('null / 首次边界', () => {
    it('首次 null → none', () => {
      const d = makeDetector();
      expect(observe(d, null)).toEqual({ action: 'none' });
    });

    it('null 后接相同指纹 → streak 从 1 重新开始', () => {
      const d = makeDetector();
      observe(d, 'fp-A');
      observe(d, null); // 清零
      expect(observe(d, 'fp-A')).toEqual({ action: 'none' }); // streak=1
    });

    it('null 后 null → 持续 none', () => {
      const d = makeDetector();
      expect(observe(d, null)).toEqual({ action: 'none' });
      expect(observe(d, null)).toEqual({ action: 'none' });
    });
  });

  describe('reset', () => {
    it('reset 后状态归零', () => {
      const d = makeDetector();
      observe(d, 'fp-A');
      observe(d, 'fp-A');
      observe(d, 'fp-A'); // warn
      d.reset();
      expect(observe(d, 'fp-A')).toEqual({ action: 'none' }); // streak 从 1 开始
    });
  });

  describe('滑动窗口：周期 2 交替', () => {
    it('A B A B A B A B → 第 7 轮（A 第 4 次出现）→ stop', () => {
      const d = makeDetector();
      // A B A B A B A B：A 出现 4 次，B 出现 4 次
      const seq = ['fp-A', 'fp-B', 'fp-A', 'fp-B', 'fp-A', 'fp-B', 'fp-A', 'fp-B'];
      const results = seq.map((fp) => observe(d, fp));
      // 窗口大小 8，前 7 轮都在窗口内
      expect(results[0]).toEqual({ action: 'none' }); // A count=1
      expect(results[1]).toEqual({ action: 'none' }); // B count=1
      expect(results[2]).toEqual({ action: 'none' }); // A count=2
      expect(results[3]).toEqual({ action: 'none' }); // B count=2
      expect(results[4]).toEqual({ action: 'warn', streak: 3 }); // A count=3
      expect(results[5]).toEqual({ action: 'warn', streak: 3 }); // B count=3
      expect(results[6]).toEqual({ action: 'stop', streak: 4 }); // A count=4
      expect(results[7]).toEqual({ action: 'stop', streak: 4 }); // B count=4
    });

    it('A B A B A B → 第 6 轮（A 第 3 次出现）→ warn，未到 stop', () => {
      const d = makeDetector();
      const seq = ['fp-A', 'fp-B', 'fp-A', 'fp-B', 'fp-A', 'fp-B'];
      const results = seq.map((fp) => observe(d, fp));
      // A 出现 3 次（位置 0,2,4），B 出现 3 次（位置 1,3,5）
      // 窗口大小 8，前 6 轮都在窗口内
      expect(results[4]).toEqual({ action: 'warn', streak: 3 }); // 第 5 轮 A 第 3 次
      expect(results[5]).toEqual({ action: 'warn', streak: 3 }); // 第 6 轮 B 第 3 次
    });
  });

  describe('滑动窗口：周期 3 交替', () => {
    it('A B C A B C A B C → 第 9 轮（A 第 3 次出现）→ warn', () => {
      const d = makeDetector();
      const seq = ['fp-A', 'fp-B', 'fp-C', 'fp-A', 'fp-B', 'fp-C', 'fp-A', 'fp-B', 'fp-C'];
      const results = seq.map((fp) => observe(d, fp));
      // 窗口 8，第 9 轮时窗口内为 [B,C,A,B,C,A,B,C]（A 出现 2 次，B 3 次，C 3 次）
      expect(results[6]).toEqual({ action: 'warn', streak: 3 }); // 第 7 轮 A 第 3 次
      expect(results[7]).toEqual({ action: 'warn', streak: 3 }); // 第 8 轮 B 第 3 次
      expect(results[8]).toEqual({ action: 'warn', streak: 3 }); // 第 9 轮 C 第 3 次
    });
  });

  describe('滑动窗口：边界条件', () => {
    it('同一指纹间隔超过 K 轮时不累计', () => {
      const d = makeDetector();
      // A 出现 3 次，但第 3 次与第 1 次间隔 8 轮（超出窗口）
      observe(d, 'fp-A'); // 窗口 [A]
      for (let i = 0; i < 7; i++) {
        observe(d, `fp-fill-${i}`); // 窗口 [A, fill-0..fill-6]
      }
      // 此时窗口 8 个元素，A 在头部，再给 A 时 A 会被挤掉
      expect(observe(d, 'fp-A')).toEqual({ action: 'none' }); // A 第 2 次（窗口内只有 1 次 A）
      // 再给 7 个 fill，然后第 9 次 A → 窗口内只有 1 次 A
      for (let i = 0; i < 7; i++) {
        observe(d, `fp-fill2-${i}`);
      }
      expect(observe(d, 'fp-A')).toEqual({ action: 'none' });
    });

    it('null 打断后不误累计', () => {
      const d = makeDetector();
      observe(d, 'fp-A');
      observe(d, 'fp-A');
      expect(observe(d, null)).toEqual({ action: 'none' }); // 清零
      observe(d, 'fp-A');
      expect(observe(d, 'fp-A')).toEqual({ action: 'none' }); // 从 1 重新开始
      expect(observe(d, 'fp-A')).toEqual({ action: 'warn', streak: 3 }); // null 后第 3 次
    });
  });

  describe('合法轮询不误伤（指纹每次变化 → 不触发）', () => {
    it('工具调用相同、结果每次不同 → 持续 none', () => {
      // 模拟合法轮询：同一查询，结果每次变化，指纹不同
      const d = makeDetector();
      expect(observe(d, 'fp-round-1')).toEqual({ action: 'none' });
      expect(observe(d, 'fp-round-2')).toEqual({ action: 'none' });
      expect(observe(d, 'fp-round-3')).toEqual({ action: 'none' });
      expect(observe(d, 'fp-round-4')).toEqual({ action: 'none' });
    });
  });
});

/* ------------------------------------------------------------------ */
/* fingerprintRound + detector 联合行为（真实消息驱动）                 */
/* ------------------------------------------------------------------ */

describe('fingerprintRound + detector 联合：真实消息驱动', () => {
  /** 构造一组相同的 assistant → tool_result 消息对。 */
  function sameRound(
    text: string,
    toolName: string,
    toolInput: unknown,
    result: string,
    isError = false,
  ): StoredMessage[] {
    return makeRound(
      [textBlock(text), toolUseBlock('c1', toolName, toolInput)],
      [toolResultBlock('c1', result, isError)],
    );
  }

  it('连续 2 轮完全相同 → 不触发', () => {
    const d = createRoundLoopDetector();
    const r = sameRound('搜索中。', 'grep', { query: 'foo' }, '3 处匹配。');
    expect(d.observe(fingerprintRound(r))).toEqual({ action: 'none' });
    expect(d.observe(fingerprintRound(r))).toEqual({ action: 'none' });
  });

  it('连续 3 轮完全相同 → warn', () => {
    const d = createRoundLoopDetector();
    const r = sameRound('搜索中。', 'grep', { query: 'foo' }, '3 处匹配。');
    d.observe(fingerprintRound(r));
    d.observe(fingerprintRound(r));
    expect(d.observe(fingerprintRound(r))).toEqual({ action: 'warn', streak: 3 });
  });

  it('连续 4 轮完全相同 → stop', () => {
    const d = createRoundLoopDetector();
    const r = sameRound('搜索中。', 'grep', { query: 'foo' }, '3 处匹配。');
    d.observe(fingerprintRound(r));
    d.observe(fingerprintRound(r));
    d.observe(fingerprintRound(r)); // warn
    expect(d.observe(fingerprintRound(r))).toEqual({ action: 'stop', streak: 4 });
  });

  it('第 3 轮结果不同 → 不触发（合法轮询）', () => {
    const d = createRoundLoopDetector();
    const r1 = sameRound('搜索中。', 'grep', { query: 'foo' }, '3 处匹配。');
    const r2 = sameRound('搜索中。', 'grep', { query: 'foo' }, '5 处匹配。'); // 结果不同
    d.observe(fingerprintRound(r1));
    expect(d.observe(fingerprintRound(r2))).toEqual({ action: 'none' }); // streak 清零
  });

  it('中间一轮不同后 streak 清零重计', () => {
    const d = createRoundLoopDetector();
    const r1 = sameRound('搜索中。', 'grep', { query: 'foo' }, '3 处匹配。');
    const r2 = sameRound('换个方法。', 'read_file', { path: 'x.ts' }, '文件内容');
    expect(d.observe(fingerprintRound(r1))).toEqual({ action: 'none' });
    // r2 不同 → streak 清零后累计为 1
    expect(d.observe(fingerprintRound(r2))).toEqual({ action: 'none' });
    expect(d.observe(fingerprintRound(r2))).toEqual({ action: 'none' }); // streak=2
    expect(d.observe(fingerprintRound(r2))).toEqual({ action: 'warn', streak: 3 }); // streak=3
  });

  it('is_error=true 参与指纹（错误复读触发检测）', () => {
    const d = createRoundLoopDetector();
    const errRound = () =>
      sameRound('执行。', 'bash', { cmd: 'ls' }, 'command not found', true);
    d.observe(fingerprintRound(errRound()));
    d.observe(fingerprintRound(errRound()));
    expect(d.observe(fingerprintRound(errRound()))).toEqual({ action: 'warn', streak: 3 });
  });

  it('is_error 不同 → 不触发（不是复读）', () => {
    const d = createRoundLoopDetector();
    const errRound = () =>
      sameRound('执行。', 'bash', { cmd: 'ls' }, 'command not found', true);
    const okRound = () =>
      sameRound('执行。', 'bash', { cmd: 'ls' }, 'command not found', false);
    d.observe(fingerprintRound(errRound()));
    expect(d.observe(fingerprintRound(okRound()))).toEqual({ action: 'none' }); // 不同，清零
  });
});

/* ------------------------------------------------------------------ */
/* loop.ts 接线集成测试（warn + stop）                                 */
/* ------------------------------------------------------------------ */

describe('runAgent：跨回合零进展检测接线', () => {
  const baseMessages = (): StoredMessage[] => [
    sm({ role: 'user', content: '请搜索文件。' }, 'user'),
  ];

  it('warn：连续 3 轮相同 tool_use → yield notice（loop.roundLoop.warn）且注入 injection 消息', async () => {
    const { provider } = makeFakeProvider([
      // 第 1 轮：tool_use（相同调用）
      {
        textChunks: [],
        finalContent: [toolUseBlock('c1', 'grep', { query: 'foo' })],
        stopReason: 'tool_use',
      },
      // 第 2 轮：tool_use（相同调用，收到注入警告后仍复读）
      {
        textChunks: [],
        finalContent: [toolUseBlock('c1', 'grep', { query: 'foo' })],
        stopReason: 'tool_use',
      },
      // 第 3 轮：tool_use（相同调用，此时 streak=3 → warn，注入后继续）
      {
        textChunks: [],
        finalContent: [toolUseBlock('c1', 'grep', { query: 'foo' })],
        stopReason: 'tool_use',
      },
      // 第 4 轮：模型换方法，正常结束
      { textChunks: ['完成'], finalContent: [textBlock('完成')], stopReason: 'end_turn' },
    ]);

    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd(), signal: undefined },
        messages: baseMessages(),
      }),
    );

    // 应看到 loop.roundLoop.warn notice
    const warnNotice = events.find(
      (e) =>
        e.type === 'notice' &&
        typeof (e as { message?: string }).message === 'string' &&
        (e as { message: string }).message.includes('相同回合'),
    );
    expect(warnNotice).toBeDefined();

    // 最后应以 turn_done 收尾（第 4 轮正常结束）
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('stop：连续 4 轮相同 → yield notice + turn_done + return（不是 error）', async () => {
    // 4 轮相同后 stop，共需 4 次 provider 调用（stop 在 round 4 的 tool_use 分支触发）
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [toolUseBlock('c1', 'grep', { query: 'foo' })],
        stopReason: 'tool_use',
      },
      {
        textChunks: [],
        finalContent: [toolUseBlock('c1', 'grep', { query: 'foo' })],
        stopReason: 'tool_use',
      },
      {
        textChunks: [],
        finalContent: [toolUseBlock('c1', 'grep', { query: 'foo' })],
        stopReason: 'tool_use',
      },
      // 第 4 轮：streak=4 → stop，不进入下一轮（不会调用 provider 第 5 次）
      // 但注意：第 4 轮 round 的 provider 调用是必须的（循环顶部先调 provider 再判）
      {
        textChunks: [],
        finalContent: [toolUseBlock('c1', 'grep', { query: 'foo' })],
        stopReason: 'tool_use',
      },
    ]);

    const messages: StoredMessage[] = baseMessages();
    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd(), signal: undefined },
        messages,
      }),
    );

    // 必须以 turn_done 收尾，不能是 error
    expect(events.at(-1)!.type).toBe('turn_done');
    // 应有 stop notice
    const stopNotices = events.filter(
      (e) =>
        e.type === 'notice' &&
        typeof (e as { message?: string }).message === 'string' &&
        (e as { message: string }).message.includes('死循环'),
    );
    expect(stopNotices.length).toBeGreaterThanOrEqual(1);
    // 不应该有 error 事件
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('合法轮询不误伤：工具调用相同但结果变化 → 正常结束', async () => {
    const { provider } = makeFakeProvider([
      // 第 1 轮 tool_use
      {
        textChunks: [],
        finalContent: [toolUseBlock('c1', 'task_output', { task_id: 't1' })],
        stopReason: 'tool_use',
      },
      // 第 2 轮 tool_use（tool_result 内容不同 → 指纹不同 → 不触发）
      {
        textChunks: [],
        finalContent: [toolUseBlock('c1', 'task_output', { task_id: 't1' })],
        stopReason: 'tool_use',
      },
      // 第 3 轮：正常结束
      { textChunks: ['任务完成'], finalContent: [textBlock('任务完成')], stopReason: 'end_turn' },
    ]);

    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd(), signal: undefined },
        messages: baseMessages(),
      }),
    );

    // 不触发 roundLoop：正常以 turn_done 结束
    expect(events.at(-1)!.type).toBe('turn_done');
    // 无 roundLoop 相关 notice
    const roundLoopNotices = events.filter(
      (e) =>
        e.type === 'notice' &&
        typeof (e as { message?: string }).message === 'string' &&
        ((e as { message: string }).message.includes('零进展')
          || (e as { message: string }).message.includes('死循环')
          || (e as { message: string }).message.includes('连续')),
    );
    expect(roundLoopNotices).toHaveLength(0);
  });

  it('warn 后模型改变调用 → streak 清零，正常推进', async () => {
    // 完整序列（7 轮 tool_use + 1 轮 end_turn = 8 次 provider 调用）：
    // 轮 1-3：相同 grep 调用 → streak 3 → warn
    // 轮 4-6：注入后模型改为 read_file → streak 从 1 重新累计到 3 → warn
    // 轮 7：模型改为直接回答 → end_turn，loop 正常收尾
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'grep', { query: 'foo' })], stopReason: 'tool_use' },
      { textChunks: [], finalContent: [toolUseBlock('c1', 'grep', { query: 'foo' })], stopReason: 'tool_use' },
      { textChunks: [], finalContent: [toolUseBlock('c1', 'grep', { query: 'foo' })], stopReason: 'tool_use' },
      // 第 4 轮：注入后模型换方法（不同 fingerprint → streak 清零）
      { textChunks: [], finalContent: [toolUseBlock('c2', 'read_file', { path: 'x.ts' })], stopReason: 'tool_use' },
      { textChunks: [], finalContent: [toolUseBlock('c2', 'read_file', { path: 'x.ts' })], stopReason: 'tool_use' },
      { textChunks: [], finalContent: [toolUseBlock('c2', 'read_file', { path: 'x.ts' })], stopReason: 'tool_use' },
      // 第 7 轮：再次收到警告后模型换方法，end_turn
      { textChunks: ['已读取'], finalContent: [textBlock('已读取')], stopReason: 'end_turn' },
    ]);

    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd(), signal: undefined },
        messages: baseMessages(),
      }),
    );

    // 最后应以 turn_done 收尾
    expect(events.at(-1)!.type).toBe('turn_done');
    // 应看到 2 次 warn notice（grep 3 轮后 1 次 + read_file 3 轮后 1 次）
    const warnNotices = events.filter(
      (e) =>
        e.type === 'notice' &&
        typeof (e as { message?: string }).message === 'string' &&
        (e as { message: string }).message.includes('相同回合'),
    );
    expect(warnNotices.length).toBe(2);
    // 无 stop notice（模型两次都换了方法）
    const stopNotices = events.filter(
      (e) =>
        e.type === 'notice' &&
        typeof (e as { message?: string }).message === 'string' &&
        (e as { message: string }).message.includes('死循环'),
    );
    expect(stopNotices).toHaveLength(0);
  });
});
