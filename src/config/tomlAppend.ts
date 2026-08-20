/**
 * 追加式 config.toml 写入器：/provider add 向导（手动录入与目录导入）的共用落盘层。
 *
 * 策略：在文件**末尾追加** `[providers.<id>]` 与 `[models.<别名>]` section，
 * 不重序列化全文——已有内容（注释、换行风格、其他字段）逐字节保留。
 * 写前把时间戳备份（`config.toml.<yyyymmdd-hhmmss>.bak`），写完跑
 * {@link runDoctorConfig} 校验，失败回滚备份并抛错（备份文件随之清掉，
 * 不留下垃圾；写入成功时备份保留，供用户人工回退）。
 *
 * 冲突判定用 smol-toml 解析现有文件（而不是正则扫 section 头）：解析失败
 * 说明文件本身有语法错误，追加前直接报错让用户先修，避免在坏文件上继续叠加。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { runDoctorConfig } from './doctor.js';

/** 待写入的渠道（[providers.<id>] 段）。 */
export interface ProviderDraft {
  id: string;
  /** 协议类型（PROVIDER_PRESETS 的 key：openai / anthropic / openai_responses 等）。 */
  type: string;
  baseUrl?: string;
  apiKey?: string;
  /** 只写环境变量名，密钥不落盘。 */
  apiKeyEnv?: string;
}

/** 待写入的模型别名（[models.<别名>] 段）。 */
export interface ModelDraft {
  alias: string;
  /** 真实模型 id。 */
  model: string;
  displayName?: string;
  maxContextSize?: number;
  /** 能力标记（thinking / image_in / video_in / audio_in），原样透传。 */
  capabilities?: string[];
}

export interface AppendProviderInput {
  provider: ProviderDraft;
  models: ModelDraft[];
}

export interface AppendProviderResult {
  configPath: string;
  /** 备份文件路径；原文件不存在（首次创建）时为 undefined。 */
  backupPath?: string;
  /** 实际写入的别名（调用方已去重后的终值）。 */
  aliases: string[];
}

/** config.toml 默认路径（~/.step-code/config.toml，与 config.ts 口径一致）。 */
export function defaultConfigPath(): string {
  return join(homedir(), '.step-code', 'config.toml');
}

