---
name: ai-code-inspection
description: 本项目本地 Skill，用于在每次开发结束后高频、低熵地检查已修改代码，快速发现命名、代码质量、架构分层、测试、文档、注释和提交准备中的通用问题。适用于"检查代码""检查已修改代码""看看改动有没有问题""review 当前改动""检查本次实现"等日常非上线检查。不要用于上线、发布、Release gate、生产验收或严格企业级安全验收；这些场景应切换到专门的 release/security gate Skill。
---

# AI Code Inspection

使用本 Skill 对已经修改过的代码做日常通用检查。目标是帮助开发结束后的质量收口；它保留 Runtime 状态机来保证检查过程完整，但不承担最终上线验收，不替代专门安全审计、发布门禁或业务规划流程。

## 唯一职责

- 检查当前声明范围内的代码和配套文档是否存在通用质量问题。
- 通过 `inspection-runtime-state.md` 记录 Step、验证、修复和风险，防止粗略跳过。
- 对照 `AGENTS.md`、`.dependency-cruiser.cjs`、`package.json`、`tsconfig.json`、`vitest.config.ts` 和相邻代码事实，不重新定义项目架构规则。
- 检查阶段只报告问题、证据、风险和建议；修复阶段只能由 Runtime 状态和开发者 `继续` 授权进入。
- 保持检查收敛：不写业务规划产物，不执行发布或生产验收，不维护跨运行业务上下文。

## 必读文件

正式检查前必须先处理两个本地运行文件：

1. `project-environment-profile.md`
   - 项目稳定事实的本地缓存，用于减少每次重复探测。
   - **本文件由各开发者本地维护，不纳入 git 跟踪。**
   - 只记录框架、语言、包管理器、monorepo、构建工具、远程平台和 CI/CD 可用性。
   - 不得写入临时运行状态、Step 输出、命令输出或每次执行日志。
   - 如果文件不存在，Skill 按真实项目文件动态推断并生成。
   - 如果本文件与 `AGENTS.md`、`.dependency-cruiser.cjs`、`package.json`、`tsconfig.json` 或 `vitest.config.ts` 冲突，以真实项目文件为准，并在报告中标记本地 profile 过期。
2. `inspection-runtime-state.md`
   - 当前 Skill 执行的临时状态。
   - **本文件由 Skill 在每次运行时动态生成，不纳入 git 跟踪。**
   - 记录每个 Step 的 `done` / `failed` / `skipped` 状态、跳过原因、CI/CD 检查状态、修复状态、验证结果和风险。
   - Skill 执行结束后必须重置为初始模板，保证下一次运行干净。

### 忽略配置

上述两个本地文件不得写入 `.gitignore`，因为 `AGENTS.md` 当前暂不接收 `.gitignore` 修改。

首次使用时，如果它们出现在 `git status` 中，报告需要把以下路径加入个人全局忽略或 `.git/info/exclude`，并在获得开发者明确确认后再执行对应配置：

```text
skills/ai-code-inspection/project-environment-profile.md
skills/ai-code-inspection/inspection-runtime-state.md
```

## Runtime 状态生命周期

本节是 `ai-code-inspection` 的唯一 Runtime Governance Source。README 和 Step reference 只能引用执行路线或检查规则，不得重复定义运行状态、状态流转、修复生命周期或 gate 行为。

每次运行开始时：

1. 检查 `project-environment-profile.md` 是否存在；如果不存在，按真实项目文件动态生成。
2. 读取 `AGENTS.md`、`.dependency-cruiser.cjs`、`package.json`、`tsconfig.json`、`vitest.config.ts` 和相关变更文件，校准本次运行事实。
3. 将 `inspection-runtime-state.md` 重置为初始模板（如果不存在则新建）。
4. 将本次运行边界写入 `inspection-runtime-state.md`：
   - `scope_target`。
   - `code_selection_mode`：只检查 git 变更，或检查范围内全部代码。
   - 本次条件检查使用的环境事实。
   - `modifier`：优先读取 `git config user.name`；为空时使用系统用户名。
   - `run_started_at`：用系统时间生成当前日期和时间。
