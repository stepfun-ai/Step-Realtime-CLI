/**
 * system prompt 的逐轮组装。
 *
 * 抽成纯函数的理由是这里出过事：pi 版迁移时漏掉了 memory 观察池段，而子 agent runner
 * 那侧注了，于是「记忆」这个功能对主 agent 实质失效——配了 `[memory] enabled = true`、
 * `/memory` 能列出观察，但主 agent 的 system 里从来没有那一段。同期还漏了 SessionStart
 * hook 的 stdout 注入（hook 执行点整个不存在）。
 *
 * 两处漏掉的共同点：**组装是一串内联的字符串拼接，没有任何测试能看见少了一段。**
 * 拆出来之后段的构成变成可断言的。
 *
 * 段序不是随意的，按「变动频率从低到高」排：静态前缀 → skill 清单 → 子 agent 角色 →
 * AGENTS.md → memory → SessionStart。低频内容在前是为了保住 prompt 缓存前缀——尾部
 * 变动只废掉尾部的缓存，头部变动会废掉整条。
 */

export interface SystemParts {
  /** buildSystemPrompt 的静态前缀。 */
  prefix: string;
  /** skill 清单（skillListing 产出，自带前后空行）。 */
  skills: string;
  /** 自定义子 agent 角色清单（subagentListing 产出）。 */
  subagents: string;
  /** AGENTS.md 正文，空串表示没有。 */
  agentsMd: string;
  /** memory 观察池段正文，未开启时传空串。 */
  memory: string;
  /** SessionStart hook 的 stdout，无输出时传空串。 */
  sessionContext: string;
}

/** 按固定段序拼装 system。空段不产生多余空行。 */
export function composeSystem(parts: SystemParts): string {
  let out = parts.prefix + parts.skills + parts.subagents;
  if (parts.agentsMd !== '') out += `\n\n${parts.agentsMd}`;
  if (parts.memory !== '') out += `\n\n${parts.memory}`;
  if (parts.sessionContext !== '') out += `\n\n${parts.sessionContext}`;
  return out;
}
