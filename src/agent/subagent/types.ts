/** 子 agent 角色定义。来源：内置代码 + 用户/项目的 markdown（YAML frontmatter）。 */
export interface AgentDefinition {
  name: string;
  /** 供主 agent 自动选型的说明：这个角色「是什么」。 */
  description: string;
  /**
   * 供主 agent 自动选型的说明：「什么时候该选它」。与 description 分工——
   * 前者答「是什么」，后者答「何时用」，两者都进 system prompt 的角色清单。
   * 可选：已有的自定义 agent markdown 没写这个字段，不能因此失效。
   */
  whenToUse?: string;
  /** 工具名白名单；undefined = 该角色可用全部工具（运行时会再强制剔除 spawn_agent）。 */
  tools?: string[];
  /** 模型覆盖；undefined = 继承父 agent 的模型。 */
  model?: string;
  /** 单次子 agent 最大 模型↔工具 往返轮数；undefined = 用 config 的全局默认（subagent.maxSteps）。 */
  maxSteps?: number;
  /** system prompt（markdown 定义时取正文）。 */
  systemPrompt: string;
}

/** 子 agent 派生请求。 */
export interface SpawnSubagentRequest {
  subagentType: string;
  prompt: string;
  /** 父 agent 的当前深度（父 = 0）。 */
  depth: number;
  signal?: AbortSignal;
  /** 该子 agent 的标识（并行时区分各子 agent 的进度事件）。 */
  id?: string;
  /** 短描述（模型按 schema 写的 3-5 词标签），进度卡片优先显示它；缺省退回 prompt 截断。 */
  description?: string;
  /**
   * 恢复指定 id 的子会话：从快照回灌历史后把 prompt 追加为新 user 消息续跑（不新建会话、不占派生配额）。
   * 唯一门槛是目标会话当前没在跑（活跃锁判定）。
   */
  resume?: string;
  /**
   * 覆盖子 agent 的工作目录（缺省继承主会话 cwd）。
   * team worker 用它把默认落点收进自己的工作间。
   */
  cwd?: string;
  /**
   * 写根目录约束：给出后，该子 agent 的 write_file/edit_file 目标路径必须落在此目录内
   * （runner 层包装 authorizeToolCall 硬拦；bash 不拦，靠 cwd 落点 + prompt 约束）。
   */
  writeAllowRoot?: string;
  /**
   * 父会话 id（内部线程化字段，不由工具层填写）：嵌套派生时 runner 把自己的子会话 id 传给下一层，
   * 使子会话 meta.parentId 指向真实的直接父级而非一律记主会话。
   */
  parentSessionId?: string;
}

/** 子 agent 执行结果（回灌给父的摘要）。 */
export interface SubagentResult {
  summary: string;
  isError: boolean;
  /** 导致失败的原始错误对象（内部元数据，不进 wire）：父侧调度层据此识别 429 做重排队。 */
  cause?: unknown;
  /** 本次派生落盘的子会话 id（起步前的拒绝路径无此字段）：父侧记住它，供事后查看与后续按 id 恢复。 */
  sessionId?: string;
}

/** 由组合根（App / main）注入的子 agent 运行器类型。 */
export type RunSubagentFn = (req: SpawnSubagentRequest) => Promise<SubagentResult>;