5. 每个 Step 开始前重新读取 `inspection-runtime-state.md`；如果当前 Step 在本次运行中已经是 `done`，不得重复执行。
6. 每个检查阶段或修复阶段结束后，更新 `inspection-runtime-state.md`，记录执行项、跳过项、待修复项、已修复项、验证命令、验证结果、CI/CD 状态和风险。
7. 最终报告输出后，将 `inspection-runtime-state.md` 重置为初始模板。

如果上一次运行被中断，下一次运行开始时先清空旧运行状态，再记录新的边界。

### Single Continue Consumption Rule

开发者每输入一次 `继续`，只授权消费一个 Runtime Gate。该次授权只能执行一个 Runtime 阶段，阶段结束后立即失效，必须停止并等待开发者再次输入 `继续`。

Runtime 阶段仅允许：

1. 当前 Step 检查阶段。
2. 当前 Step 修复阶段。

同一次 `继续` 禁止完成：

- 当前 Step 检查 + 当前 Step 修复。
- 当前 Step 修复 + 下一 Step 检查。
- 多个 Step。
- 多个修复阶段。

如果本次 `继续` 用于当前 Step 检查阶段，检查结束后必须更新 `inspection-runtime-state.md` 并输出检查报告；发现可修复问题时只允许记录 `remediation_status: pending_user_continue` 并停止，不得在同一次 `继续` 中进入修复阶段。

如果本次 `继续` 用于当前 Step 修复阶段，修复和验证结束后必须立即：

1. 输出修复报告。
2. 更新 `inspection-runtime-state.md`。
3. 停止执行。

验证通过时，将当前 Step 标记为 `done`，设置 `remediation_status: completed`，然后等待开发者再次输入 `继续` 才能进入下一 Step。验证失败时，保持当前 Step 为 `failed`，设置 `remediation_status: validation_failed`，报告失败命令和关键输出摘要后停止。

如果当前 Step 修复过程中发现属于下一 Step 的问题，只允许记录为 `next_step_candidate`；不得修复、推进或进入下一 Step。这些候选问题必须等待开发者下一次输入 `继续` 后，按下一 Step reference 正式检查。

## 执行计划（Exec-plan）

执行命令或修改文件前，必须先输出 Markdown 格式的执行计划：

```markdown
| Step | Tool | Expectation | Rollback |
|------|------|-------------|----------|
| 步骤描述 | 使用工具 | 预期结果 | 失败回退方案 |
```

- 包含至少一个步骤、工具、预期结果和回退方案。
- 对于删除、部署、线上迁移等高风险操作，必须在 Exec-plan 末尾请求人工确认。
- 优先使用项目根目录下 `scripts/` 中的脚本和 `package.json` 中的原生命令，不临时拼凑替代流程。

## 检查边界

进入 Step 1 前，必须明确两个维度：

- `scope_target`：whole project、package、module、folder，或明确文件列表。
- `code_selection_mode`：只检查范围内 git 变更代码，或检查范围内全部代码。

如果任一维度不清楚，先问一个简短澄清问题。不要把模糊请求推断成"全项目 + 全量代码"检查。

常见默认值：

- 开发者说"检查已修改代码"、"看看本次实现"、"review 当前改动"时，默认 `scope_target = git changed files`，`code_selection_mode = changed code`。
- 开发者指定目录或模块时，只检查该范围；无关 dirty 文件只报告存在，不擅自处理。

## 条件执行

根据真实项目文件与 `project-environment-profile.md` 判断哪些检查需要执行：

