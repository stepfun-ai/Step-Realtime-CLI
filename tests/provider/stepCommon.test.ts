import { describe, expect, it } from 'vitest';
import {
  isStepEffort,
  mapStepChatFinishReason,
  mapStepResponsesStatus,
  normalizeStepMessagesStopReason,
  stepEffortParam,
  STEP_EFFORTS,
} from '../../src/provider/step/stepCommon.js';

describe('STEP_EFFORTS / isStepEffort', () => {
  it('档位取值域为 low / medium / high', () => {
    expect([...STEP_EFFORTS]).toEqual(['low', 'medium', 'high']);
  });

  it('非法值一律判否（Step 服务端不校验，客户端必须自己收敛）', () => {
    expect(isStepEffort('low')).toBe(true);
    expect(isStepEffort('xhigh')).toBe(false);
    expect(isStepEffort('none')).toBe(false);
    expect(isStepEffort('')).toBe(false);
    expect(isStepEffort(undefined)).toBe(false);
    expect(isStepEffort(4096)).toBe(false);
  });
});

describe('stepEffortParam（三接口参数名与嵌套各不相同）', () => {
  it('messages 用 output_config.effort（官方文档写法），不用官方 thinking.budget_tokens', () => {
    // 曾经断言顶层 { effort }，那是错的：Step 对未知参数静默忽略，「不报错」证明不了「生效」。
    // 官方 step-3.7-flash 文档：「Messages API 使用 output_config.effort」。
    expect(stepEffortParam('messages', 'low')).toEqual({ output_config: { effort: 'low' } });
    expect(stepEffortParam('messages', 'low')).not.toHaveProperty('thinking');
    expect(stepEffortParam('messages', 'low')).not.toHaveProperty('effort');
  });

  it('chat 用顶层 reasoning_effort', () => {
    expect(stepEffortParam('chat', 'medium')).toEqual({ reasoning_effort: 'medium' });
  });

  it('responses 用嵌套 reasoning.effort', () => {
    expect(stepEffortParam('responses', 'high')).toEqual({ reasoning: { effort: 'high' } });
  });

  it('effort 为 undefined → 空对象（不发字段）', () => {
    for (const ch of ['messages', 'chat', 'responses'] as const) {
      expect(stepEffortParam(ch, undefined)).toEqual({});
    }
  });
});

describe('mapStepChatFinishReason', () => {
  it('Step 声明的三个值', () => {
    expect(mapStepChatFinishReason('stop', false)).toBe('end_turn');
    expect(mapStepChatFinishReason('length', false)).toBe('max_tokens');
    expect(mapStepChatFinishReason('tool_calls', false)).toBe('tool_use');
  });

  it('OpenAI 官方额外两个值不再被吞成 end_turn', () => {
    expect(mapStepChatFinishReason('content_filter', false)).toBe('refusal');
    expect(mapStepChatFinishReason('function_call', false)).toBe('tool_use');
  });

  it('无信号（null/空串/未知）→ null，不冒充正常结束', () => {
    expect(mapStepChatFinishReason(null, false)).toBeNull();
    expect(mapStepChatFinishReason('', false)).toBeNull();
    expect(mapStepChatFinishReason(undefined, false)).toBeNull();
    expect(mapStepChatFinishReason('brand_new_reason', false)).toBeNull();
  });

  it('有工具调用时优先判 tool_use（兜底网关漏 finish_reason）', () => {
    expect(mapStepChatFinishReason(null, true)).toBe('tool_use');
    expect(mapStepChatFinishReason('stop', true)).toBe('tool_use');
  });
});

describe('mapStepResponsesStatus', () => {
  it('incomplete + max_output_tokens → max_tokens（此前被当成正常结束）', () => {
    expect(mapStepResponsesStatus('incomplete', 'max_output_tokens', false)).toBe('max_tokens');
  });

  it('incomplete 无 reason 时同样判 max_tokens，不判正常', () => {
    expect(mapStepResponsesStatus('incomplete', undefined, false)).toBe('max_tokens');
  });

  it('incomplete + content_filter → refusal', () => {
    expect(mapStepResponsesStatus('incomplete', 'content_filter', false)).toBe('refusal');
  });

  it('completed 按有无工具调用区分', () => {
    expect(mapStepResponsesStatus('completed', undefined, false)).toBe('end_turn');
    expect(mapStepResponsesStatus('completed', undefined, true)).toBe('tool_use');
  });

  it('failed / 中间态 / 缺失 → null（交上层分型）', () => {
    expect(mapStepResponsesStatus('failed', undefined, false)).toBeNull();
    expect(mapStepResponsesStatus('in_progress', undefined, false)).toBeNull();
    expect(mapStepResponsesStatus('cancelled', undefined, false)).toBeNull();
    expect(mapStepResponsesStatus(undefined, undefined, false)).toBeNull();
  });
});

describe('normalizeStepMessagesStopReason', () => {
  it('Step 声明的三个值 + 实测的 stop_sequence 全部透传', () => {
    expect(normalizeStepMessagesStopReason('end_turn')).toBe('end_turn');
    expect(normalizeStepMessagesStopReason('tool_use')).toBe('tool_use');
    expect(normalizeStepMessagesStopReason('max_tokens')).toBe('max_tokens');
    expect(normalizeStepMessagesStopReason('stop_sequence')).toBe('stop_sequence');
  });

  it('官方另有的 pause_turn / refusal 透传', () => {
    expect(normalizeStepMessagesStopReason('pause_turn')).toBe('pause_turn');
    expect(normalizeStepMessagesStopReason('refusal')).toBe('refusal');
  });

  it('空值 / 未知值 → null', () => {
    expect(normalizeStepMessagesStopReason(null)).toBeNull();
    expect(normalizeStepMessagesStopReason('')).toBeNull();
    expect(normalizeStepMessagesStopReason(undefined)).toBeNull();
    expect(normalizeStepMessagesStopReason('weird')).toBeNull();
  });
});
