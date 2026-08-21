import type { SkillDefinition } from '../registry.js';

/**
 * 内置 skill「team」：step-code 多 agent 团队模式的内联操作指南。
 *
 * 设计决策与 updateConfig.ts 一致：正文内嵌模板字符串，不读外部 .md。
 * 正文内不使用反引号与 ${ 序列（外层模板字符串冲突 + 占位符展开风险）。
 * 代码标记用「」或直接裸写。
 */
const TEAM_SKILL_BODY = `# team：多 agent 团队协作

当协调者（主 agent）需要使用团队模式（并行、scope 隔离、依赖门控、审阅合并）时，
以本 skill 为事实源决定怎么调工具、怎么传参数。先读完本 skill 再调任何 team_ 开头的工具。

---

## 一、什么时候用 team，什么时候不用

### 用 team 的场景

- 多个任务要**并行改同一个（或多个）代码库**，且改动范围可明确定义
- 需要**写范围互斥**（build 类任务 scope 两两不重叠，系统会硬拒）
- 需要**依赖门控**（任务 B 等任务 A 完成后才能启动，系统会硬拒，不靠自觉）
- 需要**审阅后收编**（协调者审 diff，五道门全部通过才合入）
- 跨仓库协作（多个仓库有关联改动需要同步推进）

### 不用 team 的场景

- **单任务**：直接写代码即可，不 overhead 开团队
- **纯调查 / 调研**：spawn_agent explore 就够了，不需要范围隔离和合并
- **小改动**（几个文件直接改完）：直接改，不需要 worktree + merge 流程
- **一次性批量同构任务**（大量独立文件独立修改，无依赖关系）：dynamic_workflow 更合适

---

## 二、team_init 的参数组合（重点，最容易出错）

team_init 有三个可选参数，**九成情况只传 repo（或都不传）**。

### 参数语义

- **repo**：基准仓绝对路径（即你要「指挥」的那个仓库）。
  缺省 = 当前目录所在的仓库。
  想在 A 目录指挥 B 仓 → 传 repo=B 的绝对路径。
- **dir**：团队档案目录（存 state.json、信箱、日志、工作间）。
  缺省 = 基准仓的 .teams/ 目录（即 join(repoRoot, '.teams')）。
  **一般不要传**。只有跨仓协作想把档案放在仓库外的独立位置时才传 dir。
- **base**：基准分支（任务工作间从它开、收编合回它）。
  缺省 = 基准仓当前 checkout 的分支。
  开发不在当前分支上时**必须显式传**（否则 worktree 和 merge 目标都会错）。

### 真实事故反面教材

协调者连续五次调错 team_init：

1. **把基准仓路径填进 dir**：dir 被设置成类似 /path/to/repo 的值。系统检查发现该目录已存在且非空、但没有 state.json → 触发防污染拒绝，报错「已存在且非空，但不是 team 档案」。档案目录应该指向一个**空目录**或**尚不存在的路径**，不是基准仓本身。
2. **只传 dir 不传 repo**：repo 缺省取当前目录所在仓（比如是仓 A），但实际想指挥的是仓 B → 基准仓被钉死在错误仓库，后续所有 worktree 和 merge 都指向 A。

**正确姿势**：
1. 先想清楚「我要指挥哪个仓」→ 把它传给 repo
2. dir 和 base 保持缺省，不需要就不传

### 典型调用

只想用当前目录的仓（最常见）：

    team_init()

想指挥别的仓：

    team_init(repo="/绝对/路径/到/目标仓")

开发在 feature 分支上，基准分支要显式指定：

    team_init(repo="/绝对/路径/到/目标仓", base="feature/my-branch")

跨仓 + 档案放仓外（罕见）：

    team_init(repo="/绝对/路径/到/目标仓", dir="/独立/档案/目录", base="main")

### 启动前检查清单

调用前确认：
- [ ] 基准仓目录存在且是 git 仓库（有 .git 或 git worktree）
- [ ] 基准仓已有至少一次提交（否则 worktree 开不出来）
- [ ] base 参数（如果有）确实在基准仓中存在（否则 init 会报错）

---

## 三、工作流

完整流程：init → plan → spawn → worker 执行 → 审阅 → merge → teardown

### 3.1 init

- 创建档案目录结构：state.json + comms/inbox + log + worktrees/
- 档案目录在基准仓内时自动写进 .git/info/exclude（不追踪）
- 幂等：已初始化保留全部状态；关闭后重进（re-init）清 closedAt 标记
- 防污染：目录已存在且非空、但缺 state.json → 拒绝写入

### 3.2 plan（team_plan）

输入任务数组，每个任务包含：title / kind / scope / deps / repo（可选）。

- **kind = build**：写代码。scope 是允许改动的文件范围（路径前缀，相对仓库根）。
  - scope 两两互斥检查：任意两个 build 任务的 scope 目录语义下重叠 → 直接拒绝，必须重新划分
  - scope 归一：src/data/** → src/data/（末尾的 ** 或 * 被去掉）
- **kind = survey**：只读调查。scope 可为空数组（不占互斥位）
- **deps**：依赖的任务 id 列表。deps 必须引用已存在的任务 id（包括本次 plan 里更早的任务）；不存在会立即报错
- **repo（可选）**：跨仓任务时指定任务所属仓库（绝对路径）；缺省 = 基准仓

### 3.3 spawn（team_spawn）

为指定任务开 worktree + 后台派生 worker。

- **依赖门控（硬化，系统强制）**：任务的 deps 中只要有一个状态不是 merged → 直接拒绝，不启动
- 开 worktree：在任务仓的 .teams/worktrees/wt-N/ 下开出（单仓 = 档案目录下；跨仓 = 各仓各自的 .teams/）
- 基准分支：单仓 = 团队 base；跨仓 = 任务仓当前 checkout 分支
- worker 的 cwd 和 writeAllowRoot 自动指向工作间路径
- worker 完成后：成功标 completed，失败标 blocked
- completed 可重派（rework：审阅打回后的返工——worktree 幂等重挂，任务分支上已有提交不丢）
- blocked 可重派（respawn：worker 执行失败后重试）
- merged 永远拒绝：已收编的任务不能再启动

### 3.4 worker 执行

Worker 在独立 git worktree 里干活：
- cwd 是工作间目录
- 写操作被限制在工作间内（write guard）
- 通过 team_send / team_inbox 与协调者和其他 worker 通信
- 完成后 git add/commit 到工作间分支
- worker 失联（进程崩溃、协调者重启等）：resume 对账时 BackgroundManager 通过 onLost 回调把后台任务标 lost；App 层联动把对应的 team 任务（command 形如「team·M1 标题」）标 blocked——仅限当前状态为 active 的任务。标 blocked 后走 respawn 重派

### 3.5 审阅（协调者侧，非工具调用）

收到 worker 完成通知后，协调者执行：

    git -C <工作间绝对路径> diff <baseBranch>...<branch>

在基准仓内审阅 diff。确认 scope 内改动干净后，执行 merge。

### 3.6 merge（team_merge）——门禁

合并前协调者必须先审阅 diff（非 merge 工具本身的要求，是纪律），然后调用 team_merge 传入 reviewedCommit。

门禁全部通过才合入：

- **门①② 已审阅**：协调者传入 reviewedCommit，声明已看过 diff
- **门③ tip 未移动**：先 git rev-parse <branch> 拿到 tip，审完 diff 后原样传 reviewedCommit。若 tip 已移动（worker 又改了），会被拒绝并要求重新审阅
- **门④ 依赖全部已 merged**：任务 deps 中必须全部是 merged 状态
- **门⑤ diff 无 scope 外文件**：git diff --name-only <base>...<branch> 的每个文件必须落在任务 scope 内；越界文件会被列出并拒绝
- **typecheck 门**：build 任务在合并前于工作间跑 'tsc --noEmit'（非 TS 仓或无 typescript 自动跳过），把类型错误挡在合并之前。'--force' 可绕过本门（确认是环境差异等误报时），其余硬门不可 --force
- --no-ff 是 git merge 的执行方式，不是一道门：门禁全过后才执行 git merge --no-ff 合入，保留 merge commit
- 合并成功后自动清理 worktree：干净则删除，dirty 则保留并写入日志，同时通过返回值 worktreeKept 告知协调者
- 删除失败不会阻塞 merge 成功：兜底保留 worktree，worktreeKept 注明「清理失败，保留」

冲突处理：合并撞冲突 → 自动 git merge --abort 救回仓库 → 报错并给出指引（在任务工作间把基准分支 rebase/合并进任务分支，解完冲突再重新收编）

波及检测：合并后检查是否有其他未合并的 build 任务 scope 与本次改动文件重叠，若有则列出警告。

### 3.7 teardown（team_teardown）——见第四节

### 3.8 工作期用法

一段工作期 init 一次，期间连续 plan → spawn → merge 多个任务，全部收工才 teardown。

- **不要每批任务都 teardown + init**：teardown 落 closedAt，再 init 虽然能重进，但每次都重建目录结构、重新激活，开销大且容易丢状态连续性
- 只有两种情况退出工作期：
  1. 全部任务收工（全部 merged 或已取消）
  2. 协调者发现自己必须写代码（write guard 不允许，此时应优先把微修派成 worker 任务或攒成修补任务，而不是绕过 guard）

### 3.9 收编后验证

merge 通过 ≠ 完成。merge 后必须在**主仓**跑全量测试（typecheck 轻量门已在合并前于工作间执行，但全量测试耗时长、不适合放门禁，且需真实运行环境）。工作间经 junction 共享主仓 node_modules、可跑 tsc；今天四轮收编后验证都抓到了 worker 遗留问题（白名单测试没更新、测试硬编码 Windows 路径、截断逻辑放错位置、return 漏带字段）。处理策略：

- 小问题（漏测、路径硬编码）→ 派修补任务（新 task，scope 精确）
- 大问题（逻辑错位、接口不兼容）→ rework：重新 team_spawn 同一任务（completed → rework），worker 带已知问题清单返工

### 3.10 收编前前置条件

在调用 team_merge 之前，基准仓**当前 checkout 的必须是基准分支**。中途切走会被收编前的基准分支校验拒绝（merge 执行前的独立检查）。

---

## 四、退出通道（三条，职责不同）

### 4.1 team_teardown（正常收尾）

- 先落 closedAt 关闭标记（防止 resume 自动复活团队模式）
- 然后清理工作间：有未提交改动的工作间默认**保留**（dirty keep）；force=true 才强制删除
- 档案目录（state.json + 信箱 + 日志）**永久保留**作审计

### 4.2 team_teardown(quit_only=true)（应急强退）

- **跳过**状态读取、跳过工作间清理
- 直接 deactivate 团队模式
- 适用场景：teardown 反复失败、档案目录损坏、不想被困在团队模式里
- 工作间和档案目录原样保留，手动清理或重新 team_init 后再正常 teardown
- **不要**在正常流程用 quit_only

### 4.3 用户侧 /team exit（硬退出）

- 用户主动在 TUI 输入 /team exit 触发的退出
- 这是**用户命令**，模型不能执行，也不要在回复里模拟这条命令
- 落 closedAt 标记 + 退出团队模式；**不清理工作间**（工作间保留，需手动清理或团队重进后再 teardown）
- 如需清理工作间，正常流程应使用 team_teardown

### 关闭标记语义

teardown / exit 后，state.json 里的 closedAt 被写入：
- resume 恢复快照时发现 closedAt → 团队不自动复活，静默降级为未激活
- 重新执行 team_init → 清除 closedAt，保留全部任务状态（archive 永久保留）

---

## 五、协调者纪律

### 5.1 write guard

团队模式活跃期间，协调者**不能写代码**（write guard 硬拦）。只能协调（plan / spawn / merge / teardown）。写代码是 worker 的工作。

### 5.2 依赖表达

依赖关系用 deps 字段表达，**不要在 prompt 里口述「等 M1 完了再做」**。系统只认 deps 字段，口述依赖不起任何门控作用。

### 5.3 跨仓任务

- mission 的 repo 字段指定任务仓
- 工作间开在任务仓的 .teams/worktrees/（不是基准仓下）
- 基准分支取任务仓当前 checkout 分支

### 5.4 状态查看

用 team_status 或 /team status 看全景（基准分支、档案目录、各任务状态、执行者）。状态栏只有 team 徽标，不显示任务进度数字。

---

## 六、已知边界（一期）

- **bash 写拦截**：靠 prompt 约束 + cwd 默认进工作间，不是进程级硬拦。模型理论上可以在工作间外调 bash 写文件（违反 prompt 但技术可行）
- **状态栏**：只有 team 徽标（active/inactive），不显示任务进度数字；进展用 team_status 或 /team status 看
- **收编前基准分支**：要求基准仓当前 checkout 的是基准分支（不是任意分支）。中途被用户切走会被 merge 门拒绝
- **resume**：档案是事实源，快照只是指针。resume 时从档案恢复状态，closedAt 决定是否激活团队模式
- **dist 错位**：协调者当前进程加载的是启动时的代码。merge 进来的新功能（包括 team 机制自身的修复）在当前进程不可用，要重启进程才生效。判断「功能怎么没生效」时先想这一层——不是 worker 没写好，是协调者还在跑旧代码
`;

/**
 * 内置 skill 定义。
 */
export const TEAM_SKILL: SkillDefinition = {
  name: 'team',
  description:
    '教模型正确使用 step-code team 多 agent 团队工具。覆盖：什么时候用 team vs 不用、team_init 三个参数的正确用法（repo/dir/base 缺省与常见错误）、工作流全流程（init → plan → spawn → 审阅 → merge 门禁 → teardown）、rework/respawn 两种重派机制、merge 后自动清理 worktree、worker 失联 lost 联动、工作期用法、收编后验证（主仓全量测试 + 合并前 typecheck 门）、三条退出通道、协调者纪律、已知边界（dist 错位）。当模型需要调用 team_init / team_plan / team_spawn / team_merge / team_teardown / team_send / team_inbox / team_status 前必须读取本 skill。',
  content: TEAM_SKILL_BODY,
  dir: 'builtin://team',
  source: 'builtin',
};
