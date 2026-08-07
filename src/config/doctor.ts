/**
 * 无头（脱离 Ink/TTY）的 `step doctor config <path>` 子命令逻辑。
 *
 * 用途：配置文件覆盖写入前的独立校验（内置 update-config skill 变更协议的第 4 步），
 * 以及用户自查。只读，不改任何文件；退出码 0 = 通过（可有警告），非 0 = 失败。
 *
 * 与 loadConfig 的关系：两者共用 diagnostics.ts 的同一份警告规则，差别只在入口与时机——
 * 本模块对**指定路径**做校验（可在覆盖写入前先验一份草稿），loadConfig 只读固定路径且
 * 在启动时自检。语义校验复用 config.ts 导出的校验件：resolveThinkingConfig /
 * resolvePermissionMode / resolveProxy 是 loadConfig 会抛配置错误的环节，原样复用其报错；
 * 其余 resolver 对非法值静默跳过/钳制，统一降级为警告（未知顶层键、非法渠道 type、
 * 别名引用不可用渠道、hooks 非法 event 等），不改变既有加载行为。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { resolvePermissionMode, resolveProxy, resolveThinkingConfig, type ModelEntry, type ProviderEntry } from './config.js';
import { collectConfigWarnings, formatWarningZh } from './diagnostics.js';

/** 1x1 像素浅绿色 PNG（base64）：实测 image_in 能力用。 */
const TEST_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** capabilities 实测结果。 */
export interface CapabilityTestResult {
  /** 模型别名。 */
  alias: string;
  /** 真实模型 id。 */
  model: string;
  /** 渠道 id。 */
  provider: string;
  /** image_in 实测结果：true 支持 / false 不支持 / undefined 未测试（无 API key 或网络错误）。 */
  imageIn?: boolean;
  /** 实测失败的错误信息（model_incompatible / 网络错误等）。 */
  error?: string;
}

/**
 * 实测单个模型的 image_in 能力：发一个 1x1 像素 PNG，看是否返回 model_incompatible。
 * 按渠道 type 分发协议：openai → /chat/completions，anthropic/stepfun → /v1/messages。
 * @param entry 模型配置
 * @param channel 渠道配置
 * @returns 实测结果
 */
