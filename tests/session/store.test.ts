import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stored } from '../../src/agent/message.js';
import { SessionStore, workdirKey, deriveTitle, derivePreview } from '../../src/session/store.js';
import { isStepref } from '../../src/session/attachments.js';

let base: string;
let store: SessionStore;
const cwd = 'C:/some/project';

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stepcode-sess-'));
  store = new SessionStore(base);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('workdirKey', () => {
  it('稳定且对大小写/斜杠归一', () => {
    expect(workdirKey('C:/A/B')).toBe(workdirKey('c:\\a\\b'));
    expect(workdirKey('C:/A/B')).not.toBe(workdirKey('C:/A/C'));
  });
});

describe('SessionStore', () => {
  it('create → save → load 往返', () => {
    const s = store.create(cwd, 'step-3.7-flash');
    s.messages.push(stored({ role: 'user', content: 'hi' }, { kind: 'user' }));
    store.save(s);

    const loaded = store.load(cwd, s.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(s.id);
    expect(loaded!.messageCount).toBe(1);
    expect(loaded!.messages[0]!.message).toEqual({ role: 'user', content: 'hi' });
    expect(loaded!.messages[0]!.origin.kind).toBe('user');
    expect(loaded!.messages[0]!.id).toBeTruthy();
    expect(loaded!.messages[0]!.ts).toBeTruthy();
  });

  it('fork 谱系：forkedFrom 随会话持久化', () => {
    const src = store.create(cwd, 'step-3.7-flash');
    src.messages.push(stored({ role: 'user', content: 'hi' }, { kind: 'user' }));
    store.save(src);

    const forked = store.create(cwd, 'step-3.7-flash');
    forked.forkedFrom = src.id;
    forked.messages = [...src.messages];
    store.save(forked);

    const loaded = store.load(cwd, forked.id);
    expect(loaded!.forkedFrom).toBe(src.id);
    expect(loaded!.messages).toHaveLength(1);
    // 源会话无 forkedFrom
    expect(store.load(cwd, src.id)!.forkedFrom).toBeUndefined();
  });

  it('load 不存在返回 null', () => {
    expect(store.load(cwd, 'nope')).toBeNull();
  });

  it('含 thinking 块（带 signature）的 assistant 消息 save/load 往返一致', () => {
    const s = store.create(cwd, 'step-3.7-flash');
    s.messages.push(stored({ role: 'user', content: 'hi' }, { kind: 'user' }));
    s.messages.push(
      stored(
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '先想想…', signature: 'sig-abc' },
            { type: 'text', text: '答案' },
          ],
        } as unknown as Anthropic.MessageParam,
        { kind: 'assistant' },
      ),
    );
    store.save(s);

    const loaded = store.load(cwd, s.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.messages[1]!.origin.kind).toBe('assistant');
    expect(loaded!.messages[1]!.message).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '先想想…', signature: 'sig-abc' },
        { type: 'text', text: '答案' },
      ],
    });
  });

  it('list 按 updatedAt 倒序且只含本工作目录', async () => {
    const a = store.create(cwd, 'm');
    store.save(a);
    await new Promise((r) => setTimeout(r, 5));
    const b = store.create(cwd, 'm');
    store.save(b);
    // 另一个工作目录的会话不应出现
    const other = store.create('D:/other', 'm');
    store.save(other);

    const metas = store.list(cwd);
    expect(metas.map((m) => m.id)).toEqual([b.id, a.id]);
  });

  it('goal 状态快照随会话 save/load 往返', () => {
    const s = store.create(cwd, 'm');
    s.goal = {
      objective: '写报告',
      status: 'active',
      turnsUsed: 3,
      turnBudget: 10,
      tokensUsed: 12345,
      tokenBudget: 50000,
      createdAt: Date.now(),
    };
    store.save(s);
    const loaded = store.load(cwd, s.id);
    expect(loaded!.goal).toMatchObject({
      objective: '写报告',
      status: 'active',
      turnsUsed: 3,
      turnBudget: 10,
      tokensUsed: 12345,
      tokenBudget: 50000,
    });
    // 无 goal 的会话读出为 undefined
    const plain = store.create(cwd, 'm');
    store.save(plain);
    expect(store.load(cwd, plain.id)!.goal).toBeUndefined();
  });

  it('permission mode 随会话 save/load 往返；旧快照缺失读出 undefined', () => {
    const s = store.create(cwd, 'm', 'yolo');
    expect(s.mode).toBe('yolo');
    store.save(s);
    expect(store.load(cwd, s.id)!.mode).toBe('yolo');
    // 切换后再存读回新值
    const loaded = store.load(cwd, s.id)!;
    loaded.mode = 'auto';
    store.save(loaded);
    expect(store.load(cwd, s.id)!.mode).toBe('auto');
    // 不带 mode 创建的会话读出为 undefined（恢复时由调用方回退启动默认）
    const plain = store.create(cwd, 'm');
    store.save(plain);
    expect(store.load(cwd, plain.id)!.mode).toBeUndefined();
  });

  it('rename 往返：设置自定义名、list 直通、空名清除回退 title、不刷新 updatedAt', () => {
    const s = store.create(cwd, 'm');
    s.messages.push(stored({ role: 'user', content: '原始标题来源' }, { kind: 'user' }));
    store.save(s);
    const before = store.load(cwd, s.id)!;
    expect(before.name).toBeUndefined();
    expect(before.title).toBe('原始标题来源');

    // 设置自定义名：load/list 都能读回
    expect(store.rename(cwd, s.id, '  我的名字  ')).toBe(true);
    expect(store.load(cwd, s.id)!.name).toBe('我的名字');
    const metas = store.list(cwd);
    expect(metas).toHaveLength(1);
    expect(metas[0]!.name).toBe('我的名字');
    // title 派生不受重命名影响
    expect(metas[0]!.title).toBe('原始标题来源');
    // rename 不刷新 updatedAt（避免改个名就把会话顶到列表最前）
    expect(metas[0]!.updatedAt).toBe(before.updatedAt);

    // 空名/纯空白 = 清除自定义名，展示回退 title
    expect(store.rename(cwd, s.id, '   ')).toBe(true);
    expect(store.load(cwd, s.id)!.name).toBeUndefined();
    expect(store.list(cwd)[0]!.name).toBeUndefined();

    // 不存在的会话返回 false
    expect(store.rename(cwd, 'nope', 'x')).toBe(false);
  });

  it('updateTitle 往返：写入 AI 生成标题、list 可见、不刷新 updatedAt', () => {
    const s = store.create(cwd, 'm');
    s.messages.push(stored({ role: 'user', content: '原始标题来源' }, { kind: 'user' }));
    store.save(s);
    const before = store.load(cwd, s.id)!;

    expect(store.updateTitle(cwd, s.id, 'AI 生成的语义标题')).toBe(true);
    expect(store.load(cwd, s.id)!.title).toBe('AI 生成的语义标题');
    const metas = store.list(cwd);
    expect(metas[0]!.title).toBe('AI 生成的语义标题');
    // 不刷新 updatedAt（标题是元数据变化，不把会话顶到列表最前）
    expect(metas[0]!.updatedAt).toBe(before.updatedAt);

    // 不存在的会话返回 false
    expect(store.updateTitle(cwd, 'nope', 'x')).toBe(false);
  });

  it('model 随会话 save/load 往返（恢复时不再被 config 覆盖）', () => {
    const s = store.create(cwd, 'step-3.5-flash');
    store.save(s);
    expect(store.load(cwd, s.id)!.model).toBe('step-3.5-flash');
    // 切换模型后落盘读回新值
    const loaded = store.load(cwd, s.id)!;
    loaded.model = 'step-3.7-flash';
    store.save(loaded);
    expect(store.load(cwd, s.id)!.model).toBe('step-3.7-flash');
  });

  it('思考深度覆盖随会话 save/load 往返；旧快照缺失读出 undefined', () => {
    const s = store.create(cwd, 'm');
    // 新建会话未切档 → 缺失（恢复时由调用方回落 config 默认档位）
    store.save(s);
    expect(store.load(cwd, s.id)!.thinkOverride).toBeUndefined();
    // 切档位后落盘读回
    const loaded = store.load(cwd, s.id)!;
    loaded.thinkOverride = 'high';
    store.save(loaded);
    expect(store.load(cwd, s.id)!.thinkOverride).toBe('high');
    // 'off'（本会话不发 thinking 字段）与档位名同为合法值，不能被当成"未设置"
    const off = store.load(cwd, s.id)!;
    off.thinkOverride = 'off';
    store.save(off);
    expect(store.load(cwd, s.id)!.thinkOverride).toBe('off');
  });

  it('plan 模式随会话 save/load 往返；旧快照缺失读出 undefined', () => {
    const s = store.create(cwd, 'm');
    store.save(s);
    expect(store.load(cwd, s.id)!.planMode).toBeUndefined();
    // 开 plan 后落盘读回 true
    const loaded = store.load(cwd, s.id)!;
    loaded.planMode = true;
    store.save(loaded);
    expect(store.load(cwd, s.id)!.planMode).toBe(true);
    // 关掉后读回 false（显式 false 与缺失语义不同：前者是用户关过，后者是旧快照）
    const off = store.load(cwd, s.id)!;
    off.planMode = false;
    store.save(off);
    expect(store.load(cwd, s.id)!.planMode).toBe(false);
  });

  it('latest 返回最近更新的会话', async () => {
    const a = store.create(cwd, 'm');
    store.save(a);
    await new Promise((r) => setTimeout(r, 5));
    const b = store.create(cwd, 'm');
    b.messages.push(stored({ role: 'user', content: 'x' }, { kind: 'user' }));
    store.save(b);

    const latest = store.latest(cwd);
    expect(latest!.id).toBe(b.id);
    expect(latest!.messages).toHaveLength(1);
  });

  it('空目录 list 为空、latest 为 null', () => {
    expect(store.list('E:/empty')).toEqual([]);
    expect(store.latest('E:/empty')).toBeNull();
  });

  it('save 自动写入 title（从首条 user 消息派生）', () => {
    const s = store.create(cwd, 'm');
    s.messages.push(stored({ role: 'user', content: '第一条问题' }, { kind: 'user' }));
    store.save(s);
    expect(s.title).toBe('第一条问题');
    expect(store.load(cwd, s.id)!.title).toBe('第一条问题');
  });

  it('list 返回 title', () => {
    const s = store.create(cwd, 'm');
    s.messages.push(stored({ role: 'user', content: '标题内容' }, { kind: 'user' }));
    store.save(s);
    expect(store.list(cwd)[0]!.title).toBe('标题内容');
  });

  it('delete 删除后 load 返回 null，再次删除返回 false', () => {
    const s = store.create(cwd, 'm');
    store.save(s);
    expect(store.load(cwd, s.id)).not.toBeNull();
    expect(store.delete(cwd, s.id)).toBe(true);
    expect(store.load(cwd, s.id)).toBeNull();
    expect(store.delete(cwd, s.id)).toBe(false);
  });

  it('delete 连同全量日志一起删除，不留孤儿 JSONL', () => {
    const s = store.create(cwd, 'm');
    store.save(s);
    store.appendFull(cwd, s.id, [stored({ role: 'user', content: 'a' }, { kind: 'user' })]);
    expect(store.loadFull(cwd, s.id)).toHaveLength(1);
    expect(store.delete(cwd, s.id)).toBe(true);
    expect(store.loadFull(cwd, s.id)).toHaveLength(0);
  });
});

