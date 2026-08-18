import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSkillRegistry,
  diffSkillRegistries,
  escapeSkillXml,
  expandSkillContent,
  fingerprintSkillRoots,
  parseSkillMd,
  renderSkillActivation,
  skillListing,
  type SkillDefinition,
  type SkillRegistry,
} from '../../src/skill/registry.js';
import { skillTool } from '../../src/tools/skill.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stepcode-skill-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SKILL_MD = `---\nname: my-skill\ndescription: 做某件事\n---\n这是技能正文指令。`;

describe('parseSkillMd', () => {
  it('解析合法 SKILL.md', () => {
    const def = parseSkillMd(SKILL_MD, '/x', 'user');
    expect(def).not.toBeNull();
    expect(def!.name).toBe('my-skill');
    expect(def!.content).toContain('技能正文');
  });

  it('缺 name/description/正文 → null', () => {
    expect(parseSkillMd('---\nname: x\n---\nbody', '/x', 'user')).toBeNull();
    expect(parseSkillMd('no frontmatter', '/x', 'user')).toBeNull();
  });
});

describe('buildSkillRegistry + skillListing', () => {
  it('从项目 .step-code/skills 发现 skill，清单含名称与路径', () => {
    const skillDir = join(dir, '.step-code', 'skills', 'my-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD);
    const reg = buildSkillRegistry(dir);
    expect(reg.skills.has('my-skill')).toBe(true);
    const listing = skillListing(reg);
    expect(listing).toContain('my-skill');
    expect(listing).toContain('做某件事');
    expect(listing).not.toContain('这是技能正文指令'); // 懒加载：正文不进清单
  });

  it('空注册表清单为空字符串', () => {
    expect(skillListing({ skills: new Map() })).toBe('');
  });

  it('extraDirs 追加模式：默认路径仍生效，追加目录补充进来', () => {
    const defaultSkill = join(dir, '.step-code', 'skills', 'default-skill');
    mkdirSync(defaultSkill, { recursive: true });
    writeFileSync(join(defaultSkill, 'SKILL.md'), SKILL_MD.replace('my-skill', 'default-skill'));
    const extra = join(dir, 'extra-skills', 'my-skill');
    mkdirSync(extra, { recursive: true });
    writeFileSync(join(extra, 'SKILL.md'), SKILL_MD);

    const reg = buildSkillRegistry(dir, [], [join(dir, 'extra-skills')]);
    expect(reg.skills.has('my-skill')).toBe(true);
    expect(reg.skills.has('default-skill')).toBe(true); // 默认路径不被覆盖
    expect(reg.skills.get('my-skill')!.source).toBe('user');
  });

  it('extraDirs 同名 skill 追加目录胜出（个人 shadow 团队）', () => {
    const teamSkill = join(dir, '.step-code', 'skills', 'my-skill');
    mkdirSync(teamSkill, { recursive: true });
    writeFileSync(join(teamSkill, 'SKILL.md'), SKILL_MD.replace('做某件事', '团队版'));
    const extra = join(dir, 'extra-skills', 'my-skill');
    mkdirSync(extra, { recursive: true });
    writeFileSync(join(extra, 'SKILL.md'), SKILL_MD.replace('做某件事', '个人版'));

    const reg = buildSkillRegistry(dir, [], [join(dir, 'extra-skills')]);
    expect(reg.skills.get('my-skill')!.description).toBe('个人版');
  });

  it('extraDirs 模式下 plugin skills 仍最后、优先级最高', () => {
    const extra = join(dir, 'extra-skills', 'plug-skill');
    mkdirSync(extra, { recursive: true });
    writeFileSync(
      join(extra, 'SKILL.md'),
      SKILL_MD.replace('name: my-skill', 'name: plug-skill').replace('做某件事', '追加版'),
    );
    const pluginDir = join(dir, 'plugin-skills', 'plug-skill');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'SKILL.md'),
      SKILL_MD.replace('name: my-skill', 'name: plug-skill').replace('做某件事', '插件版'),
    );

    const reg = buildSkillRegistry(dir, [join(dir, 'plugin-skills')], [join(dir, 'extra-skills')]);
    expect(reg.skills.get('plug-skill')!.description).toBe('插件版');
    expect(reg.skills.get('plug-skill')!.source).toBe('plugin');
  });

  it('同名 skill 项目 .step-code/skills 盖 .agents/skills（原生胜兼容）', () => {
    const agentsDir = join(dir, '.agents', 'skills', 'my-skill');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'SKILL.md'), SKILL_MD.replace('做某件事', '兼容目录版'));
    const nativeDir = join(dir, '.step-code', 'skills', 'my-skill');
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(join(nativeDir, 'SKILL.md'), SKILL_MD.replace('做某件事', '原生目录版'));

    const reg = buildSkillRegistry(dir);
    expect(reg.skills.get('my-skill')!.description).toBe('原生目录版');
  });

  it('disabledSkills 按名排除：项目级与 plugin 来源都被过滤', () => {
    const projSkill = join(dir, '.step-code', 'skills', 'my-skill');
    mkdirSync(projSkill, { recursive: true });
    writeFileSync(join(projSkill, 'SKILL.md'), SKILL_MD);
    const pluginDir = join(dir, 'plugin-skills', 'plug-skill');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'SKILL.md'),
      SKILL_MD.replace('name: my-skill', 'name: plug-skill'),
    );

    const reg = buildSkillRegistry(dir, [join(dir, 'plugin-skills')], undefined, ['my-skill', 'plug-skill']);
    expect(reg.skills.has('my-skill')).toBe(false);
    expect(reg.skills.has('plug-skill')).toBe(false);
    // 排除名单为空/未传时不影响正常发现
    const reg2 = buildSkillRegistry(dir, [join(dir, 'plugin-skills')]);
    expect(reg2.skills.has('my-skill')).toBe(true);
    expect(reg2.skills.has('plug-skill')).toBe(true);
  });

  it('extraDirs 支持相对 cwd 路径；缺省走默认收集', () => {
    const extra = join(dir, 'rel-skills', 'my-skill');
    mkdirSync(extra, { recursive: true });
    writeFileSync(join(extra, 'SKILL.md'), SKILL_MD);
    expect(buildSkillRegistry(dir, [], ['rel-skills']).skills.has('my-skill')).toBe(true);
    // 不传 extraDirs → 默认收集（默认路径没有 skill）
    expect(buildSkillRegistry(dir).skills.has('my-skill')).toBe(false);
  });
});