- TypeScript 源码变化时，执行类型安全相关检查（Step 2）。
- 变更涉及 import 语句时，必须执行依赖方向检查（Step 3 + `pnpm dep-guard`）。
- 变更涉及 UI（`ui/`、`src/tui/`）时，执行 React/OpenTUI 相关检查。
- 变更涉及 `src/gateway/` 时，执行 session authority、service/store/handler 分层相关检查。
- 变更涉及 `extensions/*` 时，执行 extension 边界相关检查。
- 变更涉及 `skills/*` 时，执行 skill 边界检查。
- 只有 `ci_cd.ci_enabled: true` 时才执行 CI/CD 配置检查。
- 当前运行中已经标记为 `done` 的检查不得重复执行。
- 与当前环境或范围无关的检查标记为 `skipped`，并写明原因。
- 本项目当前没有数据库/ORM 事实时，数据库相关检查标记为 `not_applicable`。

## 两阶段修复流程

本 Skill 是 AI 协助执行流程。检查阶段负责报告；修复阶段只能在开发者输入 `继续` 且当前 Step 存在待修复状态时执行。

当某个 Step 发现范围内可修复问题时，不得立即改文件。必须先反馈问题，并在 `inspection-runtime-state.md` 中记录：

```text
status: failed
remediation_status: pending_user_continue
```

范围内可修复问题包括：

- 命名或文件放置不符合当前项目风格。
- 明显类型错误或类型契约被放宽。
- 死代码、未使用 import、重复局部定义、过期 TODO。
- 文档与命令、API shape、类型定义或校验行为不一致。
- 过期或误导性注释。
- 违反分层依赖方向的 import。

当开发者下一次输入 `继续` 时，先修复当前 Step 的待修复问题，不得直接进入下一个 Step：

1. 重新读取 `inspection-runtime-state.md`，确认当前 Step 存在 `pending_user_continue`。
2. 在声明边界内执行修复。
3. 根据真实项目文件和 `project-environment-profile.md` 执行必要验证命令。
4. 更新 `inspection-runtime-state.md`：
   - 修改文件。
   - 修复摘要。
   - 验证命令。
   - 验证结果。
   - 剩余风险。
5. 验证通过后，将当前 Step 标记为 `done`，并设置 `remediation_status: completed`。
6. 报告修复和验证结果，然后再次等待开发者输入 `继续`，才能进入下一个 Step。

如果修复后验证失败，保持当前 Step 为 `failed`，设置 `remediation_status: validation_failed`，报告失败命令和关键输出摘要。不得继续推进，直到开发者决定继续、暂停或扩大范围。

## 修复边界

以下事项不得作为日常 remediation 自动执行：

- 大规模架构重构。
- release、deploy、生产 gate 或上线检查。
- 权限模型修改。
- 修改真实环境变量或密钥；`.env.example` 文档性更新除外。
- 真实数据修改。
- 安全策略修改。
- Breaking API contract 变更。
- 修改 `tsconfig` paths 映射或 dependency-cruiser 规则（属于架构决策，需人工确认）。
- stage、commit、push、创建分支、reset、checkout 或 stash。
- 回退开发者已有改动，除非开发者明确要求。

如果 Step 发现上述越界问题，标记为 `failed`，设置 `remediation_status: blocked_out_of_boundary`，将边界原因写入 `inspection-runtime-state.md` 并报告给开发者。普通的 `继续` 不得执行越界修改；只有开发者明确改变范围或要求切换到专门流程后，才允许进入对应工作。

## Step 顺序

广义检查按 Step 1 到 Step 7 执行。每次只加载当前 Step 对应 reference：

1. `references/step1-naming-convention.md`：命名、文件放置、路径别名使用、术语一致性。
2. `references/step2-code-quality.md`：常见 bug、死代码、错误处理、类型契约质量、ESM 规范。
3. `references/step3-architecture-layer.md`：分层依赖方向、包职责边界、extension/skill/client 隔离规则。
4. `references/step4-test-coverage.md`：测试影响、缺失边界用例、vitest 覆盖情况。
5. `references/step5-documentation.md`：docs/API/配置说明与代码行为一致性。
6. `references/step6-comment-standard.md`：有效注释和文件头规范。
7. `references/step7-code-commit.md`：git 状态、变更/未跟踪文件、暂存范围、验证摘要和提交准备。

