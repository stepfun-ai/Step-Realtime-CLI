import { z } from 'zod';
import { renderSkillActivation } from '../skill/registry.js';
import { fail, ok, type ToolDef } from './types.js';

/**
 * 单轮 agent 循环内 skill 激活次数上限（MAX_SKILL_QUERY_DEPTH=3）。
 * 计数挂在 ToolContext.skillActivations 上，每次 runAgent 组装 ctx 时新建一个计数器，
 * 因此「同一轮」= 单次 runAgent 内累计（跨回合、含子 agent 各自独立计数）。
 * 防止 skill 正文诱导模型无限连环激活 skill。
 */
export const MAX_SKILL_ACTIVATION_DEPTH = 3;

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
    // 递归防护：单轮累计激活次数超上限则拒绝，避免技能正文诱导无限连环激活
    if (ctx.skillActivations !== undefined) {
      ctx.skillActivations.count += 1;
      if (ctx.skillActivations.count > MAX_SKILL_ACTIVATION_DEPTH) {
        return fail(
          `本轮技能激活次数已达上限（${MAX_SKILL_ACTIVATION_DEPTH} 次）。不要再激活技能，直接用已加载的指令完成任务。`,
        );
      }
    }
    const def = ctx.skills.skills.get(input.skill);
    if (def === undefined) {
      const available = [...ctx.skills.skills.keys()].join(', ') || '（无）';
      return fail(`未知技能「${input.skill}」。可用：${available}`);
    }
    return ok(renderSkillActivation(def, input.args ?? ''));
  },
};
