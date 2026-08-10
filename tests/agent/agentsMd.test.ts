import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgentsMd } from '../../src/agent/agentsMd.js';

/** 每用例一个独立临时根目录，用例间互不影响 */
let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'agentsmd-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** 建目录并写入文件，返回绝对路径。 */
function put(relPath: string, content: string): string {
  const abs = join(base, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}

/** 预期中的注释头。 */
function header(absPath: string): string {
  return `<!-- From: ${absPath} -->\n`;
}

describe('loadAgentsMd 收集顺序与注释头', () => {
  it('用户级在前，项目级从根到叶；每层 .step-code/AGENTS.md 优先', () => {
    const home = join(base, 'home');
    const proj = join(base, 'proj');
    const userStepCode = put('home/.step-code/AGENTS.md', 'user-stepcode');
    const userAgents = put('home/.agents/AGENTS.md', 'user-agents');
    const rootAgents = put('proj/AGENTS.md', 'root');
    const subStepCode = put('proj/sub/.step-code/AGENTS.md', 'sub-stepcode');
    put('proj/sub/AGENTS.md', 'sub-plain'); // 应被 .step-code 挤掉
    const leafAgents = put('proj/sub/leaf/AGENTS.md', 'leaf');
    mkdirSync(join(proj, '.git'), { recursive: true });

    const out = loadAgentsMd(join(proj, 'sub', 'leaf'), home).text;
    expect(out).toBe(
      [
        header(userStepCode) + 'user-stepcode',
        header(userAgents) + 'user-agents',
        header(rootAgents) + 'root',
        header(subStepCode) + 'sub-stepcode',
        header(leafAgents) + 'leaf',
      ].join('\n\n'),
    );
  });

  it('~/.agents 下 AGENTS.md 缺失时退回 agents.md', () => {
    const home = join(base, 'home');
    put('home/.agents/agents.md', 'user-agents-lower');
    put('proj/AGENTS.md', 'root');
    const out = loadAgentsMd(join(base, 'proj'), home).text;
    // Windows 文件系统大小写不敏感，候选 AGENTS.md 会直接命中 agents.md，
    // 因此只断言内容命中、注释头路径大小写不敏感匹配
    expect(out).toContain('user-agents-lower');
    expect(out).toMatch(/<!-- From: .*\.agents[/\\]agents\.md -->\nuser-agents-lower/i);
  });

  it('每层 AGENTS.md 缺失时退回 agents.md', () => {
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    put('proj/agents.md', 'lower');
    mkdirSync(join(base, 'proj', '.git'), { recursive: true });
    const out = loadAgentsMd(join(base, 'proj'), home).text;
    expect(out).toMatch(/<!-- From: .*proj[/\\]agents\.md -->\nlower/i);
  });
});

describe('loadAgentsMd 项目根定位', () => {
  it('从 cwd 向上找到含 .git 的目录作为根，根层文件也收集', () => {
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const rootAgents = put('proj/AGENTS.md', 'root');
    const subAgents = put('proj/sub/AGENTS.md', 'sub');
    mkdirSync(join(base, 'proj', '.git'), { recursive: true });

    const out = loadAgentsMd(join(base, 'proj', 'sub'), home).text;
    expect(out).toBe([header(rootAgents) + 'root', header(subAgents) + 'sub'].join('\n\n'));
  });

  it('.git 是文件（worktree/submodule）同样认定为项目根', () => {
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const rootAgents = put('proj/AGENTS.md', 'root');
    put('proj/sub/AGENTS.md', 'sub');
    writeFileSync(join(base, 'proj', '.git'), 'gitdir: elsewhere', 'utf8');

    const out = loadAgentsMd(join(base, 'proj', 'sub'), home).text;
    expect(out.startsWith(header(rootAgents))).toBe(true);
  });

  it('找不到 .git 时退回 cwd 本身，不收集上层目录', () => {
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    put('proj/AGENTS.md', 'root-not-in-scope'); // 无 .git，cwd 是 proj/sub，根退回 cwd
    const leafAgents = put('proj/sub/AGENTS.md', 'leaf');

    const out = loadAgentsMd(join(base, 'proj', 'sub'), home).text;
    expect(out).toBe(header(leafAgents) + 'leaf');
  });
});

describe('loadAgentsMd 32KB 预算', () => {
  it('叶子优先：叶文件完整保留，上层被截断并加省略标记', () => {
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    // 两份各 20KB，总量超 32KB；叶文件先分预算，根文件只能拿剩余
    const rootContent = 'R'.repeat(20 * 1024);
    const leafContent = 'L'.repeat(20 * 1024);
    const rootPath = put('proj/AGENTS.md', rootContent);
    const leafPath = put('proj/sub/AGENTS.md', leafContent);
    mkdirSync(join(base, 'proj', '.git'), { recursive: true });

    const out = loadAgentsMd(join(base, 'proj', 'sub'), home).text;
    // 输出顺序不变：根在前，叶在后
    expect(out.indexOf(header(rootPath))).toBeLessThan(out.indexOf(header(leafPath)));
    // 叶文件完整保留
    expect(out).toContain(header(leafPath) + leafContent);
    // 根文件被截断：不完整且带省略标记
    expect(out).not.toContain(rootContent);
    const rootPart = out.slice(out.indexOf(header(rootPath)), out.indexOf(header(leafPath)));
    expect(rootPart).toContain('\n…\n\n');
    // 总量不超预算
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(32 * 1024);
  });

  it('预算耗尽时整篇丢弃更上层的文件', () => {
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    // 叶文件独占几乎全部预算，剩余字节放不下根文件的注释头 → 根文件整篇丢弃
    const rootPath = put('proj/AGENTS.md', 'R'.repeat(1024));
    const leafPath = join(base, 'proj', 'sub', 'AGENTS.md');
    const leafHeaderBytes = Buffer.byteLength(header(leafPath), 'utf8');
    const leafContent = 'L'.repeat(32 * 1024 - leafHeaderBytes - 10);
    put('proj/sub/AGENTS.md', leafContent);
    mkdirSync(join(base, 'proj', '.git'), { recursive: true });

    const out = loadAgentsMd(join(base, 'proj', 'sub'), home).text;
    expect(out).not.toContain(header(rootPath));
    expect(out).toBe(header(leafPath) + leafContent);
  });

  it('截断 UTF-8 安全：不在多字节字符中间切断', () => {
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const leafContent = 'L'.repeat(20 * 1024);
    // 「测」3 字节，截断点大概率落在字符中间
    const rootContent = '测'.repeat(20 * 1024);
    put('proj/AGENTS.md', rootContent);
    put('proj/sub/AGENTS.md', leafContent);
    mkdirSync(join(base, 'proj', '.git'), { recursive: true });

    const out = loadAgentsMd(join(base, 'proj', 'sub'), home).text;
    expect(out).not.toContain('�');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(32 * 1024);
  });
});

describe('loadAgentsMd 空结果', () => {
  it('用户级与项目级全都没有时返回空串', () => {
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const cwd = join(base, 'proj', 'sub');
    mkdirSync(cwd, { recursive: true });
    expect(loadAgentsMd(cwd, home).text).toBe('');
  });
});

describe('loadAgentsMd AGENTS.override.md 约定', () => {
  it('项目层内 AGENTS.override.md 优先于 AGENTS.md', () => {
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    put('proj/AGENTS.md', 'team-rules');
    const override = put('proj/AGENTS.override.md', 'personal-override');
    mkdirSync(join(base, 'proj', '.git'), { recursive: true });

    const out = loadAgentsMd(join(base, 'proj'), home).text;
    expect(out).toBe(header(override) + 'personal-override');
  });

  it('项目层内 .step-code/AGENTS.md 仍优先于 AGENTS.override.md', () => {
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const stepCode = put('proj/.step-code/AGENTS.md', 'stepcode-rules');
    put('proj/AGENTS.override.md', 'personal-override');
    mkdirSync(join(base, 'proj', '.git'), { recursive: true });

    const out = loadAgentsMd(join(base, 'proj'), home).text;
    expect(out).toBe(header(stepCode) + 'stepcode-rules');
  });

  it('用户级 ~/.step-code/AGENTS.override.md 优先于 AGENTS.md', () => {
    const home = join(base, 'home');
    put('home/.step-code/AGENTS.md', 'user-plain');
    const override = put('home/.step-code/AGENTS.override.md', 'user-override');

    const out = loadAgentsMd(base, home).text;
    expect(out).toBe(header(override) + 'user-override');
  });
});

describe('loadAgentsMd customPaths 覆盖模式', () => {
  it('配了 customPaths 时只读指定路径，忽略默认的用户级与项目级收集', () => {
    const home = join(base, 'home');
    put('home/.step-code/AGENTS.md', 'user-stepcode'); // 默认会被收，覆盖模式下应被忽略
    put('proj/AGENTS.md', 'root'); // 同上
    mkdirSync(join(base, 'proj', '.git'), { recursive: true });
    const custom = put('custom/my-rules.md', 'custom-rules');

    const out = loadAgentsMd(join(base, 'proj'), home, [custom]).text;
    expect(out).toBe(header(custom) + 'custom-rules');
  });

  it('目录条目命中其下的 AGENTS.md（大小写不敏感文件系统下同义于 agents.md）', () => {
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const dirA = join(base, 'team');
    const agentsMd = put('team/AGENTS.md', 'team-rules');

    const out = loadAgentsMd(base, home, [dirA]).text;
    expect(out).toBe(header(agentsMd) + 'team-rules');
  });

  it('多个条目按配置顺序拼接，支持 ~ 展开与相对路径', () => {
    const home = join(base, 'home');
    const abs1 = put('one.md', 'first');
    const abs2 = put('home/two.md', 'second');
    const abs3 = put('rel/three.md', 'third');

    const out = loadAgentsMd(base, home, [abs1, '~/two.md', 'rel/three.md']).text;
    expect(out).toBe(
      [header(abs1) + 'first', header(abs2) + 'second', header(abs3) + 'third'].join('\n\n'),
    );
  });

  it('不存在的路径条目被跳过；全部不存在时返回空串', () => {
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    expect(loadAgentsMd(base, home, [join(base, 'nope.md')]).text).toBe('');
  });

  it('customPaths 为空数组时走默认收集', () => {
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const rootAgents = put('proj/AGENTS.md', 'root');
    mkdirSync(join(base, 'proj', '.git'), { recursive: true });

    const out = loadAgentsMd(join(base, 'proj'), home, []).text;
    expect(out).toBe(header(rootAgents) + 'root');
  });
});


describe('loadAgentsMd 可配置预算（agents_md_max_bytes）', () => {
  it('自定义小预算生效：叶优先保留，根截断并带出明细（原始/保留字节数）', () => {
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const rootPath = put('proj/AGENTS.md', 'R'.repeat(600));
    const leafPath = put('proj/sub/AGENTS.md', 'L'.repeat(600));
    mkdirSync(join(base, 'proj', '.git'), { recursive: true });

    const result = loadAgentsMd(join(base, 'proj', 'sub'), home, undefined, 1024);
    // 总量不超自定义预算
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(1024);
    // 叶文件完整保留
    expect(result.text).toContain(header(leafPath) + 'L'.repeat(600));
    // 根文件被截断，明细带出
    expect(result.truncated).toHaveLength(1);
    expect(result.truncated[0].path).toBe(rootPath);
    expect(result.truncated[0].originalBytes).toBe(600);
    expect(result.truncated[0].keptBytes).toBeGreaterThan(0);
    expect(result.truncated[0].keptBytes).toBeLessThan(600);
  });

  it('预算耗尽时整篇丢弃的文件也记入明细（keptBytes = 0），且明细按输出顺序排列', () => {
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const rootPath = put('proj/AGENTS.md', 'R'.repeat(1024));
    const leafPath = join(base, 'proj', 'sub', 'AGENTS.md');
    const leafHeaderBytes = Buffer.byteLength(header(leafPath), 'utf8');
    const leafContent = 'L'.repeat(32 * 1024 - leafHeaderBytes - 10);
    put('proj/sub/AGENTS.md', leafContent);
    mkdirSync(join(base, 'proj', '.git'), { recursive: true });

    const result = loadAgentsMd(join(base, 'proj', 'sub'), home);
    expect(result.text).not.toContain(header(rootPath));
    expect(result.truncated).toEqual([
      { path: rootPath, originalBytes: 1024, keptBytes: 0 },
    ]);
  });

  it('budgetBytes = 0 时禁用加载：返回空文本，且不算截断（不提示）', () => {
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    put('proj/AGENTS.md', 'root');
    mkdirSync(join(base, 'proj', '.git'), { recursive: true });

    const result = loadAgentsMd(join(base, 'proj'), home, undefined, 0);
    expect(result.text).toBe('');
    expect(result.truncated).toEqual([]);
  });

  it('负数预算按禁用处理', () => {
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    put('proj/AGENTS.md', 'root');
    mkdirSync(join(base, 'proj', '.git'), { recursive: true });

    const result = loadAgentsMd(join(base, 'proj'), home, undefined, -5);
    expect(result.text).toBe('');
    expect(result.truncated).toEqual([]);
  });

  it('未发生裁减时 truncated 为空数组', () => {
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    put('proj/AGENTS.md', 'small');
    mkdirSync(join(base, 'proj', '.git'), { recursive: true });

    const result = loadAgentsMd(join(base, 'proj'), home);
    expect(result.text).toContain('small');
    expect(result.truncated).toEqual([]);
  });
});
