import { getLocale } from '../i18n.js';

/** 忙碌态输入框下方随机提示的文案池（中文）。用 step-code 真实存在的命令/快捷键。 */
export const WORKING_TIPS: string[] = [
  '↑/↓ 回溯输入历史',
  '输入 / 唤起斜杠命令补全',
  'Ctrl+O 查看工具输出',
  '忙碌时继续输入会自动加入发送队列',
  '/plan 只读调查并产出计划，确认后再执行',
  '/goal 让 agent 持续朝一个目标推进',
  '/compact 压缩上下文腾出窗口',
  '/model 切换模型 · /permission 切权限模式',
  '/sessions 浏览历史会话 · /resume 恢复',
  '/reflect 回顾对话、沉淀可复用方法论',
  '/fork 从当前会话分叉副本',
  '/loop 建定时或循环任务',
];

/** 英文提示池：与中文池逐条对应的翻译。 */
export const WORKING_TIPS_EN: string[] = [
  '↑/↓ to browse input history',
  'Type / to open slash command completion',
  'Ctrl+O to view tool output',
  'Keep typing while busy — input joins the send queue',
  '/plan: read-only investigation, executes after your approval',
  '/goal keeps the agent pushing toward a goal',
  '/compact compresses context to free up the window',
  '/model to switch model · /permission to switch permission mode',
  '/sessions to browse past sessions · /resume to restore',
  '/reflect reviews the conversation and distills reusable methodology',
  '/fork to branch a copy of the current session',
  '/loop to create scheduled or recurring tasks',
];

/** 取当前界面语言对应的提示池。 */
function tipPool(): string[] {
  return getLocale() === 'en' ? WORKING_TIPS_EN : WORKING_TIPS;
}

/**
 * 忙碌态状态词池（spinner 行的动词，如「处理中」「推进中」）。
 * mount 时随机取一次、整轮固定（随机词 + 词尾加「…」）。
 * 与 tip 不同：状态词是 spinner 行本体的一部分，短、无命令；tip 是下方独立一行的用法提示。
 *
 * 刻意不含「思考/推理」类词：这个词是随机的、与模型实际状态无关，用思考类词等于无条件声称
 * 模型在思考（没思考时是谎话，真在思考时也传达不出新信息）。思考状态由 ThinkingPreview
 * 的「思考中…」标题独家表达——它由 thinking_start/thinking_end 事件驱动，说的是真事。
 */
export const WORKING_VERBS: string[] = [
  '处理中',
  '推进中',
  '运转中',
  '忙活中',
  '张罗中',
  '鼓捣中',
  '折腾中',
  '拾掇中',
];

export const WORKING_VERBS_EN: string[] = [
  'Working',
  'Crunching',
  'Churning',
  'Cooking',
  'Brewing',
  'Whirring',
  'Tinkering',
  'Hustling',
];

/** 随机取一个状态词（不含尾部省略号，调用方自行拼「…」）。 */
export function pickWorkingVerb(): string {
  const pool = getLocale() === 'en' ? WORKING_VERBS_EN : WORKING_VERBS;
  return pool[Math.floor(Math.random() * pool.length)] ?? pool[0] ?? '';
}

/**
 * 随机抽一条 tip。exclude 传上一条以避免连续重复；
 * 池仅一条（或排除后为空）时退化为直接返回，不做排除。
 */
export function pickRandomTip(exclude?: string): string {
  const tips = tipPool();
  if (tips.length === 0) return '';
  const candidates =
    exclude !== undefined && tips.length > 1 ? tips.filter((tip) => tip !== exclude) : tips;
  const pool = candidates.length > 0 ? candidates : tips;
  return pool[Math.floor(Math.random() * pool.length)] ?? '';
}
