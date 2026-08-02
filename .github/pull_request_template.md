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

- [ ] 改动了 `src/provider/`（模型/协议适配层）
- [ ] 改动了 `src/agent/` 或 `src/session/`（会话与 agent 主循环行为）
- [ ] 改动了 `src/tools/` 或 `src/mcp/`（工具 / MCP 能力）
- [ ] 改动了 `src/tui/`（终端 UI 行为）
- [ ] 改动了 `bin` / 构建产物 / 发布元数据（`package.json`、`tsconfig.json`）
- [ ] 仅 docs / 注释 / 测试

## 变更说明（why，而非 what）

<!-- 简要描述为什么做这次改动，背景、动机、关键决策 -->

## 测试计划

<!-- 列出本地执行的命令与覆盖的场景 -->

- [ ] 类型检查：`pnpm run typecheck`
- [ ] 构建：`pnpm run build`
- [ ] 单测：`pnpm run test`
- [ ] 手工验证：

## 自检清单

- [ ] 本地 `pnpm run typecheck && pnpm run build && pnpm run test` 全部通过
- [ ] 新加逻辑配套加了测试（或在 PR 描述中说明豁免理由）
- [ ] 平台相关代码未硬编码 platform 判断，跨平台路径用了 `path` 而非手拼分隔符
- [ ] 不包含二进制、构建产物（`dist/`）、密钥（`.env`）
- [ ] 未使用 `--no-verify` 绕过钩子
