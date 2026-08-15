import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toWire } from '../../src/agent/wire.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { AttachmentStore } from '../../src/session/attachments.js';

let base: string;
let attachments: AttachmentStore;
const cwd = 'C:/some/project';

function bigBase64(bytes = 4000): string {
  return Buffer.alloc(bytes, 7).toString('base64');
}

function imageMsg(data: string): StoredMessage {
  return stored(
    {
      role: 'user',
      content: [
        { type: 'text', text: '看这张图' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
      ],
    },
    { kind: 'user' },
  );
}

/** 取一条 wire 消息里的图片块（若被替换成文本则返回 undefined）。 */
function imageBlock(msg: Anthropic.MessageParam): Anthropic.ImageBlockParam | undefined {
  const c = msg.content;
  if (typeof c === 'string') return undefined;
  return c.find((b): b is Anthropic.ImageBlockParam => b.type === 'image');
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stepcode-wire-'));
  attachments = new AttachmentStore(base);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('toWire', () => {
  it('无 opts 时纯投影，取内层 message', () => {
    const msgs = [stored({ role: 'user', content: 'hi' }, { kind: 'user' })];
    expect(toWire(msgs)).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('遇 stepref 图片块 rehydrate 回 base64', () => {
    const b64 = bigBase64();
    const ref = attachments.offload(cwd, b64, 'image/png');
    const wire = toWire([imageMsg(ref)], { attachments, cwd });
    const img = imageBlock(wire[0]!);
    expect(img).toBeDefined();
    expect(img!.source.type).toBe('base64');
    expect((img!.source as Anthropic.Base64ImageSource).data).toBe(b64);
  });

  it('附件缺失时把图片块换成 [image missing] 文本', () => {
    const b64 = bigBase64();
    const ref = attachments.offload(cwd, b64, 'image/png');
    rmSync(join(base), { recursive: true, force: true }); // 删掉整个附件目录
    const wire = toWire([imageMsg(ref)], { attachments, cwd });
    expect(imageBlock(wire[0]!)).toBeUndefined();
    const content = wire[0]!.content as Anthropic.ContentBlockParam[];
    expect(content.some((b) => b.type === 'text' && b.text === '[image missing]')).toBe(true);
    // 同条消息里的原文本块保留
    expect(content.some((b) => b.type === 'text' && b.text === '看这张图')).toBe(true);
  });

  it('原始 base64（非 stepref）图片块原样保留', () => {
    const b64 = bigBase64();
    const wire = toWire([imageMsg(b64)], { attachments, cwd });
    const img = imageBlock(wire[0]!);
    expect((img!.source as Anthropic.Base64ImageSource).data).toBe(b64);
  });

  it('无图消息不受影响', () => {
    const msgs = [
      stored({ role: 'user', content: 'plain' }, { kind: 'user' }),
      stored({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { kind: 'assistant' }),
    ];
    const wire = toWire(msgs, { attachments, cwd });
    expect(wire[0]!.content).toBe('plain');
    expect(wire[1]!.content).toEqual([{ type: 'text', text: 'ok' }]);
  });
});

describe('toWire · 视频块', () => {
  function videoMsg(data: string): StoredMessage {
    return stored(
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_v',
            content: [
              { type: 'text', text: '已读取视频' },
              { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data } },
            ],
          } as Anthropic.ToolResultBlockParam,
        ],
      },
      { kind: 'tool' },
    );
  }

  function videoBlockData(msg: Anthropic.MessageParam): string | undefined {
    const c = msg.content;
    if (typeof c === 'string') return undefined;
    const tr = c[0] as Anthropic.ToolResultBlockParam;
    const inner = tr.content as Array<{ type: string; source?: { data: string } }>;
    return inner.find((b) => b.type === 'video')?.source?.data;
  }

  it('遇 stepref 视频块 rehydrate 回 base64', () => {
    const b64 = bigBase64();
    const ref = attachments.offload(cwd, b64, 'video/mp4');
    const wire = toWire([videoMsg(ref)], { attachments, cwd });
    expect(videoBlockData(wire[0]!)).toBe(b64);
  });

  it('附件缺失时把视频块换成 [video missing] 文本', () => {
    const b64 = bigBase64();
    const ref = attachments.offload(cwd, b64, 'video/mp4');
    rmSync(join(base), { recursive: true, force: true });
    const wire = toWire([videoMsg(ref)], { attachments, cwd });
    expect(videoBlockData(wire[0]!)).toBeUndefined();
    const tr = (wire[0]!.content as Anthropic.ToolResultBlockParam[])[0]!;
    const inner = tr.content as Array<{ type: string; text?: string }>;
    expect(inner.some((b) => b.type === 'text' && b.text === '[video missing]')).toBe(true);
  });
});
