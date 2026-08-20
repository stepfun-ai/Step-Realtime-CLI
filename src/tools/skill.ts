import { z } from 'zod';
import { renderSkillActivation } from '../skill/registry.js';
import { fail, ok, type ToolDef } from './types.js';

const schema = z.object({
  skill: z.string().describe('要激活的技能名称（见 system prompt 里的可用技能清单）。'),
  args: z
    .string()
    .optional()
    .describe(
      '可选参数串，注入技能正文的占位符：$ARGUMENTS=整串、$0..$9=按空格分词的第 n 个、${STEP_SKILL_DIR}=技能目录路径。',
    ),
});

/**
 * 激活一个技能（skill）：返回该技能的完整指令正文（含占位符展开）。
 * system prompt 只放技能名称/描述清单（懒加载），模型按需调用本工具加载完整指令。
 * 返回的正文即技能指令，模型应遵循它完成后续操作。
 */
export const skillTool: ToolDef<z.infer<typeof schema>> = {
  name: 'skill',
  description:
    '激活一个技能，返回它的完整指令。system prompt 里有可用技能清单（名称/描述）；当任务匹配某技能描述时，调用本工具传入技能名（可选 args 展开占位符），加载完整指令后按指令执行。',
  schema,
  async execute(input, ctx) {
    if (ctx.skills === undefined) {
      return fail('当前上下文不支持技能。');
    }
    const def = ctx.skills.skills.get(input.skill);
    if (def === undefined) {
      const available = [...ctx.skills.skills.keys()].join(', ') || '（无）';
      return fail(
        `未知技能「${input.skill}」。注册表只含当前工作目录（cwd）的 skill。\n` +
          `若该 skill 属于其他仓库（如某 AGENTS.md 引用的项目 skill），skill 工具跨仓激活不到，` +
          `改用 read_file 读其 SKILL.md 绝对路径（通常在该仓库的 .step-code/skills/${input.skill}/SKILL.md），内容与激活等价。\n` +
          `可用：${available}`,
      );
    }
    return ok(renderSkillActivation(def, input.args ?? ''));
  },
};
