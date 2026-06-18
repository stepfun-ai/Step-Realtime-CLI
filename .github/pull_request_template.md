## 关联 Issue

<!-- 必须填写。普通 PR 用 Closes，纯重构/文档可用 Refs。Owner 可用 skip-issue-link label 跳过。 -->

Closes #

## 变更类型（勾选所有适用项）

- [ ] feat 新功能
- [ ] fix bug 修复
- [ ] docs 文档
- [ ] refactor 重构（无行为变更）
- [ ] test 仅测试
- [ ] chore 构建 / 脚手架 / CI
- [ ] perf 性能优化

## 影响范围

- [ ] 改动了 `packages/protocol/`（跨边界协议，需要同步 SDK）
- [ ] 改动了 `packages/core/` 的公开 API
- [ ] 改动了 `src/gateway/`（session authority 行为变更）
- [ ] 改动了分层依赖（同步更新了 `AGENTS.md` 与 `.dependency-cruiser.cjs`）
- [ ] 仅 docs / 注释 / 测试

## 变更说明（why，而非 what）

<!-- 简要描述为什么做这次改动，背景、动机、关键决策 -->

## 测试计划

<!-- 列出本地执行的命令与覆盖的场景 -->

- [ ] 单测：`pnpm test`
- [ ] 集成：`pnpm test tests/integration/`（如涉及）
- [ ] 手工验证：

## 自检清单

- [ ] 本地 `pnpm check` 已通过（lint / dep-guard / deadcode / tsc / format / test）
- [ ] 新加文件配套加了 `.test.ts`（或在 PR 描述中说明豁免理由）
- [ ] 平台相关代码用了 `vi.skipIf` / `describe.runIf`，未硬编码 platform 判断
- [ ] 新增被覆盖统计的模块已同步加入 `vitest.config.ts` 的 `coverage.include`
- [ ] 不包含二进制、构建产物、密钥
- [ ] 未使用 `--no-verify` 绕过钩子
