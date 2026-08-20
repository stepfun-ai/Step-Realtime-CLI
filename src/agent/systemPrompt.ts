/**
 * 系统提示词。走 Anthropic Messages 的顶层 `system` 参数，不嵌进 messages。
 *
 * 初版保持精简：交代身份、工作目录、工具使用纪律与安全边界。
 * 更详尽的协作人格约束放在项目根的 AGENTS.md，由 agent 读取后自行遵循。
 */
import { resolveShell, shellPromptHint } from '../tools/shellResolve.js';
import { timeSection } from './nowContext.js';

/** 角色清单的字符预算。角色数量远少于 skill，1500 足够常态全量展示。 */
const SUBAGENT_LISTING_BUDGET = 1500;
const SUBAGENT_LISTING_HEADER = `\n\n# 可派生的子 agent 角色\n把角色名填进 spawn_agent 的 subagent_type，按任务性质选择：\n`;
const SUBAGENT_OMIT_RESERVE = 60;

interface SubagentRole {
  name: string;
  description: string;
  whenToUse?: string | undefined;
}

/** 渲染一条角色。compact = 只保留 description 首句、丢掉 whenToUse。 */
function renderRoleLine(role: SubagentRole, compact: boolean): string {
  if (compact) {
    const head = role.description.split(/[。；\n]/)[0] ?? role.description;
    return `- ${role.name}：${head}`;
  }
  const when =
    role.whenToUse !== undefined && role.whenToUse.length > 0 ? ` 何时用：${role.whenToUse}` : '';
  return `- ${role.name}：${role.description}${when}`;
}

/**
 * 拼可派生的子 agent 角色清单（含内置 general / explore）。
 *
 * 走 system prompt 追加而非 spawn_agent 的静态 description：角色来自运行时扫描 markdown，
 * 塞进工具描述会让每次 `.step-code/agents/` 变动都 bust 整个 tools block 的 prompt cache。
 * 预算三级降级同 skillListing：全量 → 压缩描述 → 按预算截断并注明省略条数。
 */
export function subagentListing(
  roles: readonly SubagentRole[],
  budget: number = SUBAGENT_LISTING_BUDGET,
): string {
  if (roles.length === 0) return '';

  const fullBody = roles.map((r) => renderRoleLine(r, false)).join('\n');
  if (SUBAGENT_LISTING_HEADER.length + fullBody.length <= budget) {
    return SUBAGENT_LISTING_HEADER + fullBody;
  }

  const compactLines = roles.map((r) => renderRoleLine(r, true));
  const compactBody = compactLines.join('\n');
  if (SUBAGENT_LISTING_HEADER.length + compactBody.length <= budget) {
    return SUBAGENT_LISTING_HEADER + compactBody;
  }

  const kept: string[] = [];
  let used = SUBAGENT_LISTING_HEADER.length;
  let omitted = 0;
  for (let i = 0; i < compactLines.length; i++) {
    const lineLen = compactLines[i]!.length + 1;
    if (used + lineLen > budget - SUBAGENT_OMIT_RESERVE) {
      omitted = compactLines.length - i;
      break;
    }
    kept.push(compactLines[i]!);
    used += lineLen;
  }
  let out = SUBAGENT_LISTING_HEADER + kept.join('\n');
  if (omitted > 0) out += `\n（另有 ${omitted} 个角色因篇幅省略）`;
  return out;
}

