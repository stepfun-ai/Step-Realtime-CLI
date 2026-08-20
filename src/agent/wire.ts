import type Anthropic from '@anthropic-ai/sdk';
import { mapBlocksDeep, type AnyContentBlock, type StoredMessage } from './message.js';
import type { AttachmentStore } from '../session/attachments.js';
import { isStepref } from '../session/attachments.js';

/** rehydrate 所需的附件上下文：从哪个 workdir 桶读附件、用哪个 store 读。 */
export interface WireOptions {
  attachments: AttachmentStore;
  cwd: string;
}

/** 附件缺失时的占位文本。 */
const IMAGE_MISSING = '[image missing]';
const VIDEO_MISSING = '[video missing]';

/**
 * 把一条 wire 消息里的 stepref 媒体块还原成 base64（下钻 tool_result 的数组 content，
 * read_media 回传的内嵌图片/视频同样处理）：
 * - `source.data` 是 `stepref:<hash>` → 读回附件文件填回 base64；文件缺失则整块换成文本占位。
 * - 其它块（含原始 base64 媒体）原样保留。无媒体消息返回同引用。
 */
function rehydrateMessage(msg: Anthropic.MessageParam, opts: WireOptions): Anthropic.MessageParam {
  const mapped = mapBlocksDeep(msg.content, (block) => {
    if ((block.type !== 'image' && block.type !== 'video') || block.source.type !== 'base64') return block;
    if (!isStepref(block.source.data)) return block;
    const base64 = opts.attachments.rehydrate(opts.cwd, block.source.data);
    if (base64 === null) {
      return {
        type: 'text',
        text: block.type === 'video' ? VIDEO_MISSING : IMAGE_MISSING,
      } satisfies Anthropic.TextBlockParam;
    }
    return { ...block, source: { ...block.source, data: base64 } } as AnyContentBlock;
  });
  return mapped.changed ? { ...msg, content: mapped.content } : msg;
}

/**
 * 唯一的 wire 边界：storage（StoredMessage[]）→ 发给 Anthropic 的干净 MessageParam[]。
 *
 * 信封结构下内层 `message` 本身即 wire 格式，这里取内层即可，元数据（origin/id/ts）在外层被丢弃。
 * 所有发 provider 的路径（主循环 / 子 agent / 压缩摘要请求）都必须过这里——
 * 配合 provider.stream / runTurn 只接受 MessageParam[] 的类型签名，StoredMessage[] 直传会被 tsc 挡下。
 *
 * 过滤点：传入 opts（附件 store + cwd）时，对图片块做 rehydrate（含 tool_result 数组 content
 * 内嵌的图片块）——resume 读盘后的消息里图片是
 * `stepref:<hash>` 指针，发 provider 前在此读回 base64（缺失换 `[image missing]`）。正常运行时内存
 * message 里本就是原始 base64（落盘 offload 只作用于副本），不含 stepref、rehydrate 不触发。
 * 不传 opts 时纯投影（无附件上下文的场景，如压缩摘要请求），保持向后兼容。
 */
export function toWire(messages: readonly StoredMessage[], opts?: WireOptions): Anthropic.MessageParam[] {
  if (opts === undefined) return messages.map((m) => m.message);
  return messages.map((m) => rehydrateMessage(m.message, opts));
}
