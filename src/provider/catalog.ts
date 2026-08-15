/**
 * models.dev 供应商目录：拉取、解析、元数据映射、状态过滤。
 *
 * 目录结构（api.json）：顶层是 { providerId: providerEntry }；provider 条目
 * { id, api, env[], npm, name, models{} }；模型条目 { id, name, reasoning,
 * modalities:{input,output}, limit:{context}, status? }。
 *
 * 映射规则（/provider add 目录导入路径的预填逻辑）：
 * - api → base_url；
 * - npm 推断协议 type：@ai-sdk/openai-compatible → openai、@ai-sdk/anthropic → anthropic、
 *   其余 → openai 并标 typeUnverified（待验证）；
 * - env[0] → 惯例环境变量名提示（api_key_env 候选）；
 * - 每模型 limit.context → max_context_size、reasoning → thinking、
 *   modalities.input 含 image/video/audio → image_in/video_in/audio_in；
 * - status 为 deprecated / alpha 的模型过滤掉；过滤后无模型的供应商整条剔除。
 *
 * 网络：走全局 fetch（启动时 NODE_USE_ENV_PROXY=1 已默认开启，HTTPS_PROXY /
 * config proxy 注入后自动生效，见 cli.ts 的代理注入），本模块不处理代理细节。
 */
import { existsSync, readFileSync } from 'node:fs';

/** 默认目录地址（可用 /provider add --url 覆盖为镜像或本地文件路径）。 */
export const DEFAULT_CATALOG_URL = 'https://models.dev/api.json';

/** 目录里一个模型的归一化结果（只保留向导用得上的字段）。 */
export interface CatalogModel {
  id: string;
  /** 展示名（目录 name 字段），缺省 undefined（向导回落 id）。 */
  name?: string;
  /** 上下文窗口（limit.context），缺省 undefined（别名单不写 max_context_size）。 */
  context?: number;
  /** 能力标记（thinking / image_in / video_in / audio_in），可为空数组。 */
  capabilities: string[];
}

export interface CatalogProvider {
  id: string;
  /** 供应商显示名（目录 name 字段），缺省回落 id。 */
  name: string;
  /** api 字段 → base_url；缺省 undefined（导入时不写 base_url，按协议预设回落）。 */
  baseUrl?: string;
  /** 由 npm 字段推断的协议 type。 */
  type: 'openai' | 'anthropic';
  /** npm 无法确定协议时按 openai 兜底并标 true（界面标注「待验证」）。 */
  typeUnverified: boolean;
  /** env[0]：该供应商的惯例 API key 环境变量名（api_key_env 候选提示）。 */
  envHint?: string;
  models: CatalogModel[];
}

/** 拉取目录：http(s) 走全局 fetch；其余按本地文件路径读。失败抛带可操作信息的 Error。 */
export async function fetchCatalog(source?: string): Promise<unknown> {
  const src = source ?? DEFAULT_CATALOG_URL;
  if (/^https?:\/\//i.test(src)) {
    let res: Response;
    try {
      res = await fetch(src);
    } catch (e) {
      throw new Error(`请求 ${src} 失败：${(e as Error).message}`);
    }
    if (!res.ok) throw new Error(`请求 ${src} 返回 HTTP ${res.status}`);
    try {
      return await res.json();
    } catch (e) {
      throw new Error(`目录响应不是合法 JSON：${(e as Error).message}`);
    }
  }
  if (!existsSync(src)) throw new Error(`目录文件不存在：${src}`);
  try {
    return JSON.parse(readFileSync(src, 'utf8'));
  } catch (e) {
    throw new Error(`目录文件解析失败（${src}）：${(e as Error).message}`);
  }
}

/** 由 npm 包名推断协议 type；无法确定时按 openai 兜底并标待验证。 */
function inferType(npm: unknown): { type: 'openai' | 'anthropic'; unverified: boolean } {
  if (npm === '@ai-sdk/anthropic') return { type: 'anthropic', unverified: false };
  if (npm === '@ai-sdk/openai-compatible') return { type: 'openai', unverified: false };
  return { type: 'openai', unverified: true };
}

/** 解析单条模型：状态过滤返回 null，否则归一化为 CatalogModel。 */
function parseModel(id: string, raw: unknown): CatalogModel | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const status = m['status'];
  if (status === 'deprecated' || status === 'alpha') return null;
  const out: CatalogModel = { id, capabilities: [] };
  if (typeof m['name'] === 'string' && m['name'] !== '') out.name = m['name'];
  const limit = m['limit'];
  if (typeof limit === 'object' && limit !== null && !Array.isArray(limit)) {
    const context = (limit as Record<string, unknown>)['context'];
    if (typeof context === 'number' && Number.isFinite(context) && context > 0) out.context = context;
  }
  if (m['reasoning'] === true) out.capabilities.push('thinking');
  const modalities = m['modalities'];
  if (typeof modalities === 'object' && modalities !== null && !Array.isArray(modalities)) {
    const input = (modalities as Record<string, unknown>)['input'];
    if (Array.isArray(input)) {
      if (input.includes('image')) out.capabilities.push('image_in');
      if (input.includes('video')) out.capabilities.push('video_in');
      if (input.includes('audio')) out.capabilities.push('audio_in');
    }
  }
  return out;
}

/**
 * 解析目录 JSON 为供应商清单（按 id 排序，选择器里顺序稳定）。
 * 非对象条目跳过；模型经 deprecated/alpha 过滤后为空集的供应商整条剔除。
 * 顶层不是对象时抛错（目录形态变了，宁可报错也不静默导入空配置）。
 */
export function parseCatalog(raw: unknown): CatalogProvider[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('目录顶层结构非法（应为 { providerId: entry } 的对象）');
  }
  const out: CatalogProvider[] = [];
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (id === '' || typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const p = value as Record<string, unknown>;
    const modelsRaw = p['models'];
    if (typeof modelsRaw !== 'object' || modelsRaw === null || Array.isArray(modelsRaw)) continue;
    const models: CatalogModel[] = [];
    for (const [modelId, modelRaw] of Object.entries(modelsRaw as Record<string, unknown>)) {
      const parsed = parseModel(modelId, modelRaw);
      if (parsed !== null) models.push(parsed);
    }
    if (models.length === 0) continue;
    const { type, unverified } = inferType(p['npm']);
    const entry: CatalogProvider = {
      id,
      name: typeof p['name'] === 'string' && p['name'] !== '' ? p['name'] : id,
      type,
      typeUnverified: unverified,
      models,
    };
    if (typeof p['api'] === 'string' && p['api'] !== '') entry.baseUrl = p['api'];
    const env = p['env'];
    if (Array.isArray(env) && typeof env[0] === 'string' && env[0] !== '') entry.envHint = env[0];
    out.push(entry);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
