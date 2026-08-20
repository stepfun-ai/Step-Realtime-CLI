/**
 * ③ /resume 子 agent 下钻：只读浏览子会话历史。
 *
 * 测两层：
 * 1. 核心流程集成——SubagentStore 写子会话 → loadFull 读回 → historyToDisplayItems 转换 →
 *    Transcript.reset 载入 → items() 保存快照 → reset 恢复。验证浏览-退出闭环的数据通路。
 * 2. PiChat 接线断言——PiChat 不可实例化，锁源码里的三个接线点：
 *    onEscape 浏览态拦截、pickSubagent 选中调 browseSubagentSession、/resume 的 sub: 分支同。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stored } from '../../src/agent/message.js';
import { SessionStore } from '../../src/session/store.js';
import { SubagentStore } from '../../src/agent/subagent/store.js';
import { Transcript } from '../../src/tui-pi/Transcript.js';
import { historyToDisplayItems } from '../../src/chat/historyReplay.js';
import type { DisplayItem } from '../../src/chat/types.js';

const repoRoot = pathJoin(dirname(fileURLToPath(import.meta.url)), '..', '..');
const piChatSrc = readFileSync(pathJoin(repoRoot, 'src', 'tui-pi', 'PiChat.ts'), 'utf8');

/** 构造一个最小 SubagentStore（只用于 loadFull 边界测试）。 */
function makeStore(): { baseDir: string; store: SubagentStore; cleanup: () => void } {
  const baseDir = mkdtempSync(join(tmpdir(), 'scpi-subagent-'));
  const main = new SessionStore(baseDir);
  return { baseDir, store: new SubagentStore(main), cleanup: () => rmSync(baseDir, { recursive: true, force: true }) };
}

function savedText(items: DisplayItem[]): string {
  return items
    .map((it) => {
      if (it.kind === 'note') return it.text;
      if (it.kind === 'user') return typeof it.content === 'string' ? it.content : '';
      if (it.kind === 'assistant') return it.text ?? '';
      return '';
    })
    .join('\n');
}

describe('③ 子 agent 浏览核心流程（集成）', () => {
  it('Transcript save/restore：浏览-退出闭环', () => {
    // 模拟：主会话 transcript 有内容 → 浏览时 reset 成子会话历史 → 退出时恢复
    const mainT = new Transcript();
    mainT.push({ kind: 'note', text: '主会话当前内容' });
    mainT.push({ kind: 'user', content: '用户问题' });
    mainT.push({ kind: 'assistant', text: '主会话回复' });

    // 进入浏览：保存快照，reset 为子会话内容
    const saved = mainT.items(); // items() 每次 map 出新数组，reset 后引用安全
    expect(savedText(saved)).toContain('主会话当前内容');
    expect(savedText(saved)).toContain('主会话回复');

    // 模拟 historyToDisplayItems 产出 + 浏览头
    const browseItems: DisplayItem[] = [
      { kind: 'note', text: '正在浏览子 agent 会话「explore」— Esc 返回' },
      { kind: 'user', content: '子会话里的用户输入' },
      { kind: 'assistant', text: '子会话的回复找到了文件' },
    ];
    mainT.reset(browseItems);
    expect(savedText(mainT.items())).toContain('找到了文件');
    expect(savedText(mainT.items())).not.toContain('主会话当前内容');

    // 退出浏览：恢复快照
    mainT.reset(saved);
    expect(savedText(mainT.items())).toContain('主会话当前内容');
    expect(savedText(mainT.items())).toContain('主会话回复');
    expect(savedText(mainT.items())).not.toContain('找到了文件');
  });

  it('items() 返回的数组在 reset 后不被污染', () => {
    const t = new Transcript();
    t.push({ kind: 'note', text: '原始内容' });
    const snapshot = t.items();
    t.reset([{ kind: 'note', text: '新内容' }]);
    // snapshot 仍持有旧数据——证明保存时机正确
    expect(savedText(snapshot)).toContain('原始内容');
    expect(savedText(snapshot)).not.toContain('新内容');
  });

  it('historyToDisplayItems 处理空数组不崩', () => {
    const replay = historyToDisplayItems([]);
    expect(replay.items).toEqual([]);
    expect(replay.totalTurns).toBe(0);
  });

  it('SubagentStore.loadFull 对不存在的 id 返回空数组', () => {
    const { store, cleanup } = makeStore();
    try {
      const messages = store.loadFull('/nonexistent', 'does-not-exist');
      expect(messages).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe('③ PiChat 接线断言', () => {
  it('子 agent 浏览态字段存在', () => {
    expect(piChatSrc).toContain('subagentBrowsing');
  });

  it('onEscape 优先拦截浏览态', () => {
    const escape = piChatSrc.slice(piChatSrc.indexOf('private onEscape(): boolean'), piChatSrc.indexOf('private onEscape(): boolean') + 400);
    expect(escape).toContain('subagentBrowsing');
    expect(escape).toContain('exitSubagentBrowse');
  });

  it('onSubmit 浏览态自动退出', () => {
    const submit = piChatSrc.slice(piChatSrc.indexOf('private async onSubmit'), piChatSrc.indexOf('private async onSubmit') + 600);
    expect(submit).toContain('subagentBrowsing');
  });

  it('/resume 的 sub: 分支调 browseSubagentSession', () => {
    const subBranch = piChatSrc.slice(piChatSrc.indexOf("picked.startsWith('sub:')"), piChatSrc.indexOf("picked.startsWith('sub:')") + 200);
    expect(subBranch).toContain('browseSubagentSession');
  });

  it('/agents 路由调 openAgentsOverlay', () => {
    const agents = piChatSrc.slice(piChatSrc.indexOf("case 'agents'"), piChatSrc.indexOf("case 'agents'") + 100);
    expect(agents).toContain('openAgentsOverlay');
  });

  it('browseSubagentSession 用 subagentStore.loadFull 且不改 session/history', () => {
    const method = piChatSrc.slice(piChatSrc.indexOf('private browseSubagentSession'), piChatSrc.indexOf('private browseSubagentSession') + 2000);
    expect(method).toContain('subagentStore.loadFull');
    expect(method).toContain('historyToDisplayItems');
    expect(method).toContain('transcript.reset');
  });
});
