---
name: ai-code-inspection
description: 本项目本地 Skill，用于高频、低熵地检查已修改的代码，快速发现命名、代码质量、架构分层、测试、文档、注释和提交准备中的常识性问题。适用于"检查代码""检查已修改代码""看看改动有没有问题""review 当前改动""检查本次实现"等日常非上线检查。不要用于上线、发布、Release gate、生产验收或严格企业级安全验收；这些场景应切换到专门的 release/security gate Skill。
---

# AI Code Inspection

使用本 Skill 对已经修改过的代码做日常检查。目标是快速发现常识性错误和规范性问题，不承担最终上线验收。

## 必读文件

正式检查前必须先处理两个文件：

1. `project-environment-profile.md`
   - 项目稳定事实的单一事实源（SoT）。
   - **本文件由各开发者本地维护，不纳入 git 跟踪。**
   - 只记录框架、语言、包管理器、monorepo、构建工具、远程平台和 CI/CD 可用性。
   - 不得写入临时运行状态、Step 输出、命令输出或每次执行日志。
   - 如果文件不存在，Skill 按项目实际结构动态推断并生成。
   - 只有稳定环境事实变化时才允许修改。
2. `inspection-runtime-state.md`
   - 当前 Skill 执行的临时状态。
   - **本文件由 Skill 在每次运行时动态生成，不纳入 git 跟踪。**
   - 记录每个 Step 的 `done` / `failed` / `skipped` 状态、跳过原因、CI/CD 检查状态、修复状态、验证结果和风险。
   - Skill 执行结束后必须重置为初始模板，保证下一次运行干净。

### Git 忽略配置（首次使用必做）

上述两个本地文件不会被 .gitignore 忽略。首次使用前，执行以下命令将它们加入全局忽略列表：

```bash
git config --global core.excludesFile ~/.gitignore_global
echo -e "\n# ai-code-inspection skill local files\nskills/ai-code-inspection/project-environment-profile.md\nskills/ai-code-inspection/inspection-runtime-state.md" >> ~/.gitignore_global
```

配置一次后，所有仓库中的这两个文件都会自动被 git 忽略，不会出现在 `git status` 中。

## Runtime 状态生命周期

本节是 `ai-code-inspection` 的唯一 Runtime Governance Source。README 和 Step reference 只能引用执行路线或检查规则，不得重复定义运行状态、状态流转、修复生命周期或 gate 行为。

每次运行开始时：

1. 检查 `project-environment-profile.md` 是否存在；如果不存在，按项目实际结构动态生成。
2. 将 `inspection-runtime-state.md` 重置为初始模板（如果不存在则新建）。
3. 将本次运行边界写入 `inspection-runtime-state.md`：
   - `scope_target`。
   - `code_selection_mode`：只检查 git 变更，或检查范围内全部代码。
   - 本次条件检查使用的环境事实。
   - `modifier`：优先读取 `git config user.name`；为空时使用系统用户名。
   - `run_started_at`：用系统时间生成当前日期和时间。
4. 每个 Step 开始前重新读取 `inspection-runtime-state.md`；如果当前 Step 在本次运行中已经是 `done`，不得重复执行。
5. 每个检查阶段或修复阶段结束后，更新 `inspection-runtime-state.md`，记录执行项、跳过项、待修复项、已修复项、验证命令、验证结果、CI/CD 状态和风险。
6. 最终报告输出后，将 `inspection-runtime-state.md` 重置为初始模板。

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

## 检查边界

进入 Step 1 前，必须明确两个维度：

- `scope_target`：whole project、package、module、folder，或明确文件列表。
- `code_selection_mode`：只检查范围内 git 变更代码，或检查范围内全部代码。

如果任一维度不清楚，先问一个简短澄清问题。不要把模糊请求推断成"全项目 + 全量代码"检查。

## 条件执行

根据 `project-environment-profile.md` 判断哪些检查需要执行：

- 变更涉及 TypeScript 源码时，执行类型安全相关检查（Step 2）。
- 变更涉及 import 语句时，必须执行依赖方向检查（Step 3 + `pnpm dep-guard`）。
- 变更涉及 UI（ui/、src/tui/）时，执行 React/OpenTUI 相关检查。
- 变更涉及 src/gateway/ 时，执行 service/store/handler 分层相关检查。
- 变更涉及 extensions/* 时，执行 extension 边界相关检查。
- 变更涉及 skills/* 时，执行 skill 边界相关检查。
- 只有 `ci_cd.ci_enabled: true` 时才执行 CI/CD 配置检查。
- 当前运行中已经标记为 `done` 的检查不得重复执行。
- 与当前环境或范围无关的检查标记为 `skipped`，并写明原因。
- 本项目无数据库/ORM 依赖，所有数据库相关检查标记为 `not_applicable`。

## 两阶段修复流程

本 Skill 是 AI 协助执行流程。开发者不手动改文件；开发者唯一常规操作是输入 `继续`，授权进入下一阶段。

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
3. 根据 `project-environment-profile.md` 执行必要验证命令。
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
- 修改 tsconfig paths 映射或 dependency-cruiser 规则（属于架构决策，需人工确认）。

如果 Step 发现上述越界问题，标记为 `failed`，设置 `remediation_status: blocked_out_of_boundary`，将边界原因写入 `inspection-runtime-state.md` 并报告给开发者。普通的 `继续` 不得执行越界修改；只有开发者明确改变范围或要求切换到专门流程后，才允许进入对应工作。

## Step 顺序

广义检查按 Step 1 到 Step 7 执行。每次只加载当前 Step 对应 reference：

1. `references/step1-naming-convention.md`：命名、文件放置、路径别名使用、术语一致性。
2. `references/step2-code-quality.md`：常见 bug、死代码、错误处理、类型契约质量、ESM 规范。
3. `references/step3-architecture-layer.md`：分层依赖方向、包职责边界、extension/skill/client 隔离规则。
4. `references/step4-test-coverage.md`：测试影响、缺失边界用例（当前项目无测试，以风险记录为主）。
5. `references/step5-documentation.md`：docs/README/API 与代码行为一致性。
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

最终报告输出后，重置 `inspection-runtime-state.md` 为初始模板。

## 验证策略

优先使用 `project-environment-profile.md` 中的项目原生命令。

- TypeScript 源码变化时，必须执行 `pnpm exec tsc --noEmit`。
- 变更影响 import 语句时，必须执行 `pnpm dep-guard` 验证依赖方向。
- 变更范围内文件时，必须执行 `pnpm lint`（oxlint）。
- 建议执行 `pnpm deadcode`（knip）检查死代码。
- 建议执行 `pnpm format:check` 验证代码格式。
- 影响包构建的变更时，执行 `pnpm build:packages` 或 `pnpm build`。
- UI 变更时，执行 `pnpm --dir ui build`。
- 类型检查通过是基础质量门禁；单元测试当前无基础设施。
- CI/CD 检查是条件性轻量检查：只检查 workflow 文件中是否存在 lint、typecheck、build、test 步骤；不得执行 release/deploy job。

## 硬边界

- 不执行上线、发布、发布就绪检查（Release readiness）、生产门禁（production gate）或严格企业级安全验收。
- 不写业务规划产物或业务产品内容。
- 不在 `inspection-runtime-state.md` 中累积跨运行上下文。
- 未经开发者明确要求，不执行 stage、commit、push、创建分支、reset、checkout 或 stash。
- 保留与当前任务无关的工作区改动。
- 不修改 tsconfig paths 映射或 dependency-cruiser 规则（属于架构决策，需人工确认）。
