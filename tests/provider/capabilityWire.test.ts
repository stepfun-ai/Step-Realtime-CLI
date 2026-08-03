import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { StepfunAdapter } from '../../src/provider/adapter.js';
import { capabilitiesToOverride } from '../../src/provider/capability-registry.js';

/**
 * 端到端回归：证明 config.toml 的 capabilities 声明真正影响 wire 上的请求体。
 *
 * 此前 factory 从不下发 capabilityOverrides，声明只对工具门控（read_media 放行）
 * 生效、对请求整形无效：read_media 说能读图 → 图片进 messages → adapter 的 degrader
 * 按 image_in:false 把图片块换成占位文本 → 模型收到的请求里根本没有图。
 * 工具层放行、传输层静默剥离，且全程无报错。
 */
const IMAGE_BLOCK = {
  type: 'image' as const,
  source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' },
};

class MockInner {
  calls: { messages: Anthropic.MessageParam[] }[] = [];
  stream(params: { messages: Anthropic.MessageParam[] }) {
    this.calls.push({ messages: params.messages });
    return {
      async *[Symbol.asyncIterator]() {
        /* 不产出事件：本测只关心送出的请求体 */
      },
    } as unknown as ReturnType<Anthropic['messages']['stream']>;
  }
}

function sendImage(model: string, capabilities: string[] | undefined): string {
  const inner = new MockInner();
  const override = capabilitiesToOverride('stepfun', model, capabilities);
  const adapter = new StepfunAdapter({
    apiKey: 'k',
    baseUrl: 'http://example.invalid',
    model,
    maxTokens: 1000,
    inner: inner as unknown as ConstructorParameters<typeof StepfunAdapter>[0]['inner'],
    ...(override !== undefined ? { capabilityOverrides: [override] } : {}),
  });
  adapter.stream({ system: 's', tools: [], messages: [{ role: 'user', content: [IMAGE_BLOCK] }] });
  return JSON.stringify(inner.calls[0]!.messages);
}

describe('capabilities 声明到 wire 的端到端链路', () => {
  it('step-explore 声明 image_in：图片真正发到 wire，不被换成占位文本', () => {
    const wire = sendImage('step-explore', ['image_in']);
    expect(wire).toContain('base64');
    expect(wire).not.toContain('[image omitted');
  });

  it('step-explore 未声明：默认也保留图片（默认支持，不静默剥离）', () => {
    const wire = sendImage('step-explore', undefined);
    expect(wire).toContain('base64');
  });

  it('step-3.7-flash 未声明：不因删掉 step-3 前缀表而丢图片能力', () => {
    const wire = sendImage('step-3.7-flash', undefined);
    expect(wire).toContain('base64');
  });

  it('声明里只有 video_in 时不产生 override，图片仍走默认保留', () => {
    const wire = sendImage('step-explore', ['video_in']);
    expect(wire).toContain('base64');
  });
});
