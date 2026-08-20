/**
 * 压缩摘要绑定解析：把 `[compaction] model` 解析成「用哪个 provider + 哪个模型」做摘要。
 *
 * 背景：`[compaction] model` 原先只作为模型 id 透传给主会话 provider 的 `stream({ model })`，
 * 因此只能换「同一渠道下的另一个模型」——想让摘要走另一个渠道（不同 base_url / api_key /
 * 协议，如主会话走 anthropic 通道、摘要走 Step Plan 的 openai 通道）做不到，
 * 把跨渠道模型 id 发给主渠道端点通常直接 400。
 *
 * 现在解析规则（与 `/model`、子 agent 角色模型同一套别名机制）：
 * - 未配置 → 空绑定，压缩沿用主会话 provider 与模型（历史行为不变）。
 * - 命中 `[models.<别名>]` → 走 {@link resolveModelEntry} 的渠道/密钥回落链，用
 *   {@link createProvider} 建**独立 provider**，摘要请求打该别名自己的端点与密钥。
 * - 未命中别名 → 当作裸模型 id，只回 model，由主会话 provider 的 model 覆盖承接（旧行为）。
 * - 别名命中但 provider 构造失败（如该渠道没配 key）→ **整体放弃覆盖**、回退主会话模型，
 *   而不是把跨渠道模型 id 发给主渠道（那会在每次压缩时稳定 400，等于上下文兜底失效）。
 *
 * 刻意不做「渠道与主会话相同则复用主 provider 实例」的优化：主会话 provider 会随
 * `/model`、`/provider`、`/reload` 在运行期换渠道，复用判断要跟着这些运行态走才不出错，
 * 而多一个 SDK 客户端实例的成本可忽略（子 agent 角色模型已是同一口径）。
 *
 * 纯装配，不做 I/O；构造失败只记日志不抛错——压缩是兜底路径，不该因配置问题掀翻会话。
 */
import { DEFAULT_THINKING_LEVELS, resolveModelEntry, type StepCodeConfig } from '../config/config.js';
import { logError } from '../utils/logger.js';
import { createProvider } from './factory.js';
import type { ChatProvider } from './types.js';

/** 压缩摘要绑定：两者皆可缺省，缺省即沿用主会话对应项。 */
export interface CompactionBinding {
  /** 摘要专用 provider 实例（命中别名时才有）；省略 = 用主会话 provider。 */
  provider?: ChatProvider;
  /** 摘要模型 id；省略 = 用 provider 的构造默认模型。 */
  model?: string;
}

/**
 * 解析压缩摘要模型为压缩摘要绑定。
 *
 * @param config 配置（取 `compaction.model` 与 `[models]`/`[providers]` 表）
 * @param cache 按别名缓存的 provider 实例（调用方持有，跨 `/reload` 由调用方决定是否清空）；
 *   省略则每次调用新建实例
 * @param override 会话级覆盖（`/compact-model` 命令设置）：非 undefined 时取代
 *   `config.compaction.model` 参与解析，解析规则与 config 来源完全一致（同一事实源）
 */
export function resolveCompactionBinding(
  config: StepCodeConfig,
  cache?: Map<string, ChatProvider>,
  override?: string,
): CompactionBinding {
  const name = override ?? config.compaction.model;
  if (name === undefined || name === '') return {};

  const resolved = resolveModelEntry(config, name);
  // 不是别名（或别名显式指向了不存在的渠道）：按裸模型 id 处理，交给主会话 provider 的 model 覆盖
  if (resolved === null) return { model: name };

  const cached = cache?.get(name);
  if (cached !== undefined) return { provider: cached, model: resolved.model };

  try {
    // 压缩摘要压到最低思考档（按模型能力门控）：摘要是机械交接任务，不需要推理深度；
    // 更关键的是思考模型面对 20 万 token 级的历史输入时思考量爆炸，吃光 max_tokens
    // 导致摘要正文为空、质量闸门连续拦截后放弃压缩（2026-08-11 实测现场：
    // step-3.5-flash-2603 @ step_plan，max_tokens=50 探测请求 content 为空、reasoning 满
    // ——不发 effort 时阶跃服务端默认思考深度≈high；发 low 后同请求正文正常）。
    // 门控：仅当模型 capabilities 声明 'thinking' 才注入 enabled+low——非思考模型
    // 强发 effort 可能 400（stepfun 实测部分模型如此），不发字段天然安全。
    // 注入后构造默认即 {level:'low', budgetTokens:1024}，不受用户主 [thinking] 配置
    // 影响；该 provider 实例仅用于压缩，无副作用面。
    const modelCanThink = resolved.capabilities?.includes('thinking') === true;
    const provider = createProvider(
      modelCanThink
        ? {
            ...resolved,
            thinking: {
              enabled: true,
              defaultLevel: 'low',
              levels: resolved.thinking?.levels ?? DEFAULT_THINKING_LEVELS,
            },
          }
        : resolved,
    );
    cache?.set(name, provider);
    return { provider, model: resolved.model };
  } catch (e) {
    // 跨渠道 provider 建不起来时不能退化成「把跨渠道模型 id 发给主渠道」——那是稳定失败。
    // 整体放弃覆盖，压缩回落主会话模型（能压缩比压缩失败重要）。
    logError(`[compaction] 模型别名 "${name}" 的渠道无法构造，压缩回退主会话模型：${(e as Error).message}`);
    return {};
  }
}
