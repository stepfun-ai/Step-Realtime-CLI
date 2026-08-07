/** 权限模式。 */
export type PermissionMode = 'manual' | 'auto' | 'yolo';

/**
 * 启动/新会话的初始权限模式决策。优先级（高到低）：
 * CLI flag（--yolo/--auto，一次性意图压过常驻偏好）> config.toml permission_mode
 * （用户常驻表态，压过会话历史值）> 恢复会话存储的 mode > manual（缺省，与历史行为一致）。
 * 运行态 /permission、/yolo 的切换不走本函数，也不回写 config。
 */
export function resolveStartupMode(opts: {
  /** CLI flag 显式给定的模式；未给 flag 时为 undefined。 */
  flag?: PermissionMode;
  /** config.toml permission_mode 解析结果；未配置为 undefined。 */
  config?: PermissionMode;
  /** 恢复会话存储的模式；新会话或缺失为 undefined。 */
  session?: PermissionMode;
}): PermissionMode {
  return opts.flag ?? opts.config ?? opts.session ?? 'manual';
}

/** 只读 / 非破坏性工具：任何模式下都直接放行，不打扰用户。web_search/web_fetch/web_image_search 为联网读取；spawn_agent 委派本身无害（子 agent 的写/执行各自过权限）；ask_user 只是向用户提问收集偏好，无副作用，plan 模式下也用于澄清需求。 */
const READ_ONLY_TOOLS = new Set([
  'read_file',
  'read_media',
  'list_dir',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'web_image_search',
  'spawn_agent',
  'exit_plan_mode',
  'ask_user',
  'todo_list',
  'tool_search',
  'task_list',
  'task_output',
  'get_goal',
  'cron_list',
]);
/** 写类工具：修改文件系统。 */
const WRITE_TOOLS = new Set(['write_file', 'edit_file']);
/** 执行类工具：可执行任意命令，风险最高。 */
const EXEC_TOOLS = new Set(['bash']);

/** 授权判定结果。'ask' 表示需要向用户确认。 */
export type Decision = 'allow' | 'ask';

/**
 * 依据权限模式与本会话已批准集，判定一个工具调用应放行还是需要确认。
 * 判定不产生 'deny'——拒绝只来自用户在确认对话中的选择。
 *
 * 语义（三档梯度）：
 * - yolo：全部放行，从不打扰。
 * - auto：只读放行；写文件放行；bash（可执行任意命令）仍需确认。
 * - manual：只读放行；写文件与 bash 都需确认。
 * 本会话已批准过的工具名直接放行（「本会话允许」缓存）。
 */
export function decide(
  toolName: string,
  mode: PermissionMode,
  sessionApprovals: ReadonlySet<string>,
): Decision {
  if (READ_ONLY_TOOLS.has(toolName)) return 'allow';
  if (mode === 'yolo') return 'allow';
  if (sessionApprovals.has(toolName)) return 'allow';
  if (mode === 'auto') {
    return WRITE_TOOLS.has(toolName) ? 'allow' : 'ask';
  }
  // manual：写与执行都要确认
  if (WRITE_TOOLS.has(toolName) || EXEC_TOOLS.has(toolName)) return 'ask';
  // 未知工具（保守起见）需确认
  return 'ask';
}

/** 是否只读工具（供 UI 判断是否值得展示确认信息）。 */
export function isReadOnly(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName);
}

/**
 * plan 模式守卫：处于计划模式时，写类 / 执行类工具一律拒（硬拦截）。
 * 返回非 null 即为拒绝原因（会作为 tool_result 回灌模型）；null 表示放行。
 * plan 模式下权限层硬拦写操作，只放行只读调查 + exit_plan_mode。
 */
export function planModeDenyReason(toolName: string): string | null {
  if (toolName === 'exit_plan_mode') return null; // 退出 plan 的唯一途径，放行（宿主拦下确认）
  if (READ_ONLY_TOOLS.has(toolName)) return null; // 只读调查放行
  return `计划模式（plan mode）已开启：当前只能做只读调查，不能修改文件或执行命令（${toolName} 被拦截）。请完成调查后调用 exit_plan_mode 提交计划供用户确认。`;
}
