import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MEMORY_INDEX_BUDGET,
  formatMemoryEntryLine,
  measureMemoryIndex,
  memorySection,
  parseMemoryFile,
  scanMemory,
  type MemoryEntry,
} from '../../src/agent/memory.js';

/**
 * memory 观察池的读侧测试。
 *
 * 覆盖设计稿「测试要点」节的可单测部分：解析、两层合并、索引预算与计数标注、
 * 坏文件容错、只读变体。开关与中途注入的行为测试在 TUI 层成本过高，由手动验证兜底。
 */

let base: string;
let home: string;
let cwd: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stepcode-mem-'));
  home = join(base, 'home');
  cwd = join(base, 'proj');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** 写一个合法记忆文件。 */
function writeMemory(root: string, rel: string, title: string, body: string, fields?: Record<string, unknown>): void {
  const dir = join(root, ...rel.split('/').slice(0, -1));
  mkdirSync(dir, { recursive: true });
  const fieldsBlock =
    fields === undefined
      ? ''
      : `\n<!-- MEMORY_FIELDS\n${JSON.stringify(fields)}\n-->\n`;
  writeFileSync(join(root, ...rel.split('/')), `# ${title}\n\n${body}\n${fieldsBlock}`, 'utf-8');
}

function globalRoot(): string {
  return join(home, '.step-code', 'memory');
}

function projectRoot(): string {
  return join(cwd, '.step-code', 'memory');
}

describe('parseMemoryFile', () => {
  it('解析标题、摘要与 MEMORY_FIELDS 字段', () => {
    writeMemory(projectRoot(), 'project/package-manager.md', '包管理器', '这个项目统一用 pnpm。', {
      type: 'project',
      version: 3,
      occurrences: 2,
      updated_at: '2026-08-10T11:20:00+08:00',
    });
    const e = parseMemoryFile(
      join(projectRoot(), 'project/package-manager.md'),
      'project/package-manager.md',
      'project',
    );
    expect(e.broken).toBe(false);
    expect(e.topic).toBe('包管理器');
    expect(e.summary).toBe('这个项目统一用 pnpm。');
    expect(e.version).toBe(3);
    expect(e.occurrences).toBe(2);
    expect(e.updatedAt).toBe('2026-08-10T11:20:00+08:00');
  });

  it('缺 MEMORY_FIELDS 注释块不算坏文件（手写新文件的常态）', () => {
    writeMemory(projectRoot(), 'project/plain.md', '纯文本', '没有字段块。');
    const e = parseMemoryFile(join(projectRoot(), 'project/plain.md'), 'project/plain.md', 'project');
    expect(e.broken).toBe(false);
    expect(e.version).toBe(1);
    expect(e.occurrences).toBe(1);
    expect(e.updatedAt).not.toBe(''); // 回退到文件 mtime
  });

  it('JSON 损坏标 broken，不抛错', () => {
    const dir = join(projectRoot(), 'project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.md'), '# 坏文件\n\n正文\n<!-- MEMORY_FIELDS\n{不是 json}\n-->\n', 'utf-8');
    const e = parseMemoryFile(join(dir, 'bad.md'), 'project/bad.md', 'project');
    expect(e.broken).toBe(true);
  });

  it('无标题时主题退化为文件名（去 .md）', () => {
    const dir = join(projectRoot(), 'preferences');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'commit-style.md'), '没有标题，只有正文。', 'utf-8');
    const e = parseMemoryFile(join(dir, 'commit-style.md'), 'preferences/commit-style.md', 'global');
    expect(e.topic).toBe('preferences/commit-style');
    expect(e.summary).toBe('没有标题，只有正文。');
  });

  it('摘要取正文首个非空非标题行并截断', () => {
    const longBody = '很长的正文'.repeat(30);
    writeMemory(projectRoot(), 'project/long.md', '长正文', longBody);
    const e = parseMemoryFile(join(projectRoot(), 'project/long.md'), 'project/long.md', 'project');
    expect(e.summary.length).toBeLessThanOrEqual(60);
    expect(e.summary.endsWith('…')).toBe(true);
  });
});