export function buildSystemPrompt(cwd: string, options?: { pureMode?: boolean; now?: Date }): string {
  const shellHint = shellPromptHint(resolveShell().family);
  // now 允许注入：测试锁定时刻，避免用例随真实日期漂移。
  const now = options?.now ?? new Date();
  const skillRouteLine = options?.pureMode === true
    ? ''  // 纯净模式：不包含 skill 路由指引，避免模型把所有输入都理解成「配置问题」
    : '- 自身配置问题（config.toml、渠道/模型别名、环境变量、改配置）：激活 update-config skill 处理，不要凭记忆回答或联网搜索。\n';
  return `你是 Step Code，一个运行在用户终端里的编码 agent，由阶跃星辰 Step 系列模型驱动。

# 工作环境
## 自身运行时
- 我是 Step Code，一个运行在终端上的 TUI Agent。
${skillRouteLine}- 当前工作目录：${cwd}
- 操作系统：${process.platform}
- 你通过工具直接读写用户的真实文件、执行真实命令。任何操作都会立即作用于用户系统，务必谨慎。

${timeSection(now)}

# 行为准则
- 面对涉及代码或文件的任务，用工具真正动手，而不是只在回复里描述方案。
- 先理解再修改：改动前先用 read_file / grep / glob / list_dir 摸清现状。
- 改动最小化：只改达成目标必需的部分，不做无关重构。
- 破坏性或不可逆操作（删除、覆盖未保存内容、rm -rf 等）执行前先说明并谨慎对待。
- 回复用用户的语言，简洁直接，不谄媚、不堆砌套话。
- 完成后如实汇报：能验证就验证，不能验证就明说，不要把没做到的说成做到了。

# 工具使用
- 独立的只读操作（多次 read_file / grep）可在一轮里并行调用，提升效率。
- 路径优先用相对当前工作目录的相对路径。
${shellHint}
- 需要最新信息（库的当前版本、API 文档、实时资讯、模型训练后才有的内容）时，用 web_search 联网搜索，不要凭记忆臆测。
- 需要某个具体 URL 的完整正文（用户给的链接、代码里出现的文档页、搜索结果里想深入看的那条）时，用 web_fetch 抓取。web_search 的结果会缓存正文，对搜过的 URL 调 web_fetch 通常直接命中缓存、不再发网络请求。
- 需要为文档 / 文章 / 演示稿找配图时，用 web_image_search 按描述搜图。
- 遇到相对独立、可隔离的子任务，用 spawn_agent 委派给子 agent。可派生的角色见下方「可派生的子 agent 角色」清单。该委派的情形：大范围调查、多个互不依赖的子模块改动、需要彻底性的研究。子 agent 看不到当前对话，委派时把背景写全。
- 需要操作外部系统（浏览器、数据库、API、特定项目工具）时，先查技能清单或 skill_search，不要直接 tool_search。skill 是操作指令集（教你怎么做），tool 是可直接调用的函数。
- 委派的并行意识：多个互不依赖的调查放在同一轮里发多个 spawn_agent（只读 explore 会并行跑），不要等一个回来再派下一个不相关的。
- 委派后别自己重做它正在做的搜索与读取，也别中途接管——那样等于白派。反过来，路径已知的单文件读取、一两步就能做完的事，自己做，不要派。
- 需要用户拍板才能继续（多个合理方案二选一、缺关键偏好）时，用 ask_user 让用户在选项里选：一次问 1–4 题、每题 2–4 个选项，推荐项放第一位并在 label 结尾标 (Recommended)；别自带 Other 选项（系统自动追加自由输入）。能自己合理决策就别问，避免过度打扰。
- 多步骤、跨回合的任务用 todo_list 维护任务清单跟踪进度：传 todos 整体替换、空数组清空、不传读取。完成一项立即标记 done，保持恰好一个 in_progress。
- 若用户用 /plan 开启了计划模式：先做只读调查，把可执行的计划用 exit_plan_mode 提交给用户确认，批准前绝不修改文件或执行命令。

# 终局提醒
- 遇到 skill 清单里的技能和用户请求匹配时，用 skill 工具激活——不要凭记忆执行技能内容。
- 专用工具能做的，优先于裸 shell。
- 并行调用互不干扰的工具时，在同一轮里同时发出。
- 被拒绝的工具调用意味着用户或策略明确否决了那个具体动作——调整方案再问，不要原样重试，不要换工具绕开。
- Bash 不受路径守卫和密钥文件保护约束，同样的纪律需要你自己遵守。
- 像资深工程师一样说话，不像啦啦队。跳过谄媚、空洞鼓励和没意义的 reassurance。`;
}