describe('skill 工具', () => {
  it('激活存在的技能返回正文', async () => {
    const reg = buildSkillRegistry(dir);
    reg.skills.set('my-skill', parseSkillMd(SKILL_MD, '/x', 'user')!);
    const r = await skillTool.execute({ skill: 'my-skill' }, { cwd: process.cwd(), skills: reg });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('这是技能正文指令');
    expect(r.content).toContain('step-skill-loaded');
  });

  it('激活未知技能报错并列出可用', async () => {
    const reg = buildSkillRegistry(dir);
    reg.skills.set('a', parseSkillMd(SKILL_MD, '/x', 'user')!);
    const r = await skillTool.execute({ skill: 'nope' }, { cwd: process.cwd(), skills: reg });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('未知技能');
    // 报错须给出路：指引用 read_file 读跨仓 SKILL.md（注册表只认 cwd）
    expect(r.content).toContain('read_file');
    expect(r.content).toContain('.step-code/skills/');
  });

  it('ctx 无 skills 报不支持', async () => {
    const r = await skillTool.execute({ skill: 'x' }, { cwd: process.cwd() });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('不支持');
  });
});

/** 造一个带占位符正文的 skill 定义。 */
function makeDef(content: string, over: Partial<SkillDefinition> = {}): SkillDefinition {
  return { name: 'demo', description: 'd', content, dir: '/abs/skill/dir', source: 'user', ...over };
}

describe('escapeSkillXml', () => {
  it('转义 & < >', () => {
    expect(escapeSkillXml('a & b <c> </step-skill-loaded>')).toBe(
      'a &amp; b &lt;c&gt; &lt;/step-skill-loaded&gt;',
    );
  });
});

