import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentDefinition } from './types.js';

const MIN_PROMPT_LEN = 20;

/** 内置角色。general = 全能（工具全集，运行时剔除 spawn_agent）；explore = 只读。maxSteps 留空 → 用 config 全局默认。 */
const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: 'general',
    description: '通用子 agent：能读写文件、执行命令、搜索。适合把一段相对独立、需要动手改动的子任务整体委派出去。',
    tools: undefined, // 全部工具（除 spawn_agent，运行时强制剔除）
    systemPrompt: `你是被主 agent 派生的通用子 agent，独立完成交给你的子任务。
你看不到主 agent 的对话历史，所有必要背景都在给你的任务描述里。
完成后用简洁的中文总结你做了什么、结论是什么、有哪些关键产物（文件/路径），这段总结是你唯一交回给主 agent 的内容。
遵守最小改动原则，动手前先读相关文件。`,
  },
  {
    name: 'explore',
    description: '只读探索子 agent：搜索代码库、读文件、联网查资料，汇总发现。不修改任何文件，适合调查/定位/资料收集。',
    tools: ['read_file', 'read_media', 'list_dir', 'glob', 'grep', 'web_search', 'web_fetch', 'web_image_search', 'skill'],
    systemPrompt: `你是被主 agent 派生的只读探索子 agent。你只能读、搜、查，不能修改任何文件或执行命令。
你看不到主 agent 的对话历史，所有必要背景都在给你的任务描述里。
高效检索后，用简洁的中文汇总你的发现（关键文件路径、行号、结论），这段汇总是你唯一交回给主 agent 的内容。`,
  },
];

/** 解析一份 agent markdown（YAML frontmatter + 正文）。非法返回 null。 */
export function parseAgentMarkdown(content: string, fallbackName: string): AgentDefinition | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (m === null) return null;
  let fm: Record<string, unknown>;
  try {
    fm = (parseYaml(m[1]!) as Record<string, unknown>) ?? {};
  } catch {
    return null;
  }
  const body = (m[2] ?? '').trim();
  const name = typeof fm['name'] === 'string' && fm['name'].length > 0 ? fm['name'] : fallbackName;
  const description = typeof fm['description'] === 'string' ? fm['description'] : '';
  if (name.length === 0 || description.length === 0 || body.length < MIN_PROMPT_LEN) {
    return null; // 缺 name/description 或正文过短 → 视为非 agent 文件，跳过
  }
  const toolsRaw = fm['tools'];
  const tools = Array.isArray(toolsRaw) ? toolsRaw.map(String) : undefined;
  // maxSteps 未配或非法 → undefined，交给 config 全局默认兜底
  const maxSteps =
    typeof fm['maxSteps'] === 'number' && fm['maxSteps'] > 0 ? fm['maxSteps'] : undefined;
  return {
    name,
    description,
    tools,
    model: typeof fm['model'] === 'string' ? fm['model'] : undefined,
    maxSteps,
    systemPrompt: body,
  };
}

function loadAgentsFromDir(dir: string): AgentDefinition[] {
  if (!existsSync(dir)) return [];
  const out: AgentDefinition[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    try {
      const def = parseAgentMarkdown(readFileSync(join(dir, file), 'utf8'), file.replace(/\.md$/, ''));
      if (def !== null) out.push(def);
    } catch {
      // 跳过损坏文件
    }
  }
  return out;
}

/**
 * 构建 agent 注册表：内置 < 用户(~/.step-code/agents) < 项目(<cwd>/.step-code/agents)，同名后者覆盖。
 */
export function buildAgentRegistry(cwd: string): Map<string, AgentDefinition> {
  const registry = new Map<string, AgentDefinition>();
  for (const def of BUILTIN_AGENTS) registry.set(def.name, def);
  for (const def of loadAgentsFromDir(join(homedir(), '.step-code', 'agents'))) {
    registry.set(def.name, def);
  }
  for (const def of loadAgentsFromDir(join(cwd, '.step-code', 'agents'))) {
    registry.set(def.name, def);
  }
  return registry;
}

/** 供工具描述里列出可选子 agent 类型。 */
export function describeAgents(registry: Map<string, AgentDefinition>): string {
  return [...registry.values()].map((d) => `- ${d.name}: ${d.description}`).join('\n');
}
