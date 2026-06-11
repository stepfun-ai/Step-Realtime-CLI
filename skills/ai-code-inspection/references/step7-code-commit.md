# Step 7: 提交准备

本 Step 用于检查 git 状态、暂存范围、验证摘要和提交准备。除非开发者明确要求，不得 stage 或 commit。

## 安全规则

- 未经开发者明确要求，不得 stage、commit、push、创建分支、reset、checkout 或 stash。
- 保留无关改动。
- 如果存在无关 dirty 文件，保持不动；只在相关时单独报告。
- 优先使用非交互式 git 命令。
- 除非开发者明确要求且文件在范围内，否则不得 force-add 被忽略文件。

## 必查 Git 信息

运行或检查：

```bash
git status --short
git diff --name-only
git ls-files --others --exclude-standard
git diff -- <scoped-files>
git diff --cached --name-status
```

检查：

- changed files 是否符合声明检查边界。
- staged files 如存在，是否符合请求范围。
- untracked files 是有意纳入还是应保持不动。
- generated output（dist/、node_modules/、ui/dist/）、log、本地 env 文件和 cache 是否被意外纳入。
- 行为、API、schema 或构建命令变化时，docs 和 tests 是否同步。
- 验证命令是否执行；跳过时是否有明确理由。

## 验证摘要

使用 `../project-environment-profile.md` 中的命令。

广义 TypeScript 源码变化时，执行以下验证（按优先级）：

1. `pnpm lint` — oxlint 代码规范检查
2. `pnpm exec tsc --noEmit` — TypeScript 类型检查
3. `pnpm dep-guard` — 依赖方向检查（仅当变更涉及 import 时）
4. `pnpm deadcode` — 死代码检测（轻量，建议执行）
5. `pnpm format:check` — 代码格式检查
6. `pnpm build:packages` — 包构建验证（变更影响包时）

范围较窄时，运行与变更区域匹配的验证命令即可。

跳过验证必须明确报告：

- 跳过的命令。
- 跳过原因。
- 剩余风险。

## CI/CD 检查

仅当 `ci_cd.ci_enabled: true` 时执行：

- 检查 workflow 文件是否覆盖相关变更区域。
- 确认 CI 是否包含 install、lint、typecheck、deadcode、dep-guard、build、test 步骤。
- 不得执行 release/deploy job。
- 检查结果应进入当前 Step 报告。

## 提交信息建议

开发者要求 commit 时，使用简洁信息：

- `feat(package): ...` — 新功能
- `fix(package): ...` — 修复
- `refactor(package): ...` — 重构
- `docs: ...` — 文档
- `chore(skill): ...` — skill 相关
- `build: ...` — 构建系统
- `ci: ...` — CI 配置

如果变更跨多个关注点，按关注点拆分 commit。只有小且内聚的变更才适合一个 commit。

包名简写对照：
- `protocol`、`utils`、`core`、`agent-sdk`、`realtime`、`sdk`
- `llm`、`mcp`、`realtime-aec`、`realtime-vad-silero`、`realtime-voice`
- `gateway`、`tui`、`cli`、`ui`、`desktop`
