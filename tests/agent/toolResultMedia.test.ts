import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  estimateTokens,
  replaceMediaPartsWithMarkers,
  serializeContent,
} from '../../src/agent/compaction/compact.js';
import { runAgent } from '../../src/agent/loop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { toWire } from '../../src/agent/wire.js';
import { SessionStore } from '../../src/session/store.js';
import { clearDynamicTools, registerDynamicTool } from '../../src/tools/index.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';

const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');

/** 造一条 tool_result 内嵌 [text, image] 块数组的 storage 消息。 */
function toolResultMsg(imageData: string, text = '看图'): StoredMessage {
  return stored(
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu1',
          content: [
            { type: 'text', text },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
          ],
        },
      ],
    },
    { kind: 'tool' },
  );
}

afterEach(() => {
  clearDynamicTools();
});

describe('ToolResult.images → tool_result 内嵌图片', () => {
  it('runTurn：工具带 images 的结果回灌为 [text, image] 块数组，tool_end 事件仍只回 text', async () => {
    registerDynamicTool({
      name: 'fake_image_tool',
      description: 'test',
      schema: z.object({}),
      execute: async () => ({
        content: '这是图片说明',
        isError: false,
        images: [{ mediaType: 'image/png', base64: PNG_B64 }],
      }),
    });
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'fake_image_tool', {})] },
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const messages: StoredMessage[] = [stored({ role: 'user', content: '读图' }, { kind: 'user' })];
    const events = await collect(runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages }));

    // tool_end 事件只回 text 部分
    const toolEnd = events.find((e) => e.type === 'tool_end');
    expect(toolEnd).toBeDefined();
    expect((toolEnd as { result: string }).result).toBe('这是图片说明');

    // 历史里的 tool_result content 升格为 [text, image] 块数组
    const m = messages.find(
      (mm) => mm.message.role === 'user' && Array.isArray(mm.message.content),
    )!;
    const block = (m.message.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(block.type).toBe('tool_result');
    expect(Array.isArray(block.content)).toBe(true);
    const inner = block.content as Anthropic.ContentBlockParam[];
    expect(inner[0]).toEqual({ type: 'text', text: '这是图片说明' });
    expect(inner[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG_B64 },
    });
  });

  it('estimateTokens：内嵌 image 计 PER_IMAGE_TOKENS，1MB base64 不计入文本', async () => {
    const bigBase64 = Buffer.alloc(1024 * 1024, 7).toString('base64'); // ≈1.4M 字符
    const estimate = estimateTokens([toolResultMsg(bigBase64)]);
    // 若走旧的 JSON.stringify 整块计数，会虚增到几十万；下钻后只有 text + 常数 + 外壳
    expect(estimate).toBeLessThan(5000);
    expect(estimate).toBeGreaterThanOrEqual(1500); // PER_IMAGE_TOKENS
  });

  it('replaceMediaPartsWithMarkers：tool_result 内嵌 image 换 marker', () => {
    const { messages, changed } = replaceMediaPartsWithMarkers([toolResultMsg(PNG_B64)]);
    expect(changed).toBe(true);
    const block = (messages[0]!.message.content as Anthropic.ToolResultBlockParam[])[0]!;
    const inner = block.content as Anthropic.ContentBlockParam[];
    expect(inner.some((b) => b.type === 'text' && b.text === '[image]')).toBe(true);
    expect(inner.some((b) => b.type === 'image')).toBe(false);
    // 内嵌 text 保留
    expect(inner.some((b) => b.type === 'text' && b.text === '看图')).toBe(true);
  });

  it('serializeContent：tool_result 内嵌 image 序列化为 [image ...] 文本，不泄漏 base64', () => {
    const out = serializeContent(toolResultMsg(PNG_B64).message.content);
    expect(out).toContain('[工具结果]');
    expect(out).toContain('[image image/png]');
    expect(out).toContain('看图');
    expect(out).not.toContain(PNG_B64);
  });
});

describe('wire：tool_result 内嵌图片的 stepref 双向', () => {
  let base: string;
  const cwd = 'C:/some/project';

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'stepcode-wire-media-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('落盘 offload 成 stepref → toWire rehydrate 回 base64（往返）', () => {
    const store = new SessionStore(base);
    const bigBase64 = Buffer.alloc(5000, 7).toString('base64'); // > OFFLOAD_THRESHOLD
    const session = store.create(cwd, 'm');
    session.messages.push(toolResultMsg(bigBase64));
    store.save(session);

    const loaded = store.load(cwd, session.id)!;
    const block = (loaded.messages[0]!.message.content as Anthropic.ToolResultBlockParam[])[0]!;
    const inner = block.content as Anthropic.ContentBlockParam[];
    const img = inner.find((b) => b.type === 'image') as Anthropic.ImageBlockParam | undefined;
    // 持久化方向：内嵌图片已 stepref 化
    expect(img).toBeDefined();
    expect((img!.source as Anthropic.Base64ImageSource).data.startsWith('stepref:')).toBe(true);

    // rehydrate 方向：发 provider 前还原
    const wire = toWire(loaded.messages, { attachments: store.attachments, cwd });
    const wBlock = (wire[0]!.content as Anthropic.ToolResultBlockParam[])[0]!;
    const wInner = wBlock.content as Anthropic.ContentBlockParam[];
    const wImg = wInner.find((b) => b.type === 'image') as Anthropic.ImageBlockParam;
    expect((wImg.source as Anthropic.Base64ImageSource).data).toBe(bigBase64);
  });

  it('附件缺失时内嵌 stepref 图片换成 [image missing] 文本', () => {
    const store = new SessionStore(base);
    const bigBase64 = Buffer.alloc(5000, 7).toString('base64');
    const session = store.create(cwd, 'm');
    session.messages.push(toolResultMsg(bigBase64));
    store.save(session);
    const loaded = store.load(cwd, session.id)!;
    rmSync(base, { recursive: true, force: true }); // 删掉整个附件目录

    const wire = toWire(loaded.messages, { attachments: store.attachments, cwd });
    const wBlock = (wire[0]!.content as Anthropic.ToolResultBlockParam[])[0]!;
    const wInner = wBlock.content as Anthropic.ContentBlockParam[];
    expect(wInner.some((b) => b.type === 'image')).toBe(false);
    expect(wInner.some((b) => b.type === 'text' && b.text === '[image missing]')).toBe(true);
  });
});
