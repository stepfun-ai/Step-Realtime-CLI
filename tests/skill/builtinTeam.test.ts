import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS } from '../../src/skill/builtin/index.js';
import { TEAM_SKILL } from '../../src/skill/builtin/team.js';
import { buildSkillRegistry, renderSkillActivation } from '../../src/skill/registry.js';

describe('team builtin skill 注册', () => {
  it('BUILTIN_SKILLS 含 name 为 team 的 skill', () => {
    const names = BUILTIN_SKILLS.map((s) => s.name);
    expect(names).toContain('team');
  });

  it('team skill 元信息正确', () => {
    expect(TEAM_SKILL.name).toBe('team');
    expect(TEAM_SKILL.source).toBe('builtin');
    expect(TEAM_SKILL.dir).toBe('builtin://team');
    expect(TEAM_SKILL.description).toContain('team');
  });

  it('正文包含锚点：team_init', () => {
    expect(TEAM_SKILL.content).toContain('team_init');
  });

  it('正文包含锚点：quit_only', () => {
    expect(TEAM_SKILL.content).toContain('quit_only');
  });

  it('正文包含锚点：五道门', () => {
    expect(TEAM_SKILL.content).toContain('五道门');
  });

  it('正文包含锚点：--repo 或 repo 参数说明', () => {
    expect(TEAM_SKILL.content).toContain('repo');
  });

  it('正文无反引号泄漏', () => {
    expect(TEAM_SKILL.content).not.toContain('`');
  });

  it('正文无 ${ 占位符泄漏', () => {
    expect(TEAM_SKILL.content).not.toContain('${');
  });

  it('激活渲染注入正文', () => {
    const rendered = renderSkillActivation(TEAM_SKILL, '');
    expect(rendered).toContain('<step-skill-loaded name="team" source="builtin">');
    expect(rendered).toContain('五道门');
  });

  it('在注册表中可被检索', () => {
    const tmpDir = join(tmpdir(), 'stepcode-team-test-' + Date.now());
    const reg = buildSkillRegistry(tmpDir);
    const def = reg.skills.get('team');
    expect(def).toBeDefined();
    expect(def!.source).toBe('builtin');
    expect(def!.dir).toBe('builtin://team');
  });
});

/**
 * 防漂移测试（drift anchor）：TEAM_SKILL.content 是自包含内嵌正文，随 team 机制演进时必须同步更新。
 * 本文件维护一份机制锚点清单，断言正文全部包含；锚点与正文不同步时测试变红，强制同步。
 *
 * 约定：team.ts 新增/删除/重命名机制特性时，同步更新下方 ANCHORS 数组和正文对应位置。
 */
describe('team skill 防漂移', () => {
  // 机制锚点清单：team.ts 正文必须包含的所有关键词/标识
  const ANCHORS = [
    'team_init',      // 初始化入口
    'repo',           // team_init 的 repo 参数
    'dir',            // team_init 的 dir 参数
    'base',           // team_init 的 base 参数
    '五道门',         // merge 五道门检查
    'quit_only',      // teardown 应急通道
    'closedAt',       // 关闭标记（teardown/exit 写入）
    'rework',         // completed 重派（审阅打回）
    'respawn',        // blocked 重派（worker 失败重试）
    'worktreeKept',   // merge 后 worktree 清理返回值
    '收编后验证',     // merge 后主仓全量测试
    'dist',           // dist 错位：协调者进程代码启动时固定
    'onLost',         // BackgroundManager lost 联动
  ];

  it('skill 正文包含全部机制锚点', () => {
    for (const anchor of ANCHORS) {
      expect(TEAM_SKILL.content, 'skill 正文缺锚点: ' + anchor).toContain(anchor);
    }
  });
});

