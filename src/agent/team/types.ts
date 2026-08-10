/**
 * team 多 agent 团队：任务模型与状态类型。
 */

/** 任务类型：build 写代码（scope 占互斥位）/ survey 只读调查（不占位）。 */
export type TeamMissionKind = 'build' | 'survey';

/** 任务状态机：planned → active → completed → merged；blocked/paused 为异常与中停。 */
export type TeamMissionStatus = 'planned' | 'active' | 'completed' | 'blocked' | 'paused' | 'merged';

export interface TeamMission {
  /** 任务 id（M1/M2…，plan 时分配）。 */
  id: string;
  title: string;
  kind: TeamMissionKind;
  /** 写权限范围（路径前缀，相对 repo 根；`src/data/**` 归一为 `src/data/`）。build 之间互斥。 */
  scope: string[];
  /** 仓库归属（绝对路径；缺省 = 团队基准仓）。 */
  repo: string;
  /** 任务分支名（`team/<slug>`）。 */
  branch: string;
  /** 工作间槽位（`wt-N`），spawn 时开出 git worktree。 */
  worktree: string;
  /** 依赖的任务 id；全部 merged 才允许 spawn（系统强制）。 */
  deps: string[];
  status: TeamMissionStatus;
  /** 执行该任务的子 agent 会话 id。 */
  owner?: string;
  /** 主 agent 审阅时的分支 tip（merge 门③比对用）。 */
  reviewedCommit?: string;
  /** 任务仓的基准分支（spawn 时确定：同仓 = 团队 base；跨仓 = 任务仓当前分支）。缺省按团队 base 处理。 */
  baseBranch?: string;
}

export interface TeamState {
  version: 1;
  /** 基准分支（合并目标）。 */
  base: string;
  /** 关闭时间（teardown/exit 时写入）。有值 = 团队已关，resume 不得自动复活；init 重进时清除。 */
  closedAt?: string;
  /** 基准仓（绝对路径；档案目录独立时仍记录它）。 */
  repoRoot: string;
  createdAt: string;
  missions: TeamMission[];
}

/** 信箱消息（frontmatter 解析后的形态）。 */
export interface TeamMessage {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  sentAt: string;
  body: string;
  /** 文件名（定位用）。 */
  file: string;
}

export class TeamError extends Error {}
