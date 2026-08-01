import { z } from 'zod';
import { fail, ok, type ToolDef } from './types.js';

const optionSchema = z.object({
  label: z.string().describe('选项显示文本，1–5 词，简洁。'),
  description: z.string().optional().describe('该选项的含义或后果说明（可选）。'),
});

const questionSchema = z.object({
  question: z.string().describe('完整的问题文本。'),
  header: z.string().optional().describe('极短分类标签（chip），≤12 字符，如 "Auth"。'),
  options: z
    .array(optionSchema)
    .min(2)
    .max(4)
    .describe('2–4 个候选项。禁止自带 "Other"/"其它"——系统会自动追加自由输入项。推荐项放第一位并在 label 结尾标 (Recommended)。'),
  multi_select: z.boolean().optional().describe('是否允许多选（默认 false）。'),
});

const schema = z.object({
  questions: z.array(questionSchema).min(1).max(4).describe('1–4 个问题，前台会逐题顺序询问用户。'),
});

export type AskUserOption = z.infer<typeof optionSchema>;
export type AskUserQuestion = z.infer<typeof questionSchema>;
export type AskUserRequest = z.infer<typeof schema>;
/** 答案字典：key 为问题原文，单选为选中 label（或用户自由输入），多选为 label 数组。 */
export type QuestionAnswers = Record<string, string | string[]>;

/**
 * 向用户主动提问并让其在选项中选择，用于澄清歧义或收集偏好。
 * 前台同步阻塞（复用宿主的审批式 Promise-resolver），答案回喂进对话成为上下文。
 * 由组合根（App）注入 ctx.askUser；缺失（如子 agent 无 UI）则 fallback 返回不支持。
 * 取消（用户按 Esc）返回空答案，按「用户取消」非错误结果回灌，模型据此另想办法。
 */
export const askUserTool: ToolDef<AskUserRequest> = {
  name: 'ask_user',
  description:
    '向用户提问并让其从选项里选择，用于澄清歧义或收集偏好。仅在无法自行合理决策、且答案会实质改变下一步时才问，别过度打扰；能自己定的就别问。一次可问 1–4 题、每题给 2–4 个选项；推荐项放第一位并在 label 结尾标 (Recommended)。不要自带 "Other" 选项，系统会自动追加自由输入项。',
  schema,
  async execute(input, ctx) {
    if (ctx.askUser === undefined) {
      return fail('当前上下文不支持向用户提问。');
    }
    const answers = await ctx.askUser(input);
    if (Object.keys(answers).length === 0) {
      return ok('用户取消了本次提问（未选择任何选项）。请勿重复追问，可基于已有信息继续或另作合理默认。');
    }
    return ok(JSON.stringify({ answers }));
  },
};
