import type Anthropic from '@anthropic-ai/sdk';
import { applyReprojectionLevel, nextReprojectionLevel, type ReprojectionLevel } from './degrader.js';
import type { ChatProvider } from './types.js';

/**
 * 全通道媒体降级 wrapper：给任意 ChatProvider 包上「媒体超限 → 降级重投影 → 重试」。
 *
 * 背景：StepfunAdapter 的 send() 里实现了错误驱动重投影（413/400 → 沿
 * normal → media-degraded → media-stripped → strict 逐档降级重发），但那套
 * 循环绑死在 stepfun adapter 内，anthropic / openai / openai_responses 通道
 * 遇到同样的超限（Anthropic `image exceeds 5 MB maximum`、Gemini `10 image
 * links`、通用 `Payload Too Large`）只能直接抛错——历史里滞留的超限图会让
 * 会话永久损坏（公开 issue 里有挂数月未修的真实事故）。
 *
 * 这个 wrapper 把重投影循环抽成通道无关的装饰器：包在任何 ChatProvider 外，
 * stream 抛错时按 degrader 的方言识别（isReprojectableError）判断能否降级，
 * 能则换消息重发，每档每请求最多一次（used 集合熔断，防 400 无限循环）。
 *
 * 与 withHistoryNormalization 正交：那个管历史结构整形，这个管发送时的媒体
 * 降级兜底，包装顺序无所谓（一个请求前整形、一个发送时兜底）。
 *
 * 实现要点：ChatProvider.stream 是同步返回流句柄的接口，重试只能发生在
 * finalMessage 的异步阶段。因此本 wrapper 返回一个代理流句柄：原样透传所有
 * 流式事件（on/once 等），只重写 finalMessage——内部跑降级重试循环，对调用方
 * 表现为一次 finalMessage 调用（与 StepfunAdapter.send() 的语义一致）。
 */

/** wrapper 构造参数。 */
export interface MediaDegradationOptions {
  /**
   * media-degraded 档保留的最近图片张数（config.toml media_keep_recent）。
   * 缺省 10（step-3.7 实测 60 张上限的 1/6 安全值，日常几乎不触发、触发时
   * 保留足够上下文）；0 = 全部换占位（旧行为）。
   */
  keepRecentImages?: number;
}

type StreamHandle = ReturnType<ChatProvider['stream']>;
type StreamParams = Parameters<ChatProvider['stream']>[0];

/**
 * 包装一个 ChatProvider：stream 的 finalMessage 遇可重投影错误时沿降级链重试。
 * 其他属性/方法原样透传（用原型链 + 属性拷贝保留 inner 的完整形态）。
 */
export function withMediaDegradation<T extends ChatProvider>(
  inner: T,
  options: MediaDegradationOptions = {},
): T {
  const keepRecent = options.keepRecentImages ?? 10;
  const wrapped = Object.create(Object.getPrototypeOf(inner)) as T;
  Object.assign(wrapped, inner);
  wrapped.stream = (params: StreamParams): StreamHandle =>
    wrapStream(inner, params, keepRecent);
  return wrapped;
}

/** 发起一次 stream 并代理其 finalMessage：遇可重投影错误沿降级链重发。 */
function wrapStream(inner: ChatProvider, params: StreamParams, keepRecent: number): StreamHandle {
  const used = new Set<ReprojectionLevel>(['normal']);
  const first = inner.stream(params);
  return new Proxy(first, {
    get(target, prop, receiver) {
      if (prop !== 'finalMessage') {
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      }
      return async (): Promise<Anthropic.Message> => {
        let messages = params.messages;
        let stream = target;
        for (;;) {
          try {
            return await stream.finalMessage();
          } catch (err) {
            const level = nextReprojectionLevel(err, used);
            if (level === null) throw err;
            used.add(level);
            messages = applyReprojectionLevel(messages, level, keepRecent);
            stream = inner.stream({ ...params, messages });
          }
        }
      };
    },
  });
}
