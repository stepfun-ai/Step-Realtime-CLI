import { describe, expect, it } from 'vitest';
import { planModeDenyReason } from '../../src/agent/permission/mode.js';
import { exitPlanModeTool } from '../../src/tools/exitPlanMode.js';

describe('planModeDenyReason（plan 模式守卫）', () => {
  it('写 / 执行类工具被硬拦截', () => {
    expect(planModeDenyReason('write_file')).not.toBeNull();
    expect(planModeDenyReason('edit_file')).not.toBeNull();
    expect(planModeDenyReason('bash')).not.toBeNull();
  });

  it('只读调查工具放行', () => {
    expect(planModeDenyReason('read_file')).toBeNull();
    expect(planModeDenyReason('glob')).toBeNull();
    expect(planModeDenyReason('grep')).toBeNull();
    expect(planModeDenyReason('list_dir')).toBeNull();
    expect(planModeDenyReason('web_search')).toBeNull();
  });

  it('exit_plan_mode 放行（宿主拦下确认）', () => {
    expect(planModeDenyReason('exit_plan_mode')).toBeNull();
  });
});

describe('exit_plan_mode 工具', () => {
  it('提交计划返回成功', async () => {
    const r = await exitPlanModeTool.execute({ plan: '步骤 1：读文件\n步骤 2：改代码' }, { cwd: process.cwd() });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('已提交');
  });
});