describe('scanMemory：两层合并', () => {
  it('目录不存在时返回空（关闭开启前/新项目的常态）', () => {
    const scan = scanMemory(cwd, home);
    expect(scan.entries).toHaveLength(0);
    expect(scan.broken).toHaveLength(0);
  });

  it('全局与项目层都扫到，带 scope', () => {
    writeMemory(globalRoot(), 'preferences/commit.md', '提交风格', '中文 subject。');
    writeMemory(projectRoot(), 'project/build.md', '构建命令', '用 pnpm build。');
    const scan = scanMemory(cwd, home);
    expect(scan.entries).toHaveLength(2);
    expect(scan.entries.map((e) => e.scope).sort()).toEqual(['global', 'project']);
  });

  it('同 relPath 时项目层覆盖全局层（局部约定优先）', () => {
    writeMemory(globalRoot(), 'preferences/pkg.md', '全局包管理器', '全局默认 npm。');
    writeMemory(projectRoot(), 'preferences/pkg.md', '项目包管理器', '本项目用 pnpm。');
    const scan = scanMemory(cwd, home);
    expect(scan.entries).toHaveLength(1);
    expect(scan.entries[0]!.scope).toBe('project');
    expect(scan.entries[0]!.topic).toBe('项目包管理器');
  });

  it('坏文件进 broken 列表、不进 entries，且不阻塞其它文件', () => {
    writeMemory(projectRoot(), 'project/good.md', '好文件', '正常。');
    const dir = join(projectRoot(), 'project');
    writeFileSync(join(dir, 'bad.md'), '# 坏\n\n<!-- MEMORY_FIELDS\n{坏}\n-->\n', 'utf-8');
    const scan = scanMemory(cwd, home);
    expect(scan.entries).toHaveLength(1);
    expect(scan.broken).toHaveLength(1);
    expect(scan.broken[0]!.relPath).toBe('project/bad.md');
  });

  it('跳过隐藏目录与 node_modules', () => {
    writeMemory(projectRoot(), '.hidden/secret.md', '隐藏', '不该被扫到。');
    writeMemory(projectRoot(), 'node_modules/pkg/readme.md', '依赖', '不该被扫到。');
    writeMemory(projectRoot(), 'project/visible.md', '可见', '该被扫到。');
    const scan = scanMemory(cwd, home);
    expect(scan.entries).toHaveLength(1);
    expect(scan.entries[0]!.topic).toBe('可见');
  });
});

describe('memorySection', () => {
  function fakeEntry(over: Partial<MemoryEntry>): MemoryEntry {
    return {
      scope: 'project',
      topic: '主题',
      summary: '摘要',
      relPath: 'project/x.md',
      absPath: '/abs/x.md',
      occurrences: 1,
      version: 1,
      updatedAt: '2026-08-10T00:00:00Z',
      broken: false,
      ...over,
    };
  }

  it('空索引也返回完整段（含写入引导）', () => {
    const s = memorySection({ entries: [], broken: [] });
    expect(s).toContain('## 记忆');
    expect(s).toContain('（暂无观察）');
    expect(s).toContain('应写入或更新观察');
  });

  it('标注观察未经确认、与规范冲突时以规范为准', () => {
    const s = memorySection({ entries: [], broken: [] });
    expect(s).toContain('未经用户确认');
    expect(s).toContain('以规范为准');
  });

  it('索引条目带「第 N 次出现」计数（occurrences > 1 时）', () => {
    const s = memorySection({ entries: [fakeEntry({ occurrences: 3 })], broken: [] });
    expect(s).toContain('（第 3 次出现）');
  });

  it('超出字符预算时截断并标注省略条数', () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      fakeEntry({ topic: `主题${i}`, relPath: `project/t${i}.md`, summary: '这是一段用于占用预算的摘要文字'.repeat(3) }),
    );
    const s = memorySection({ entries: many, broken: [] });
    expect(s).toContain('因篇幅省略');
    // 索引部分不超预算（允许段内固定文案额外开销）
    expect(measureMemoryIndex({ entries: many, broken: [] })).toBeLessThanOrEqual(MEMORY_INDEX_BUDGET);
  });

  it('readonly 变体：无写入引导，改为「写进返回报告」', () => {
    const s = memorySection({ entries: [], broken: [] }, 'readonly');
    expect(s).toContain('只读');
    expect(s).toContain('返回报告');
    expect(s).not.toContain('应写入或更新观察');
  });
});

describe('formatMemoryEntryLine / measureMemoryIndex', () => {
  const entry: MemoryEntry = {
    scope: 'global',
    topic: '提交风格',
    summary: '中文 subject 带根因',
    relPath: 'preferences/commit.md',
    absPath: '/home/.step-code/memory/preferences/commit.md',
    occurrences: 2,
    version: 2,
    updatedAt: '2026-08-10T11:20:00+08:00',
    broken: false,
  };

  it('条目行含主题、摘要、计数、日期与路径', () => {
    const line = formatMemoryEntryLine(entry);
    expect(line).toContain('提交风格');
    expect(line).toContain('中文 subject 带根因');
    expect(line).toContain('（第 2 次出现）');
    expect(line).toContain('2026-08-10');
    expect(line).toContain(entry.absPath);
  });

  it('空索引用量为 0，逐条累加', () => {
    expect(measureMemoryIndex({ entries: [], broken: [] })).toBe(0);
    expect(measureMemoryIndex({ entries: [entry], broken: [] })).toBeGreaterThan(0);
  });
});