`references/README.md` 只作为简明路由图使用，不得覆盖本文件中的运行状态生命周期和两阶段修复规则。

## 报告格式

每个 Step 或修复阶段结束后，更新 `inspection-runtime-state.md` 并报告：

- `当前步骤`：Step 名称和 reference 文件。
- `检查边界`：`scope_target` 和 `code_selection_mode`。
- `执行状态`：`done` / `failed` / `skipped`。
- `修复状态`：`not_needed` / `pending_user_continue` / `completed` / `validation_failed` / `blocked_out_of_boundary`。
- `问题摘要`：检查发现；没有则写 `无`。
- `修改摘要`：修复阶段实际改动的文件和内容；没有则写 `无`。
- `已执行`：命令、搜索、检查过的文件、修改过的文件。
- `验证结果`：验证命令及 pass / fail / skipped。
- `架构一致性`：是否与 `AGENTS.md` 和 `.dependency-cruiser.cjs` 一致。
- `跳过项`：跳过的检查和原因。
- `风险说明`：剩余风险、越界问题，或 `无`。
- `等待继续`：
  - 如果 `remediation_status: pending_user_continue`，要求开发者输入 `继续` 以开始当前 Step 修复。
  - 如果当前 Step 已 `done`，要求开发者输入 `继续` 以进入下一个 Step。

最终报告必须包含：

- 已执行 Step。
- 已跳过 Step 和原因。
- failed Step 和阻塞原因。
- 验证命令执行或跳过情况。
- 当 `ci_cd.ci_enabled: true` 时的 CI/CD 检查状态。
- 架构依赖方向检查结果（dep-guard pass/fail）。
- `AGENTS.md` 与真实项目文件之间是否发现不一致；没有则写 `无`。

最终报告输出后，重置 `inspection-runtime-state.md` 为初始模板。

## 验证策略

优先使用 `package.json` 的项目原生命令；`AGENTS.md` 要求提交前执行 `pnpm check`，实际子项以 `package.json` 当前脚本为准。如 `AGENTS.md` 对 `pnpm check` 的描述与 `package.json` 不一致，应报告为文档漂移。

- 提交前完整验证以 `pnpm check` 为准。
- 范围较窄或快速检查时，可按风险选择子命令：`pnpm test`、`pnpm lint`、`pnpm dep-guard`、`pnpm deadcode`、`pnpm exec tsc --noEmit`、`pnpm format:check`。
- TypeScript 源码变化时，必须执行 `pnpm exec tsc --noEmit`，除非明确报告跳过原因和剩余风险。
- 变更影响 import 语句时，必须执行 `pnpm dep-guard` 验证依赖方向。
- 变更范围内文件时，必须执行 `pnpm lint`（oxlint）。
- 影响包构建的变更时，执行 `pnpm build:packages` 或 `pnpm build`。
- UI 变更时，执行 `pnpm --dir ui build` 或项目中等价的 UI build script。
- CI/CD 检查是条件性轻量检查：只检查 workflow 文件中是否存在与日常验证相关的步骤；不得执行 release/deploy job。
- 跳过验证必须明确报告跳过命令、原因和剩余风险。

## 硬边界

- 不执行上线、发布、发布就绪检查（Release readiness）、生产门禁（production gate）或严格企业级安全验收。
- 不写业务规划产物或业务产品内容。
- 不在 `inspection-runtime-state.md` 中累积跨运行上下文；最终报告后必须重置。
- 不把 `project-environment-profile.md` 当作架构权威；架构事实以 `AGENTS.md` 和 `.dependency-cruiser.cjs` 为准。
- 未经开发者明确要求，不执行 stage、commit、push、创建分支、reset、checkout 或 stash。
- 保留与当前任务无关的工作区改动。
- 不修改 `tsconfig` paths 映射或 dependency-cruiser 规则（属于架构决策，需人工确认）。
