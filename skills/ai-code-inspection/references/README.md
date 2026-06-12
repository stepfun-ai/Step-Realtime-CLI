# 日常检查路线图

本文件只提供 `ai-code-inspection` 的轻量执行路线图。

## 启动

1. 按 `../SKILL.md` 初始化 `project-environment-profile.md` 和 `inspection-runtime-state.md`；Runtime 状态生命周期只以 `../SKILL.md` 为准。
2. 读取 `AGENTS.md`、`.dependency-cruiser.cjs`、`package.json`、`tsconfig.json` 和相关变更文件，确认当前项目事实。
3. 明确检查边界：
   - `scope_target`
   - `code_selection_mode`
4. 如果开发者要求检查已修改代码，识别变更文件：
   - `git status --short`
   - `git diff --name-only`
   - `git ls-files --others --exclude-standard`
5. 根据检查边界选择需要执行的 Step。

## Step 顺序

1. `step1-naming-convention.md`：命名、文件放置、路径别名使用、术语一致性。
2. `step2-code-quality.md`：常见 bug、死代码、错误处理、类型契约质量。
3. `step3-architecture-layer.md`：分层依赖方向、包职责边界、extension/skill/client 隔离规则。
4. `step4-test-coverage.md`：测试影响、缺失边界用例、vitest 覆盖情况。
5. `step5-documentation.md`：docs/README/API 与代码行为一致性。
6. `step6-comment-standard.md`：有效注释和文件头规范。
7. `step7-code-commit.md`：git 状态、变更/未跟踪文件、暂存范围、验证摘要和提交准备。

## 常用证据命令

```bash
git status --short
git diff --name-only
git ls-files --others --exclude-standard
git diff -- <scoped-files>
pnpm lint
pnpm test
pnpm exec tsc --noEmit
pnpm dep-guard
pnpm deadcode
pnpm format:check
pnpm check
```

## 最终收口

最终报告应汇总：

- 执行过的 Step。
- 跳过的 Step。
- 发现的问题。
- 建议处理。
- 验证命令与结果。
- 依赖方向检查结果（dep-guard）。
- CI/CD 配置检查状态。
- Runtime 状态是否已按 `../SKILL.md` 重置。