describe('SessionStore 全量历史日志（appendFull / loadFull）', () => {
  it('append-only + 按 id 去重，重复调用幂等', () => {
    const s = store.create(cwd, 'm');
    const m1 = stored({ role: 'user', content: 'a' }, { kind: 'user' });
    const m2 = stored({ role: 'assistant', content: 'b' }, { kind: 'assistant' });
    expect(store.appendFull(cwd, s.id, [m1])).toBe(1);
    // 再次追加 m1（已存在）+ m2（新） → 只写入 m2
    expect(store.appendFull(cwd, s.id, [m1, m2])).toBe(2 - 1);
    const loaded = store.loadFull(cwd, s.id);
    expect(loaded.map((m) => m.id)).toEqual([m1.id, m2.id]);
  });

  it('压缩不影响已落盘全量日志：history 变短后仍可读回被压缩掉的行', () => {
    const s = store.create(cwd, 'm');
    const msgs = ['1', '2', '3', '4'].map((t) => stored({ role: 'user', content: t }, { kind: 'user' }));
    store.appendFull(cwd, s.id, msgs);
    // 模拟压缩后 history 只剩最后一条，再持久化一次
    store.appendFull(cwd, s.id, [msgs[3]!]);
    const loaded = store.loadFull(cwd, s.id);
    expect(loaded).toHaveLength(4); // 前 3 条不因压缩丢失
  });

  it('全量日志不存在返回空数组', () => {
    expect(store.loadFull(cwd, 'nope')).toEqual([]);
  });

  it('空 messages 追加返回 0，不建文件', () => {
    const s = store.create(cwd, 'm');
    expect(store.appendFull(cwd, s.id, [])).toBe(0);
    expect(store.loadFull(cwd, s.id)).toEqual([]);
  });

  it('性能回归：1000 次 append 不随日志增长退化（seen-id 按会话缓存，仅首次 loadFull）', () => {
    const s = store.create(cwd, 'm');
    const appendRange = (from: number, to: number): number => {
      const t0 = performance.now();
      for (let i = from; i < to; i++) {
        store.appendFull(cwd, s.id, [stored({ role: 'user', content: `m${i}` }, { kind: 'user' })]);
      }
      return performance.now() - t0;
    };
    // 首尾各取 100 次的耗时对比，而不是看总耗时的绝对值：
    // 绝对阈值（原来是 2000ms）测的是机器闲忙——全量并发跑时会偶发红，
    // 而这条测试真正要防的是复杂度退化。退回每次全文重读重解析（O(n²)）时，
    // 尾段每次要多解析 900 条，必然比首段慢一个数量级；缓存命中下两段都是常数时间。
    const head = appendRange(0, 100);
    appendRange(100, 900);
    const tail = appendRange(900, 1000);
    expect(store.loadFull(cwd, s.id)).toHaveLength(1000);
    // 5 倍余量 + 200ms 地板：head 只有几毫秒时比值噪声会被放大，用地板兜住
    expect(tail, `尾段 ${tail.toFixed(0)}ms 不应远慢于首段 ${head.toFixed(0)}ms`).toBeLessThan(
      Math.max(head * 5, 200),
    );
  });
});

