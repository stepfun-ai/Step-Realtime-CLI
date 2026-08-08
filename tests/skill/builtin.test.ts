import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS } from '../../src/skill/builtin/index.js';
import { UPDATE_CONFIG_SKILL } from '../../src/skill/builtin/updateConfig.js';
import { buildSkillRegistry, renderSkillActivation, skillListing } from '../../src/skill/registry.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stepcode-builtin-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SHADOW_MD = `---\nname: update-config\ndescription: 项目自定义版\n---\n项目自定义正文。`;

describe('builtin skill 注册', () => {
  it('update-config 以 builtin 来源进注册表', () => {
    const reg = buildSkillRegistry(dir);
    const def = reg.skills.get('update-config');
    expect(def).toBeDefined();
    expect(def!.source).toBe('builtin');
    expect(def!.dir).toBe('builtin://update-config');
  });

  it('builtin 优先级最低：项目级同名 skill shadow 并记入冲突', () => {
    const shadowDir = join(dir, '.step-code', 'skills', 'update-config');
    mkdirSync(shadowDir, { recursive: true });
    writeFileSync(join(shadowDir, 'SKILL.md'), SHADOW_MD);
    const reg = buildSkillRegistry(dir);
    expect(reg.skills.get('update-config')!.source).toBe('project');
    const conflict = reg.conflicts?.find((c) => c.name === 'update-config');
    expect(conflict).toBeDefined();
    expect(conflict!.overridden.map((d) => d.source)).toContain('builtin');
  });

  it('disabledSkills 按名排除对 builtin 同样生效', () => {
    const reg = buildSkillRegistry(dir, [], [], ['update-config']);
    expect(reg.skills.has('update-config')).toBe(false);
  });

  it('清单含 update-config 但不含正文（懒加载）', () => {
    const reg = buildSkillRegistry(dir);
    const listing = skillListing(reg);
    expect(listing).toContain('update-config');
    expect(listing).not.toContain('配置根定位');
  });

  it('激活渲染注入正文', () => {
    const rendered = renderSkillActivation(UPDATE_CONFIG_SKILL, '');
    expect(rendered).toContain('<step-skill-loaded name="update-config" source="builtin">');
    expect(rendered).toContain('变更协议');
    expect(rendered).toContain('step doctor config');
  });

  it('BUILTIN_SKILLS 清单即当前全部内置 skill', () => {
    expect(BUILTIN_SKILLS.map((s) => s.name)).toEqual(['update-config', 'team']);
  });
});