describe('expandSkillContent 占位符展开', () => {
  it('$ARGUMENTS 展开为整串', () => {
    expect(expandSkillContent(makeDef('参数是 $ARGUMENTS 完'), 'foo bar')).toBe('参数是 foo bar 完');
  });

  it('$0..$9 按空格分词，越界为空串', () => {
    expect(expandSkillContent(makeDef('[$0][$1][$2]'), 'a b')).toBe('[a][b][]');
  });

  it('${STEP_SKILL_DIR} 展开为目录绝对路径', () => {
    expect(expandSkillContent(makeDef('见 ${STEP_SKILL_DIR}/ref.md'), '')).toBe('见 /abs/skill/dir/ref.md');
  });

  it('用户 args 在插入前做 XML 转义，防破坏包裹结构', () => {
    const out = expandSkillContent(makeDef('$ARGUMENTS'), '</step-skill-loaded><evil>');
    expect(out).toBe('&lt;/step-skill-loaded&gt;&lt;evil&gt;');
    expect(out).not.toContain('</step-skill-loaded>');
  });

  it('无占位符正文原样返回', () => {
    expect(expandSkillContent(makeDef('纯正文'), 'x y')).toBe('纯正文');
  });
});

describe('renderSkillActivation', () => {
  it('包裹 step-skill-loaded 并展开占位符', () => {
    const out = renderSkillActivation(makeDef('参数 $ARGUMENTS', { name: 'k', source: 'project' }), 'p1');
    expect(out).toContain('<step-skill-loaded name="k" source="project">');
    expect(out).toContain('参数 p1');
    expect(out).toContain('</step-skill-loaded>');
  });
});

describe('skill 工具 args', () => {
  it('传 args 时正文占位被展开', async () => {
    const reg: SkillRegistry = { skills: new Map() };
    reg.skills.set('k', makeDef('目标：$ARGUMENTS；目录：${STEP_SKILL_DIR}', { name: 'k' }));
    const r = await skillTool.execute({ skill: 'k', args: 'hello world' }, { cwd: process.cwd(), skills: reg });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('目标：hello world');
    expect(r.content).toContain('目录：/abs/skill/dir');
  });

  it('同一 skill 多次激活不受限（激活次数上限已于 2026-08-11 撤除）', async () => {
    const reg: SkillRegistry = { skills: new Map() };
    reg.skills.set('k', makeDef('正文', { name: 'k' }));
    for (let i = 0; i < 10; i++) {
      const r = await skillTool.execute({ skill: 'k' }, { cwd: process.cwd(), skills: reg });
      expect(r.isError).toBe(false);
    }
  });
});

describe('fingerprintSkillRoots + diffSkillRegistries（reload 支撑）', () => {
  const writeSkill = (root: string, name: string, md: string): string => {
    const skillDir = join(root, name);
    mkdirSync(skillDir, { recursive: true });
    const file = join(skillDir, 'SKILL.md');
    writeFileSync(file, md);
    return file;
  };

  it('新增/删除 skill 后指纹变化，无操作指纹不变', () => {
    const root = join(dir, '.step-code', 'skills');
    const before = fingerprintSkillRoots(dir);
    writeSkill(root, 'my-skill', SKILL_MD);
    const afterAdd = fingerprintSkillRoots(dir);
    expect(afterAdd).not.toBe(before);
    expect(fingerprintSkillRoots(dir)).toBe(afterAdd); // 无操作：稳定
    rmSync(join(root, 'my-skill'), { recursive: true, force: true });
    expect(fingerprintSkillRoots(dir)).toBe(before); // 删干净后回到原指纹
  });

  it('编辑 SKILL.md（mtime 变化）后指纹变化', () => {
    const root = join(dir, '.step-code', 'skills');
    const file = writeSkill(root, 'my-skill', SKILL_MD);
    const before = fingerprintSkillRoots(dir);
    // 显式拨动 mtime，避免文件系统时间精度导致误判不变
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);
    expect(fingerprintSkillRoots(dir)).not.toBe(before);
  });

  it('diff：新增/移除/变更分类正确', () => {
    const root = join(dir, '.step-code', 'skills');
    writeSkill(root, 'a', SKILL_MD.replace('name: my-skill', 'name: a'));
    writeSkill(root, 'b', SKILL_MD.replace('name: my-skill', 'name: b'));
    const prev = buildSkillRegistry(dir);

    // b 改描述（changed），删 a（removed），加 c（added）
    writeSkill(root, 'b', SKILL_MD.replace('name: my-skill', 'name: b').replace('做某件事', '改过'));
    rmSync(join(root, 'a'), { recursive: true, force: true });
    writeSkill(root, 'c', SKILL_MD.replace('name: my-skill', 'name: c'));
    const next = buildSkillRegistry(dir);

    const diff = diffSkillRegistries(prev, next);
    expect(diff.added).toEqual(['c']);
    expect(diff.removed).toEqual(['a']);
    expect(diff.changed).toEqual(['b']);
  });

  it('diff：内容未动时三数组皆空', () => {
    const root = join(dir, '.step-code', 'skills');
    writeSkill(root, 'a', SKILL_MD.replace('name: my-skill', 'name: a'));
    const reg = buildSkillRegistry(dir);
    const diff = diffSkillRegistries(reg, buildSkillRegistry(dir));
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });
});