describe('SessionStore origin 对象形态', () => {
  it('对象 origin 落盘往返：盘上就是对象形态，载荷字段不丢', () => {
    const s = store.create(cwd, 'm');
    s.messages.push(
      stored(
        { role: 'user', content: '后台完成' },
        { kind: 'background_task', taskId: 'task-9', notificationId: 'n-9', startsPromptTurn: true },
      ),
    );
    store.save(s);

    const raw = JSON.parse(readFileSync(join(base, workdirKey(cwd), `${s.id}.json`), 'utf8')) as {
      messages: { origin: unknown }[];
    };
    expect(raw.messages[0]!.origin).toEqual({
      kind: 'background_task',
      taskId: 'task-9',
      notificationId: 'n-9',
      startsPromptTurn: true,
    });

    const loaded = store.load(cwd, s.id)!;
    expect(loaded.messages[0]!.origin).toEqual({
      kind: 'background_task',
      taskId: 'task-9',
      notificationId: 'n-9',
      startsPromptTurn: true,
    });
  });

  it('对象 origin 经 appendFull 落盘后 loadFull 往返一致', () => {
    const s = store.create(cwd, 'm');
    const m = stored({ role: 'user', content: '通知' }, { kind: 'background_task', taskId: 'task-1' });
    store.appendFull(cwd, s.id, [m]);
    const loaded = store.loadFull(cwd, s.id);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.origin).toEqual({ kind: 'background_task', taskId: 'task-1' });
  });
});

