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
    whenToUse: '需要实际动手的子任务——改代码、跑构建测试、多步实现。任务范围清晰、能独立完成时优先派它。',
    tools: undefined, // 全部工具（除 spawn_agent，运行时强制剔除）
    systemPrompt: `你是被主 agent 派生的通用子 agent，独立完成交给你的子任务。
你看不到主 agent 的对话历史，所有必要背景都在给你的任务描述里。

结果契约：你的工具调用过程主 agent 看不到，只有最后的总结会交回去。完成后用简洁的中文说明：做了什么、结论是什么、改动或产出涉及哪些文件路径。关键路径要写全，主 agent 据此继续工作，不该再去重新定位。

工作纪律：
- 遵守最小改动原则，动手前先读相关文件。
- 任务范围明显超出交接内容（依赖没说清的前提、牵扯到未提及的模块）时，如实说明卡在哪、缺什么，不要硬做或自行扩大范围。
- 若你手上有 spawn_agent，同样适用委派纪律：只在子任务确实独立且够重时派生，别把自己能一两步做完的事再转包出去。`,
  },
  {
    name: 'explore',
    description: '只读探索子 agent：搜索代码库、读文件、联网查资料，汇总发现。不修改任何文件，适合调查/定位/资料收集。',
    whenToUse: '需要大范围检索或彻底调查时——搞清楚某个机制怎么实现、定位问题出在哪、收集资料。多个独立问题可以同一轮派多个，它们会并行跑。',
    tools: ['read_file', 'read_media', 'list_dir', 'glob', 'grep', 'web_search', 'web_fetch', 'web_image_search', 'skill'],
    systemPrompt: `你是被主 agent 派生的只读探索子 agent。你只能读、搜、查，不能修改任何文件或执行命令。
你看不到主 agent 的对话历史，所有必要背景都在给你的任务描述里。

结果契约：你的检索过程主 agent 看不到，只有最后的汇总会交回去。汇总要给出具体的文件路径与行号，让主 agent 能直接定位，不必重查一遍。

汇报纪律：
- 结论先行，再给支撑证据（路径、行号、关键代码片段）。
- 查不到就明说：说清查了哪些地方、用了什么关键词，结论是「没找到」。不要编造，也不要用猜测填补空白。
- 区分「代码里确实这么写」与「我据此推断」，后者要标明是推断。`,
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
  // whenToUse 兼容驼峰与蛇形两种写法（蛇形与 skill 的 when_to_use 命名习惯对齐）
  const whenToUseRaw = fm['whenToUse'] ?? fm['when_to_use'];
  const whenToUse =
    typeof whenToUseRaw === 'string' && whenToUseRaw.trim().length > 0
      ? whenToUseRaw.trim()
      : undefined;
  // maxSteps 未配或非法 → undefined，交给 config 全局默认兜底
  const maxSteps =
    typeof fm['maxSteps'] === 'number' && fm['maxSteps'] > 0 ? fm['maxSteps'] : undefined;
  return {
    name,
    description,
    whenToUse,
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
