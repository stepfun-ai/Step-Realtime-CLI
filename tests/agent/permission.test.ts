import { describe, expect, it } from 'vitest';
import { decide, isReadOnly, planModeDenyReason } from '../../src/agent/permission/mode.js';

const NONE = new Set<string>();

describe('decide', () => {
  it('只读工具在任何模式下都放行', () => {
    for (const mode of ['manual', 'auto', 'yolo'] as const) {
      expect(decide('read_file', mode, NONE)).toBe('allow');
      expect(decide('read_media', mode, NONE)).toBe('allow');
      expect(decide('grep', mode, NONE)).toBe('allow');
      expect(decide('web_search', mode, NONE)).toBe('allow');
      expect(decide('web_image_search', mode, NONE)).toBe('allow');
      expect(decide('tool_search', mode, NONE)).toBe('allow');
      expect(decide('task_list', mode, NONE)).toBe('allow');
      expect(decide('task_output', mode, NONE)).toBe('allow');
      expect(decide('get_goal', mode, NONE)).toBe('allow');
      expect(decide('cron_list', mode, NONE)).toBe('allow');
    }
  });

  it('yolo 放行一切', () => {
    expect(decide('write_file', 'yolo', NONE)).toBe('allow');
    expect(decide('bash', 'yolo', NONE)).toBe('allow');
  });

  it('auto：写放行，bash 需确认', () => {
    expect(decide('write_file', 'auto', NONE)).toBe('allow');
    expect(decide('edit_file', 'auto', NONE)).toBe('allow');
    expect(decide('bash', 'auto', NONE)).toBe('ask');
  });

  it('manual：写与 bash 都需确认', () => {
    expect(decide('write_file', 'manual', NONE)).toBe('ask');
    expect(decide('bash', 'manual', NONE)).toBe('ask');
  });

  it('本会话已批准的工具直接放行', () => {
    const approved = new Set(['bash']);
    expect(decide('bash', 'manual', approved)).toBe('allow');
    expect(decide('bash', 'auto', approved)).toBe('allow');
  });

  it('未知工具保守起见需确认', () => {
    expect(decide('mystery_tool', 'auto', NONE)).toBe('ask');
    expect(decide('mystery_tool', 'manual', NONE)).toBe('ask');
  });
});

describe('isReadOnly', () => {
  it('区分只读与写工具', () => {
    expect(isReadOnly('read_file')).toBe(true);
    expect(isReadOnly('read_media')).toBe(true);
    expect(isReadOnly('tool_search')).toBe(true);
    expect(isReadOnly('task_list')).toBe(true);
    expect(isReadOnly('task_output')).toBe(true);
    expect(isReadOnly('get_goal')).toBe(true);
    expect(isReadOnly('cron_list')).toBe(true);
    expect(isReadOnly('write_file')).toBe(false);
    expect(isReadOnly('bash')).toBe(false);
  });
});

describe('planModeDenyReason', () => {
  it('read_media 属只读调查，plan 模式放行', () => {
    expect(planModeDenyReason('read_media')).toBeNull();
  });

  it('写与执行类工具在 plan 模式给出拒绝原因', () => {
    expect(planModeDenyReason('write_file')).not.toBeNull();
    expect(planModeDenyReason('bash')).not.toBeNull();
  });

  it('新增只读查询工具在 plan 模式放行', () => {
    expect(planModeDenyReason('tool_search')).toBeNull();
    expect(planModeDenyReason('task_list')).toBeNull();
    expect(planModeDenyReason('task_output')).toBeNull();
    expect(planModeDenyReason('get_goal')).toBeNull();
    expect(planModeDenyReason('cron_list')).toBeNull();
  });

  it('plan mode deny reason 文案包含 exit_plan_mode 引导', () => {
    const reason = planModeDenyReason('write_file');
    expect(reason).toContain('exit_plan_mode');
    expect(reason).toContain('write_file');
  });
});