describe('SessionStore 主桶隔离', () => {
  it('list 只扫桶根：subagents/ 子目录里的快照不进入主会话列表', () => {
    const s = store.create(cwd, 'm');
    store.save(s);
    // 子 agent 会话落在独立命名空间，不能污染 /resume 与 --continue 的候选集
    const subDir = join(base, workdirKey(cwd), 'subagents');
    mkdirSync(subDir, { recursive: true });
    const sub = store.create(cwd, 'm');
    writeFileSync(join(subDir, `${sub.id}.json`), JSON.stringify({ ...sub, messages: [] }), 'utf8');

    const metas = store.list(cwd);
    expect(metas.map((m) => m.id)).toEqual([s.id]);
    expect(store.latest(cwd)!.id).toBe(s.id);
  });
});

describe('SessionStore 图片引用式存储（offload / 不污染内存）', () => {
  /** 生成长度 ≥ 阈值的规范 base64。 */
  function bigBase64(bytes = 4000): string {
    return Buffer.alloc(bytes, 7).toString('base64');
  }

  function imageStored(b64: string) {
    return stored(
      {
        role: 'user',
        content: [
          { type: 'text', text: '图' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
        ],
      },
      { kind: 'user' },
    );
  }

  function imgData(sm: { message: Anthropic.MessageParam }): string {
    const content = sm.message.content as Anthropic.ContentBlockParam[];
    const img = content.find((b): b is Anthropic.ImageBlockParam => b.type === 'image')!;
    return (img.source as Anthropic.Base64ImageSource).data;
  }

  it('save：落盘文件里图片是 stepref，不再内联 base64；内存 history 仍是原始 base64', () => {
    const b64 = bigBase64();
    const s = store.create(cwd, 'm');
    s.messages.push(imageStored(b64));
    store.save(s);

    const raw = readFileSync(join(base, workdirKey(cwd), `${s.id}.json`), 'utf8');
    expect(raw).toContain('stepref:');
    expect(raw).not.toContain(b64); // 原始 base64 不落盘

    // 内存态未被污染
    expect(imgData(s.messages[0]!)).toBe(b64);

    // 读回快照后是 stepref（供 toWire rehydrate）
    const loaded = store.load(cwd, s.id)!;
    expect(isStepref(imgData(loaded.messages[0]!))).toBe(true);
  });

  it('appendFull：事件日志里图片是 stepref，不内联 base64；入参 messages 未被改动', () => {
    const b64 = bigBase64();
    const s = store.create(cwd, 'm');
    const m = imageStored(b64);
    store.appendFull(cwd, s.id, [m]);

    // appendFull 底层已事件化为 wire.jsonl
    const raw = readFileSync(join(base, workdirKey(cwd), `${s.id}.wire.jsonl`), 'utf8');
    expect(raw).toContain('stepref:');
    expect(raw).not.toContain(b64);

    // 入参未被污染
    expect(imgData(m)).toBe(b64);
    // 读回后是 stepref
    expect(isStepref(imgData(store.loadFull(cwd, s.id)[0]!))).toBe(true);
  });

  it('小图（< 阈值）不 offload，落盘仍内联 base64', () => {
    const small = Buffer.alloc(100, 1).toString('base64');
    const s = store.create(cwd, 'm');
    s.messages.push(imageStored(small));
    store.save(s);
    const raw = readFileSync(join(base, workdirKey(cwd), `${s.id}.json`), 'utf8');
    expect(raw).toContain(small);
    expect(raw).not.toContain('stepref:');
  });
});

describe('deriveTitle', () => {
  it('从首条 user 消息（string content）派生，折叠空白', () => {
    const msgs = [stored({ role: 'user', content: '  hello   world\nfoo  ' }, { kind: 'user' })];
    expect(deriveTitle(msgs)).toBe('hello world foo');
  });

  it('从数组 content 拼接所有 text 块', () => {
    const msgs = [
      stored(
        {
          role: 'user',
          content: [
            { type: 'text', text: 'part one' },
            { type: 'text', text: 'part two' },
          ],
        },
        { kind: 'user' },
      ),
    ];
    expect(deriveTitle(msgs)).toBe('part one part two');
  });

  it('超过 50 字符截断加省略号', () => {
    const long = 'a'.repeat(60);
    expect(deriveTitle([stored({ role: 'user', content: long }, { kind: 'user' })])).toBe(`${'a'.repeat(50)}…`);
  });

  it('取第一条 user 消息（跳过 assistant）', () => {
    const msgs = [
      stored({ role: 'assistant', content: '你好' }, { kind: 'assistant' }),
      stored({ role: 'user', content: '真正的问题' }, { kind: 'user' }),
    ];
    expect(deriveTitle(msgs)).toBe('真正的问题');
  });

  it('无 user 消息或纯空返回 undefined', () => {
    expect(deriveTitle([stored({ role: 'assistant', content: 'hi' }, { kind: 'assistant' })])).toBeUndefined();
    expect(deriveTitle([])).toBeUndefined();
    expect(deriveTitle([stored({ role: 'user', content: '   \n  ' }, { kind: 'user' })])).toBeUndefined();
  });
});

describe('derivePreview', () => {
  it('从首条 user 消息派生，折叠空白', () => {
    const msgs = [stored({ role: 'user', content: '  hello   world\nfoo  ' }, { kind: 'user' })];
    expect(derivePreview(msgs)).toBe('hello world foo');
  });

  it('超过 200 字符截断加省略号（比标题留更多内容供搜索）', () => {
    const long = 'a'.repeat(250);
    expect(derivePreview([stored({ role: 'user', content: long }, { kind: 'user' })])).toBe(`${'a'.repeat(200)}…`);
  });

  it('200 字符以内不截断', () => {
    const exact = 'b'.repeat(200);
    expect(derivePreview([stored({ role: 'user', content: exact }, { kind: 'user' })])).toBe(exact);
  });

  it('无 user 消息或纯空返回 undefined', () => {
    expect(derivePreview([stored({ role: 'assistant', content: 'hi' }, { kind: 'assistant' })])).toBeUndefined();
    expect(derivePreview([])).toBeUndefined();
  });
});

describe('SessionStore 索引缓存（_index.json）', () => {
  it('save 后自动生成索引；list 命中索引且不读快照', () => {
    const s = store.create(cwd, 'm');
    s.messages.push(stored({ role: 'user', content: 'x' }, { kind: 'user' }));
    store.save(s);

    const indexFile = join(base, workdirKey(cwd), '_index.json');
    expect(readFileSync(indexFile, 'utf8')).toContain('"version":1');

    // 第二次 list 应走索引（不重新读 .json 快照，通过结果一致隐式验证）
    const metas = store.list(cwd);
    expect(metas).toHaveLength(1);
    expect(metas[0]!.id).toBe(s.id);
    expect(metas[0]!.title).toBe('x');
  });

  it('list 按 updatedAt 倒序', () => {
    // save() 用真实时钟刷新 updatedAt；快速机器上两次 save 可能同毫秒，导致次序不稳定。
    // 用假时钟把 b 的保存时间明确推进 1ms，消除对真实时钟间隔的依赖。
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-07T00:00:00.000Z'));
      const a = store.create(cwd, 'm');
      store.save(a);
      vi.setSystemTime(new Date('2026-08-07T00:00:00.001Z'));
      const b = store.create(cwd, 'm');
      b.messages.push(stored({ role: 'user', content: 'b' }, { kind: 'user' }));
      store.save(b);

      const metas = store.list(cwd);
      expect(metas.map((m) => m.id)).toEqual([b.id, a.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('delete 后索引同步移除', () => {
    const a = store.create(cwd, 'm');
    store.save(a);
    const b = store.create(cwd, 'm');
    store.save(b);

    expect(store.list(cwd)).toHaveLength(2);
    expect(store.delete(cwd, a.id)).toBe(true);
    expect(store.list(cwd)).toHaveLength(1);
    expect(store.list(cwd)[0]!.id).toBe(b.id);
  });

  it('rename 后索引 name 同步更新且不刷新 updatedAt', () => {
    const s = store.create(cwd, 'm');
    s.messages.push(stored({ role: 'user', content: 't' }, { kind: 'user' }));
    store.save(s);
    const beforeUpdatedAt = store.load(cwd, s.id)!.updatedAt;

    expect(store.rename(cwd, s.id, '新名字')).toBe(true);
    const metas = store.list(cwd);
    expect(metas[0]!.name).toBe('新名字');
    expect(metas[0]!.updatedAt).toBe(beforeUpdatedAt);
  });

  it('索引损坏时自动全量重建', () => {
    const s = store.create(cwd, 'm');
    store.save(s);
    const indexFile = join(base, workdirKey(cwd), '_index.json');
    writeFileSync(indexFile, '{broken json', 'utf8');

    const metas = store.list(cwd);
    expect(metas).toHaveLength(1);
    expect(metas[0]!.id).toBe(s.id);
    // 重建后索引应恢复正常
    const raw = readFileSync(indexFile, 'utf8');
    expect(JSON.parse(raw).version).toBe(1);
  });

  it('索引不存在时全量重建', () => {
    const s = store.create(cwd, 'm');
    store.save(s);
    const indexFile = join(base, workdirKey(cwd), '_index.json');
    rmSync(indexFile);

    const metas = store.list(cwd);
    expect(metas).toHaveLength(1);
    expect(metas[0]!.id).toBe(s.id);
    expect(existsSync(indexFile)).toBe(true);
  });

  it('索引过期时自动重建（新写 .json 文件触发）', () => {
    const s = store.create(cwd, 'm');
    store.save(s);
    const indexFile = join(base, workdirKey(cwd), '_index.json');
    // 让 rebuiltAt 早于当前时间，再额外写一个旧索引文件模拟过期
    const stale = JSON.stringify({ version: 1, rebuiltAt: new Date(Date.now() - 86400000).toISOString(), sessions: [] });
    writeFileSync(indexFile, stale, 'utf8');

    const metas = store.list(cwd);
    expect(metas).toHaveLength(1);
    expect(metas[0]!.id).toBe(s.id);
    const rebuiltAt = new Date(JSON.parse(readFileSync(indexFile, 'utf8')).rebuiltAt).getTime();
    expect(rebuiltAt).toBeGreaterThan(Date.now() - 1000);
  });

  it('旧版索引 version 不匹配时重建', () => {
    const s = store.create(cwd, 'm');
    store.save(s);
    const indexFile = join(base, workdirKey(cwd), '_index.json');
    writeFileSync(indexFile, JSON.stringify({ version: 99, rebuiltAt: new Date().toISOString(), sessions: [] }), 'utf8');

    const metas = store.list(cwd);
    expect(metas).toHaveLength(1);
    expect(metas[0]!.id).toBe(s.id);
  });

  it('list 只含本工作目录的会话', () => {
    const a = store.create(cwd, 'm');
    store.save(a);
    const other = store.create('D:/other', 'm');
    store.save(other);

    const metas = store.list(cwd);
    expect(metas.map((m) => m.id)).toEqual([a.id]);
  });

  it('save 后索引包含完整 SessionMeta 字段', () => {
    const s = store.create(cwd, 'step-3.7-flash');
    s.messages.push(stored({ role: 'user', content: 'hello' }, { kind: 'user' }));
    s.forkedFrom = 'fork-from-id';
    s.parentId = 'parent-id';
    s.depth = 1;
    s.agentType = 'explore';
    s.status = 'done';
    store.save(s);

    const metas = store.list(cwd);
    expect(metas).toHaveLength(1);
    expect(metas[0]!.id).toBe(s.id);
    expect(metas[0]!.cwd).toBe(s.cwd);
    expect(metas[0]!.model).toBe('step-3.7-flash');
    expect(metas[0]!.createdAt).toBe(s.createdAt);
    expect(metas[0]!.updatedAt).toBe(s.updatedAt);
    expect(metas[0]!.messageCount).toBe(1);
    expect(metas[0]!.title).toBe('hello');
    expect(metas[0]!.preview).toBe('hello');
  });

  it('list 跳过子目录（subagents）', () => {
    const s = store.create(cwd, 'm');
    store.save(s);
    const subDir = join(base, workdirKey(cwd), 'subagents');
    mkdirSync(subDir, { recursive: true });
    const sub = store.create(cwd, 'm');
    writeFileSync(join(subDir, `${sub.id}.json`), JSON.stringify({ ...sub, messages: [] }), 'utf8');

    expect(store.list(cwd).map((m) => m.id)).toEqual([s.id]);
  });
});

describe('SessionStore 视频引用式存储（与图片同一卸载通道）', () => {
  function bigBase64(bytes = 4000): string {
    return Buffer.alloc(bytes, 7).toString('base64');
  }

  function videoStored(b64: string) {
    return stored(
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_v',
            content: [
              { type: 'text', text: '已读取视频' },
              { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: b64 } },
            ],
          } as Anthropic.ToolResultBlockParam,
        ],
      },
      { kind: 'tool' },
    );
  }

  function videoData(sm: { message: Anthropic.MessageParam }): string {
    const content = sm.message.content as Anthropic.ToolResultBlockParam[];
    const inner = content[0]!.content as Array<{ type: string; source?: { data: string } }>;
    return inner.find((b) => b.type === 'video')!.source!.data;
  }

  it('save：落盘文件里 tool_result 内嵌视频是 stepref，内存 history 仍是原始 base64', () => {
    const b64 = bigBase64();
    const s = store.create(cwd, 'm');
    s.messages.push(videoStored(b64));
    store.save(s);

    const raw = readFileSync(join(base, workdirKey(cwd), `${s.id}.json`), 'utf8');
    expect(raw).toContain('stepref:');
    expect(raw).not.toContain(b64);

    // 内存态未被污染
    expect(videoData(s.messages[0]!)).toBe(b64);

    // 读回快照后是 stepref（供 toWire rehydrate）
    const loaded = store.load(cwd, s.id)!;
    expect(isStepref(videoData(loaded.messages[0]!))).toBe(true);
  });
});