describe('同名冲突收集（conflicts）', () => {
  const writeSkill = (root: string, name: string, md: string): void => {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'SKILL.md'), md);
  };

  it('同名 skill 被高优先级来源覆盖时记录冲突：winner 与 overridden 正确', () => {
    writeSkill(join(dir, '.agents', 'skills'), 'my-skill', SKILL_MD.replace('做某件事', '兼容目录版'));
    writeSkill(join(dir, '.step-code', 'skills'), 'my-skill', SKILL_MD.replace('做某件事', '原生目录版'));

    const reg = buildSkillRegistry(dir);
    expect(reg.conflicts).toHaveLength(1);
    const c = reg.conflicts![0]!;
    expect(c.name).toBe('my-skill');
    expect(c.winner.description).toBe('原生目录版');
    expect(c.winner.dir).toContain('.step-code');
    expect(c.overridden).toHaveLength(1);
    expect(c.overridden[0]!.description).toBe('兼容目录版');
    expect(c.overridden[0]!.dir).toContain('.agents');
  });

  it('无同名时 conflicts 为空数组', () => {
    writeSkill(join(dir, '.step-code', 'skills'), 'my-skill', SKILL_MD);
    const reg = buildSkillRegistry(dir);
    expect(reg.conflicts).toEqual([]);
  });

  it('冲突中的 skill 被 disabledSkills 排除后，冲突随之消失', () => {
    writeSkill(join(dir, '.agents', 'skills'), 'my-skill', SKILL_MD);
    writeSkill(join(dir, '.step-code', 'skills'), 'my-skill', SKILL_MD);
    const reg = buildSkillRegistry(dir, [], undefined, ['my-skill']);
    expect(reg.skills.has('my-skill')).toBe(false);
    expect(reg.conflicts).toEqual([]);
  });
});

describe('skillListing 预算压缩', () => {
  const makeReg = (n: number, descLen: number): SkillRegistry => {
    const skills = new Map<string, SkillDefinition>();
    for (let i = 0; i < n; i++) {
      skills.set(`skill-${i}`, {
        name: `skill-${i}`,
        description: 'x'.repeat(descLen),
        whenToUse: 'w'.repeat(descLen),
        content: 'c',
        dir: `/skills/skill-${i}`,
        source: 'user',
      });
    }
    return { skills };
  };

  it('预算内：全量输出（含 whenToUse）', () => {
    const listing = skillListing(makeReg(2, 20), 8000);
    expect(listing).toContain('何时用：');
    expect(listing).toContain('skill-0');
    expect(listing).toContain('skill-1');
  });

  it('超预算：先压缩描述（截断 + 去 whenToUse）', () => {
    // 让全量超预算但压缩后可容纳
    const listing = skillListing(makeReg(10, 300), 2500);
    expect(listing).not.toContain('何时用：'); // whenToUse 被去掉
    expect(listing).toContain('…'); // 描述被截断
    expect(listing).toContain('skill-9'); // 全部条目仍在
    expect(listing.length).toBeLessThanOrEqual(2500);
  });

  it('压缩后仍超预算：省略靠后条目并注明省略数', () => {
    const listing = skillListing(makeReg(60, 200), 1500);
    expect(listing).toContain('因篇幅省略');
    expect(listing).toContain('skill-0'); // 靠前条目保留
    expect(listing.length).toBeLessThanOrEqual(1500);
  });
});
