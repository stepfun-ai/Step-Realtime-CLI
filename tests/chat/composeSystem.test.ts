import { describe, expect, it } from 'vitest';
import { composeSystem, type SystemParts } from '../../src/chat/composeSystem.js';

const base: SystemParts = {
  prefix: 'PREFIX',
  skills: '\n\nSKILLS',
  subagents: '\n\nSUBAGENTS',
  agentsMd: '',
  memory: '',
  sessionContext: '',
};

describe('composeSystem 段序与可选段', () => {
  it('只有必填段时不产生多余空行', () => {
    expect(composeSystem(base)).toBe('PREFIX\n\nSKILLS\n\nSUBAGENTS');
  });

  it('段序固定：prefix → skills → subagents → AGENTS.md → memory → SessionStart', () => {
    const out = composeSystem({
      ...base,
      agentsMd: 'AGENTS',
      memory: 'MEMORY',
      sessionContext: 'HOOKCTX',
    });
    // 用下标关系断言顺序，避免把整段格式写死
    const iAgents = out.indexOf('AGENTS');
    const iMemory = out.indexOf('MEMORY');
    const iHook = out.indexOf('HOOKCTX');
    expect(iAgents).toBeGreaterThan(out.indexOf('SUBAGENTS'));
    expect(iMemory).toBeGreaterThan(iAgents);
    expect(iHook).toBeGreaterThan(iMemory);
  });

  it('memory 段开启时必须出现在 system 里（曾整块漏掉，主 agent 拿不到记忆）', () => {
    const withMemory = composeSystem({ ...base, memory: '## 记忆\n- 观察一' });
    expect(withMemory).toContain('## 记忆');
    expect(withMemory).toContain('观察一');
    // 未开启时不留空行残渣
    expect(composeSystem(base)).not.toContain('\n\n\n');
  });

  it('SessionStart hook 的 stdout 非空才拼接（曾没有执行点，注入永远为空）', () => {
    expect(composeSystem({ ...base, sessionContext: 'CTX' })).toContain('CTX');
    expect(composeSystem({ ...base, sessionContext: '' })).toBe('PREFIX\n\nSKILLS\n\nSUBAGENTS');
  });

  it('三个可选段任意组合都不产生连续三个换行', () => {
    for (const agentsMd of ['', 'A']) {
      for (const memory of ['', 'M']) {
        for (const sessionContext of ['', 'S']) {
          const out = composeSystem({ ...base, agentsMd, memory, sessionContext });
          expect(out).not.toContain('\n\n\n');
        }
      }
    }
  });
});
