import { z } from 'zod';
import { ok, type ToolDef } from './types.js';

const schema = z.object({
  query: z
    .string()
    .describe('要查找的技能关键词（如 "浏览器扩展"、"PDF 转 markdown"、"画图"、"逆向"）。'),
  limit: z.number().int().positive().optional().describe('最多返回几个技能，默认 10。'),
});

/**
 * 中英文混合分词：连续的中文单字、英文/数字串各自成 token。
 * 与 src/agent/toolSearch.ts 的 tokenize 保持一致风格，但 skill 搜索需要
 * 中文逐字匹配（skill name 多为英文 kebab-case，description 多为中文）。
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[_\-./]/g, ' ')
    .split(/[^a-z0-9一-龥]+/)
    .filter((t) => t.length > 0);
}

interface Scored {
  name: string;
  description: string;
  dir: string;
  whenToUse?: string;
  score: number;
}

/**
 * 对单个 skill 打分：
 * - name 精确等于 query → 10
 * - name 包含 query token → 5/个
 * - description 包含 query token → 2/个
 * - whenToUse 包含 query token → 1/个
 */
function scoreSkill(
  s: { name: string; description: string; whenToUse?: string },
  qTokens: string[],
  qRaw: string,
): number {
  const name = s.name.toLowerCase();
  const desc = s.description.toLowerCase();
  const when = (s.whenToUse ?? '').toLowerCase();
  let score = 0;
  if (name === qRaw.toLowerCase()) score += 10;
  for (const t of qTokens) {
    if (name.includes(t)) score += 5;
    if (desc.includes(t)) score += 2;
    if (when.includes(t)) score += 1;
  }
  return score;
}

/**
 * 搜索可用技能：对全部已扫描 skill（含被清单预算截断的）按 name/description/whenToUse
 * 做关键词检索，按相关度排序返回。不自动激活——模型从结果里选定后再调 skill 工具加载，
 * 避免一次搜索注入多个正文撑爆上下文。
 */
export const skillSearchTool: ToolDef<z.infer<typeof schema>> = {
  name: 'skill_search',
  description:
    '搜索可用技能。当 system prompt 的技能清单被截断、或不确定哪个技能匹配任务时，用本工具按关键词检索全部技能（含未在清单中显示的）；返回名称+描述+路径，再用 skill 工具激活。',
  schema,
  async execute(input, ctx) {
    if (ctx.skills === undefined || ctx.skills.skills.size === 0) {
      return ok('当前没有可用的技能。');
    }
    const qRaw = input.query.trim();
    const qTokens = tokenize(qRaw);
    if (qTokens.length === 0) {
      return ok('查询关键词为空，请输入要搜索的技能关键词。');
    }
    const limit = input.limit ?? 10;
    const defs = [...ctx.skills.skills.values()];
    const scored: Scored[] = defs
      .map((s) => ({
        name: s.name,
        description: s.description,
        dir: s.dir,
        whenToUse: s.whenToUse,
        score: scoreSkill(s, qTokens, qRaw),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    if (scored.length === 0) {
      return ok(`没有找到与「${qRaw}」匹配的技能。可用 /skill 查看已加载的技能清单，或换个关键词重试。`);
    }
    const lines = scored.map((s) => `- ${s.name}：${s.description}（路径：${s.dir}）`);
    return ok(
      `找到 ${scored.length} 个匹配的技能：\n${lines.join('\n')}\n\n用 skill 工具传入名称加载完整指令。`,
    );
  },
};