/** TOML 键：bare key 字符集原样用，其余走 quoted key（转义反斜杠与双引号）。 */
export function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : `"${k.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** TOML 基础字符串转义：反斜杠、双引号、控制字符（\n \t \r 及 \uXXXX）。 */
export function tomlString(v: string): string {
  const escaped = v
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `"${escaped}"`;
}

/**
 * 分配不冲突的别名：base 未占用直接用；已占用依次试 `${base}-2`、`${base}-3`…。
 * 目录导入时模型 id 可能与现有别名或同批模型重名，用数字后缀兜底（冲突策略 v1）。
 */
export function allocateAlias(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** 生成追加内容：一个 [providers.<id>] 段 + 若干 [models.<别名>] 段（段间空行分隔）。 */
export function renderSections(input: AppendProviderInput, newline: string): string {
  const blocks: string[] = [];
  const p = input.provider;
  const providerLines = [`[providers.${tomlKey(p.id)}]`, `type = ${tomlString(p.type)}`];
  if (p.baseUrl !== undefined) providerLines.push(`base_url = ${tomlString(p.baseUrl)}`);
  if (p.apiKey !== undefined) providerLines.push(`api_key = ${tomlString(p.apiKey)}`);
  if (p.apiKeyEnv !== undefined) providerLines.push(`api_key_env = ${tomlString(p.apiKeyEnv)}`);
  blocks.push(providerLines.join(newline));
  for (const m of input.models) {
    const lines = [`[models.${tomlKey(m.alias)}]`, `provider = ${tomlString(p.id)}`, `model = ${tomlString(m.model)}`];
    if (m.displayName !== undefined) lines.push(`display_name = ${tomlString(m.displayName)}`);
    if (m.maxContextSize !== undefined) lines.push(`max_context_size = ${m.maxContextSize}`);
    if (m.capabilities !== undefined && m.capabilities.length > 0) {
      lines.push(`capabilities = [${m.capabilities.map(tomlString).join(', ')}]`);
    }
    blocks.push(lines.join(newline));
  }
  return blocks.join(newline + newline);
}

/**
 * 把渠道与模型别名追加写入 config.toml 末尾。
 *
 * 流程：读原文件 → smol-toml 解析做冲突检查（渠道 id / 别名已存在即抛错，不写）→
 * 时间戳备份 → 追加写入 → doctor 校验 → 失败回滚并抛错（带 doctor 的失败原因）。
 * 原文件不存在时按首次创建处理（无备份）；doctor 失败时新文件直接删除回滚。
 *
 * @param input 渠道与模型草稿（别名冲突由调用方用 {@link allocateAlias} 预消化，这里仍兜底检查）
 * @param path 目标文件路径，缺省 ~/.step-code/config.toml（测试注入用）
 * @throws 冲突 / 原文件语法错误 / doctor 校验失败（已回滚）
 */
export async function appendProviderConfig(input: AppendProviderInput, path?: string): Promise<AppendProviderResult> {
  const target = path ?? defaultConfigPath();
  const existed = existsSync(target);
  const text = existed ? readFileSync(target, 'utf8') : '';

  // 冲突检查：解析现有文件；语法错误时拒绝在坏文件上叠加（doctor 也过不了）
  if (existed && text.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = parseToml(text);
    } catch (e) {
      throw new Error(`config.toml 存在语法错误，请先修复再添加渠道：${(e as Error).message}`);
    }
    const table = parsed as Record<string, unknown>;
    const providers = table['providers'];
    if (
      typeof providers === 'object' &&
      providers !== null &&
      !Array.isArray(providers) &&
      Object.hasOwn(providers, input.provider.id)
    ) {
      throw new Error(`渠道 ${input.provider.id} 已存在（[providers.${input.provider.id}]），请换一个 id`);
    }
    const models = table['models'];
    if (typeof models === 'object' && models !== null && !Array.isArray(models)) {
      const conflicts = input.models.filter((m) => Object.hasOwn(models, m.alias)).map((m) => m.alias);
      if (conflicts.length > 0) {
        throw new Error(`模型别名已存在：${conflicts.join(', ')}，请换别名或先删除旧条目`);
      }
    }
  }
  // 同批草稿内部重名兜底（调用方漏去重时防写出重复 section）
  const seen = new Set<string>();
  for (const m of input.models) {
    if (seen.has(m.alias)) throw new Error(`同批导入内别名重复：${m.alias}`);
    seen.add(m.alias);
  }

  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  // 追加前保证与上文之间有一个空行分隔；空文件不补前导空行
  let body = text;
  if (body !== '' && !body.endsWith('\n')) body += newline;
  if (body !== '' && !body.endsWith(newline + newline)) body += newline;
  body += renderSections(input, newline) + newline;

  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14)
    .replace(/^(\d{8})(\d{6})$/, '$1-$2');
  const backupPath = `${target}.${stamp}.bak`;
  mkdirSync(dirname(target), { recursive: true });
  if (existed) copyFileSync(target, backupPath);
  writeFileSync(target, body, 'utf8');

  const doctor = await runDoctorConfig(target);
  if (doctor.code !== 0) {
    // 回滚：有备份恢复原文件（并清掉备份），首次创建则删掉新文件
    if (existed) {
      renameSync(backupPath, target);
    } else {
      rmSync(target, { force: true });
    }
    throw new Error(`写入后校验未通过，已回滚：${(doctor.stderr ?? '').trim()}`);
  }
  return { configPath: target, backupPath: existed ? backupPath : undefined, aliases: input.models.map((m) => m.alias) };
}

export interface RemoveProviderResult {
  configPath: string;
  /** 备份文件路径（删除必有原文，故恒有备份）。 */
  backupPath: string;
  /** 一并摘除的模型别名（[models.<别名>] 中 provider 指向该渠道的条目，按文件顺序）。 */
  removedAliases: string[];
  /** 顶层 model 指针指向被删别名时已一并摘除该行（下次启动回落默认解析）。 */
  clearedDefaultModel: boolean;
}

/** section 头规范化：去首尾空白、去点号两侧空白，供与 tomlKey 拼出的目标头精确比较。 */
function normalizeHeader(inner: string): string {
  return inner.trim().replace(/\s*\.\s*/g, '.');
}

/**
 * 从 config.toml 摘除一个渠道：文本级 section 摘除（不重序列化全文，注释与既有排版保留）。
 *
 * 流程：读全文 → smol-toml 解析确认渠道存在并定位归属别名 → 内存里按 `[...]` 头切分，
 * 删掉 `[providers.<id>]` 整节与所有归属别名的 `[models.<别名>]` 整节（头名按
 * {@link tomlKey} 口径匹配）→ 顶层 `model` 指针指向被删别名时一并摘除该行 →
 * 折叠摘除留下的连续/头部/尾部空行 →
 * 时间戳备份 → 一次落盘 → doctor 校验 → 失败回滚备份并抛错。
 * 归属别名清单取自解析结果（而不是逐行正则），避免手排版的 section 漏判。
 *
 * @param providerId [providers.<id>] 的渠道 id（内置预设不在文件里，删不到也无需删）
 * @param path 目标文件路径，缺省 ~/.step-code/config.toml（测试注入用）
 * @throws 文件不存在 / 文件语法错误 / 渠道不存在 / doctor 校验失败（已回滚）
 */
export async function removeProviderConfig(providerId: string, path?: string): Promise<RemoveProviderResult> {
  const target = path ?? defaultConfigPath();
  if (!existsSync(target)) {
    throw new Error(`config.toml 不存在，没有可删除的渠道：${target}`);
  }
  const text = readFileSync(target, 'utf8');
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (e) {
    throw new Error(`config.toml 存在语法错误，请先修复再删除渠道：${(e as Error).message}`);
  }
  const table = parsed as Record<string, unknown>;
  const providers = table['providers'];
  if (
    typeof providers !== 'object' ||
    providers === null ||
    Array.isArray(providers) ||
    !Object.hasOwn(providers, providerId)
  ) {
    throw new Error(`渠道 ${providerId} 不存在（[providers.${providerId}]），无法删除`);
  }
  // 归属别名：provider 字段指向该渠道的 [models.<别名>]（按文件顺序，解析结果保序）
  const removedAliases: string[] = [];
  const models = table['models'];
  if (typeof models === 'object' && models !== null && !Array.isArray(models)) {
    for (const [alias, entry] of Object.entries(models as Record<string, unknown>)) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>)['provider'] === providerId
      ) {
        removedAliases.push(alias);
      }
    }
  }
  // 待摘除的 section 头（规范化后比较）：渠道节 + 归属别名节
  const dropHeaders = new Set<string>([`providers.${tomlKey(providerId)}`]);
  for (const alias of removedAliases) dropHeaders.add(`models.${tomlKey(alias)}`);

  // 内存全量摘除：按行扫，section 头命中的整节（含其后到下一个头之前的所有行）跳过；
  // 顶层（第一个头之前）的 model 指针行指向被删别名时一并摘除
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const aliasSet = new Set(removedAliases);
  const out: string[] = [];
  let inTopLevel = true;
  let dropping = false;
  let clearedDefaultModel = false;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    // [[...]] 数组表头：永不摘除，但它同样开启新 section（终止上一个被摘节的范围）
    if (trimmed.startsWith('[[')) {
      inTopLevel = false;
      dropping = false;
      out.push(rawLine);
      continue;
    }
    const headerMatch = /^\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(trimmed);
    if (headerMatch !== null) {
      inTopLevel = false;
      dropping = dropHeaders.has(normalizeHeader(headerMatch[1]!));
      if (dropping) continue;
      out.push(rawLine);
      continue;
    }
    if (dropping) continue;
    if (inTopLevel && !clearedDefaultModel) {
      const modelMatch = /^model\s*=\s*"(.*)"\s*(?:#.*)?$/.exec(trimmed);
      if (modelMatch !== null && aliasSet.has(modelMatch[1]!)) {
        clearedDefaultModel = true;
        continue;
      }
    }
    out.push(rawLine);
  }
  // 收尾：摘除会在原地留下空行分隔——压掉文件头部的空行、折叠连续空行为单个、
  // 去掉尾部空行后保留单个换行（其余内容逐字节不动）
  const collapsed: string[] = [];
  for (const line of out) {
    if (line.trim() === '' && (collapsed.length === 0 || collapsed[collapsed.length - 1]!.trim() === '')) continue;
    collapsed.push(line);
  }
  while (collapsed.length > 0 && collapsed[collapsed.length - 1]!.trim() === '') collapsed.pop();
  const body = collapsed.join(newline) + newline;

  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14)
    .replace(/^(\d{8})(\d{6})$/, '$1-$2');
  const backupPath = `${target}.${stamp}.bak`;
  copyFileSync(target, backupPath);
  writeFileSync(target, body, 'utf8');

  const doctor = await runDoctorConfig(target);
  if (doctor.code !== 0) {
    // 回滚：恢复备份（并清掉备份文件，与 append 写入器同款语义）
    renameSync(backupPath, target);
    throw new Error(`删除后校验未通过，已回滚：${(doctor.stderr ?? '').trim()}`);
  }
  return { configPath: target, backupPath, removedAliases, clearedDefaultModel };
}