async function testImageInCapability(
  entry: ModelEntry,
  channel: ProviderEntry,
): Promise<{ supported: boolean; error?: string }> {
  const apiKey = channel.apiKey ?? process.env['STEP_CODE_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    return { supported: false, error: 'no_api_key' };
  }
  const baseUrl = (channel.baseUrl ?? 'https://api.stepfun.com').replace(/\/$/, '');
  const model = entry.model ?? '';
  const channelType = channel.type ?? 'openai';

  try {
    if (channelType === 'openai') {
      // Chat Completions 协议：user 消息带 image_url
      const body = {
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'test' },
              {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${TEST_IMAGE_BASE64}` },
              },
            ],
          },
        ],
        max_tokens: 1,
      };
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (
          text.includes('model_incompatible') ||
          text.includes('doesnt support image') ||
          text.includes('does not support image')
        ) {
          return { supported: false, error: 'model_incompatible' };
        }
        return { supported: false, error: `http_${res.status}` };
      }
      return { supported: true };
    } else {
      // Anthropic Messages 协议：user 消息带 image block
      const body = {
        model,
        max_tokens: 1,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'test' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: TEST_IMAGE_BASE64,
                },
              },
            ],
          },
        ],
      };
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (
          text.includes('model_incompatible') ||
          text.includes('doesnt support image') ||
          text.includes('does not support image')
        ) {
          return { supported: false, error: 'model_incompatible' };
        }
        return { supported: false, error: `http_${res.status}` };
      }
      return { supported: true };
    }
  } catch (e) {
    return { supported: false, error: (e as Error).message };
  }
}

/**
 * 实测配置里所有模型的 capabilities。
 * @param toml 配置文件的原始 TOML 对象
 * @returns 实测结果列表
 */
export async function testCapabilities(
  toml: Record<string, unknown>,
): Promise<CapabilityTestResult[]> {
  const results: CapabilityTestResult[] = [];
  const models = toml['models'] as Record<string, ModelEntry> | undefined;
  const providers = toml['providers'] as Record<string, Record<string, unknown>> | undefined;
  if (models === undefined || providers === undefined) return results;

  for (const [alias, entry] of Object.entries(models)) {
    const capabilities = entry.capabilities ?? [];
    // 只测声明了 image_in 的模型
    if (!capabilities.includes('image_in')) continue;

    const providerId = entry.provider ?? 'stepfun';
    const rawChannel = providers[providerId];
    if (rawChannel === undefined) {
      results.push({
        alias,
        model: entry.model ?? alias,
        provider: providerId,
        error: 'provider_not_found',
      });
      continue;
    }

    // TOML 字段名是 snake_case（base_url / api_key），ProviderEntry 是 camelCase（baseUrl / apiKey），需要转换
    const channel: ProviderEntry = {
      type: rawChannel['type'] as string,
      baseUrl: rawChannel['base_url'] as string | undefined,
      apiKey: rawChannel['api_key'] as string | undefined,
      apiKeyEnv: rawChannel['api_key_env'] as string | undefined,
    };

    const test = await testImageInCapability(entry, channel);
    results.push({
      alias,
      model: entry.model ?? alias,
      provider: providerId,
      imageIn: test.supported,
      error: test.error,
    });
  }
  return results;
}

/**
 * 顶层键清单的事实源已移到 diagnostics.ts（与启动自检共用同一份规则）。
 * 此处 re-export 保持既有导入路径可用（tests/skill/updateConfigDrift.test.ts 从本模块导入）。
 */
export { CONFIG_TOP_LEVEL_KEYS } from './diagnostics.js';

export interface DoctorConfigResult {
  /** 进程退出码：0 通过（可有警告），1 失败。 */
  code: 0 | 1;
  /** 通过/警告信息（含结尾换行），供调用点写 stdout。 */
  stdout?: string;
  /** 失败原因（含结尾换行），供调用点写 stderr。 */
  stderr?: string;
}

/** max_tokens 缺省基准（= config.ts 的 DEFAULT_MAX_TOKENS，未导出，此处保持一致）。 */
const DEFAULT_MAX_TOKENS = 65536;

/** 字节数人类可读格式化（仅用于 doctor 输出）。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

/**
 * 校验一份 config.toml：语法错误 / thinking 语义错误 → code 1；
 * 未知顶层键、非法渠道 type、hooks 非法 event 等 → 警告（code 0，逐条列出）。
 * @param path 要校验的文件路径；缺省为 ~/.step-code/config.toml
 * @param options.testCapabilities 是否实测 capabilities（发真实请求，需要 API key 和网络）
 */
export async function runDoctorConfig(
  path?: string,
  options?: { testCapabilities?: boolean },
): Promise<DoctorConfigResult> {
  const target = path ?? join(homedir(), '.step-code', 'config.toml');
  if (!existsSync(target)) {
    return { code: 1, stderr: `error: 配置文件不存在：${target}\n` };
  }
  let toml: unknown;
  try {
    toml = parseToml(readFileSync(target, 'utf8'));
  } catch (e) {
    return { code: 1, stderr: `error: TOML 解析失败：${(e as Error).message}\n` };
  }
  if (typeof toml !== 'object' || toml === null || Array.isArray(toml)) {
    return { code: 1, stderr: `error: 配置文件顶层必须是 TOML 表：${target}\n` };
  }
  const t = toml as Record<string, unknown>;

  // thinking 语义校验：复用 loadConfig 的抛错路径（budget 余量、default_level 命中）
  try {
    const maxTokens =
      typeof t['max_tokens'] === 'number' && Number.isFinite(t['max_tokens'])
        ? (t['max_tokens'] as number)
        : DEFAULT_MAX_TOKENS;
    resolveThinkingConfig(t['thinking'], maxTokens);
    // permission_mode 非法值同属 loadConfig 抛错路径（安全相关配置，不降级为警告）
    resolvePermissionMode(t['permission_mode']);
    // proxy 形态非法同属 loadConfig 抛错路径
    resolveProxy(t['proxy']);
  } catch (e) {
    return { code: 1, stderr: `error: ${(e as Error).message}\n` };
  }

  // 警告级问题（loadConfig 静默跳过/降级的项）走与启动自检共用的规则表
  const lines = [`ok: ${target} 解析与校验通过`];
  for (const w of collectConfigWarnings(t)) lines.push(`warn: ${formatWarningZh(w)}`);

  // media_keep_recent 配置提示（用户可能不知道这个键的存在，doctor 输出明示当前生效值）
  const mediaKeepRecent = t['media_keep_recent'];
  if (typeof mediaKeepRecent === 'number' && Number.isFinite(mediaKeepRecent)) {
    const n = Math.max(0, Math.floor(mediaKeepRecent));
    lines.push(`info: media_keep_recent = ${n}（媒体降级时保留最近 ${n} 张图，0 = 全部换占位）`);
  } else {
    lines.push(`info: media_keep_recent 未配置，缺省 10（媒体降级时保留最近 10 张图）`);
  }

  // [tools.web] 网页结果缓存配置提示
  const tools = t['tools'] as Record<string, unknown> | undefined;
  const webCfg = tools?.web as Record<string, unknown> | undefined;
  const maxSize = typeof webCfg?.max_size === 'number' ? Math.max(0, Math.floor(webCfg.max_size as number)) : undefined;
  const maxBytes = typeof webCfg?.max_bytes === 'number' ? Math.max(0, Math.floor(webCfg.max_bytes as number)) : undefined;
  const maxEntryBytes = typeof webCfg?.max_entry_bytes === 'number' ? Math.max(0, Math.floor(webCfg.max_entry_bytes as number)) : undefined;
  if (maxSize !== undefined || maxBytes !== undefined || maxEntryBytes !== undefined) {
    const parts: string[] = [];
    if (maxSize !== undefined) parts.push(`max_size=${maxSize}`);
    if (maxBytes !== undefined) parts.push(`max_bytes=${formatBytes(maxBytes)}`);
    if (maxEntryBytes !== undefined) parts.push(`max_entry_bytes=${formatBytes(maxEntryBytes)}`);
    lines.push(`info: [tools.web] ${parts.join(', ')}（网页结果缓存容量）`);
  } else {
    lines.push(`info: [tools.web] 未配置，缺省 100 条目 / 32MB 总字节 / 2MB 单条上限`);
  }

  // capabilities 实测（可选）：发真实请求验证 image_in 是否真实支持
  if (options?.testCapabilities === true) {
    lines.push('');
    lines.push('=== capabilities 实测 ===');
    const results = await testCapabilities(t);
    if (results.length === 0) {
      lines.push('（无声明 image_in 的模型，跳过实测）');
    } else {
      for (const r of results) {
        if (r.imageIn === true) {
          lines.push(`✓ ${r.alias}（${r.model}）：image_in 实测通过`);
        } else if (r.imageIn === false) {
          lines.push(`✗ ${r.alias}（${r.model}）：image_in 实测失败 — ${r.error ?? 'unknown'}`);
          lines.push(`  建议：从 [models.${r.alias}] 的 capabilities 里删掉 "image_in"`);
        } else {
          lines.push(`- ${r.alias}（${r.model}）：未实测 — ${r.error ?? 'unknown'}`);
        }
      }
    }
  }

  return { code: 0, stdout: `${lines.join('\n')}\n` };
}
