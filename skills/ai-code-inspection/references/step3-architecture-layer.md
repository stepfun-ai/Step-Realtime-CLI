# Step 3: 架构与分层

本 Step 检查变更代码是否遵守项目分层依赖规则。架构事实以 `AGENTS.md` 和 `.dependency-cruiser.cjs` 为准，本文件只给检查路线。

## 权威来源

必须先读取：

- `AGENTS.md`：分层、目录职责、Session/SDK/Tool/Skill/Extension 归属。
- `.dependency-cruiser.cjs`：依赖方向、cycle 和 workspace guardrail 的可执行规则。
- `package.json`：`pnpm dep-guard` 的真实命令。

如果本 reference 与上述文件不一致，报告 reference 过期，不要按 reference 覆盖项目规则。

## 默认依赖方向

按 `AGENTS.md` 的表达理解依赖方向：

```text
packages/protocol <- packages/utils <- packages/core <- packages/agent-sdk <- packages/realtime <- src/gateway <- packages/sdk <- clients
```

这条链表达默认架构方向，不等于相邻层都可以直接 import。源码 import 必须同时满足 `.dependency-cruiser.cjs` 的具体规则；尤其 `packages/sdk` 封装对 gateway 的调用，但不得 import `src/gateway` 源码实现。`clients` 指 `src/cli/`、`src/tui/`、`ui/`、`apps/desktop/` 和未来 `apps/*` 独立端侧应用。

旁路依赖按 `AGENTS.md` 检查：

- `src/bootstrap -> packages/core`
- `src/commands -> src/runtime -> src/gateway`
- `skills/* -> packages/core`
- `extensions/* -> packages/core` 或 `src/gateway`
- `src/bootstrap` 承载多个入口复用的启动 / 配置 / prompt 辅助逻辑

## 核心检查

- `packages/protocol` 只放跨边界契约，不依赖上层实现。
- `packages/utils` 只放无业务状态的基础 helper，不拥有 session authority，不实现 agent loop。
- `packages/core` 放 Agent Loop、领域模型、tool/skill/provider/model 抽象接口，不依赖具体厂商 SDK、数据库、WebSocket 服务端或 UI 层。
- `packages/agent-sdk` 只依赖 `packages/core`、`packages/protocol`、`packages/utils`，不得依赖 `packages/sdk`、`src/*`、`apps/*`、`extensions/*`、`skills/*`、`ui/`。
- `packages/realtime` 放实时音频 / 语音协议与运行时基础设施，不放具体厂商适配。
- `src/gateway` 是 session authority 和应用组装层，不是公共库层，不直接读取 bootstrap config 文件，不依赖客户端实现。
- `packages/sdk` 封装对 gateway 的调用，不实现 agent loop，不依赖 gateway 源码实现。
- UI、TUI、CLI、Desktop 默认只依赖 `packages/sdk`，不直接依赖 `src/gateway`、`packages/core` 实现、`skills/*` 或 `extensions/*`。
- `skills/*` 是 agent-facing 能力单元，只依赖 `packages/core` 抽象。
- `extensions/*` 是 system-facing 外部集成，不依赖 clients 或 skills；`realtime-*` 适配器复用 `packages/realtime` 协议层。
- 任意两个包之间不得存在循环 import。

## 检查方法

1. 运行 `pnpm dep-guard` 验证 dependency-cruiser 分层、cycle 和 workspace 依赖声明一致性。
2. 对变更文件检查 import 来源路径，确认没有相对路径跨越包边界。
3. 对新增/移动文件，确认目录归属符合 `AGENTS.md` 的目录使用规则。
4. 对跨层 API 变化，确认 protocol types、SDK types、gateway handlers、client code 的 request/response shape 一致。

## 文档同步要求

当变更涉及新增/删除/重命名层、包或目录时，`AGENTS.md` 和 `.dependency-cruiser.cjs` 必须在同一 PR 中同步更新。

- 如果变更涉及架构分层但 PR 中缺少 `AGENTS.md` 的对应更新，报告：架构文档未同步，要求开发者补充。
- 如果变更涉及新增/删除/重命名层或包但 PR 中缺少 `.dependency-cruiser.cjs` 的对应更新，报告：依赖守卫配置未同步，要求开发者补充。
- 此类问题只报告，不自动修改架构规则。

## 修复边界

以下架构问题不得作为日常检查自动修复：

- 大规模分层重构。
- 跨包循环依赖的解除。
- 变更 `tsconfig` paths 映射。
- 修改 `.dependency-cruiser.cjs`。
- 调整 `AGENTS.md` 的分层原则。

发现上述问题时，报告阻塞原因、证据和建议下一步。
