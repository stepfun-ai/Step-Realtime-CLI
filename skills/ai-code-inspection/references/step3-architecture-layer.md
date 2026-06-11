# Step 3: 架构与分层

本 Step 检查变更代码是否遵守项目严格的分层依赖规则。这是本项目最重要的架构检查。

## 依赖方向总览（必须遵守）

```
packages/protocol  ← 最底层（纯类型、schema、DTO、共享类型）
       ↓
packages/utils     ← 基础工具层（string-width 等无领域语义工具）
       ↓
packages/core      ← 核心运行时（Agent Loop、领域模型、tool/skill/provider/model 抽象）
       ↓
packages/agent-sdk ← 对外 Agent 构建 SDK（仅供编程方式声明 agent/工具）
       ↓
packages/realtime  ← 实时音频/语音协议与运行时抽象
       ↓
packages/sdk       ← 客户端 SDK（依赖 gateway 协议，不依赖 gateway 源码）
       ↓
src/bootstrap      ← 启动/配置/prompt 辅助
       ↓
src/gateway        ← 应用组装层（session/workspace/plugin/memory/service）
       ↓
extensions/*       ← 外部系统适配
skills/*           ← Skill 插件
       ↓
src/runtime        ← 编排层（粘合 gateway、bootstrap、commands、cli、tui、extensions）
       ↓
src/commands       ← CLI 命令
src/tui            ← TUI 客户端（OpenTUI）
src/cli            ← CLI 客户端
apps/*             ← 独立端侧应用
ui/                ← React + Vite 前端
```

注意：`src/runtime` 是 **composition root**，位于分层图最上方，而非底部。它依赖下层所有子系统，但下层不得反向依赖 runtime。

## 核心规则（违反 = 架构错误）

### 1. 下层不得反向依赖上层

- `packages/protocol` 不得依赖任何上层包或 `src/`、`apps/`、`extensions/`、`skills/`、`ui/`
- `packages/utils` 不得依赖 `packages/core`、`packages/sdk`、`packages/agent-sdk`、`packages/realtime` 及所有上层
- `packages/core` 不得依赖 `packages/sdk`、`packages/agent-sdk`、`packages/realtime`、`src/`、`apps/`、`extensions/`、`skills/`、`ui/`
- `packages/agent-sdk` 不得依赖 `packages/sdk`、`src/`、`apps/`、`extensions/`、`skills/`、`ui/`
- `packages/realtime` 不放具体厂商适配；具体实现走 `extensions/realtime-*`
- `packages/sdk` 不得依赖 `packages/core` 的实现层、`src/`、`apps/`、`extensions/`、`skills/`、`ui/`

### 2. 旁路依赖约束

- `src/bootstrap` 仅可依赖 `packages/core` 及其下层（即 `packages/utils`、`packages/protocol`）；不得依赖 `src/gateway`、`src/commands`、`src/runtime`
- `src/gateway` 不得依赖 `src/bootstrap` 的配置文件
- `src/gateway` 不得依赖客户端实现（src/cli、src/tui、apps/*、ui/）
- `src/runtime` 作为编排层，可依赖 `src/gateway`、`src/bootstrap`、`src/commands`、`src/cli`、`src/tui`、`extensions/*`；但 `src/gateway` 和 `src/bootstrap` 不得反向依赖 `src/runtime`，且 `src/runtime` 内部不得形成循环依赖

### 3. Clients 隔离规则

Clients（src/cli、src/tui、apps/*、ui/）**不得**直接依赖：
- `packages/core` 实现层
- `src/gateway`
- `src/bootstrap`
- `skills/*`
- `extensions/*`

Clients 只应通过 `packages/sdk` 与后端通信。

### 4. Extensions 约束

- `extensions/*` 可依赖 `packages/core` 或 `src/gateway`
- `extensions/*` 不得依赖 clients（src/cli、src/tui、apps/*、ui/）
- `extensions/*` 不得依赖 `skills/*`
- `extensions/realtime-*` 不得把厂商适配细节泄漏到 `packages/realtime`

### 5. Skills 约束

- `skills/*` 仅可依赖 `packages/core` 抽象
- `skills/*` 不得依赖 `packages/sdk`、`src/`、`apps/`、`extensions/`、`ui/`

### 6. 无循环依赖

- 任意两个包之间不得存在循环 import。

## 检查方法

1. 运行 `pnpm dep-guard` 验证依赖方向（这会执行 dependency-cruiser + 自定义 guardrail 脚本）。
2. 对变更文件，检查其 import 语句的来源路径。
3. 对照上面的分层图确认每个 import 的方向是否正确。

## 包职责边界

- `packages/protocol`：只放类型、schema、DTO，不放业务实现。
- `packages/utils`：只放无领域语义的基础工具（如 string-width、path 工具）。
- `packages/core`：放 Agent Loop、领域模型、tool/skill/provider/model 抽象接口。
- `packages/agent-sdk`：对外暴露稳定的 Agent 构建 API，供第三方编程使用。
- `packages/realtime`：放实时音频 stream 抽象、VAD/AEC/语音通道的协议层与共享类型。
- `packages/sdk`：客户端 SDK，依赖 gateway 的协议（不是 gateway 源码）。
- `src/gateway`：应用组装层，注册 plugin、管理 session/workspace/memory、提供 REST 服务。
- `extensions/llm`：LLM 提供方适配。
- `extensions/mcp`：Model Context Protocol 集成。
- `extensions/realtime-aec`：声学回声消除（使用 headless Chrome getUserMedia）。
- `extensions/realtime-vad-silero`：Silero VAD 语音活动检测。
- `extensions/realtime-voice`：实时语音交互（OpenTUI + React）。
- `skills/builtin`：内置 Skill 集合（文件工具、命令工具、补丁、技能发现等）。

## API 契约边界

当变更涉及跨层 API 时：

- request/response shape 应在 protocol types、SDK types、gateway handlers、client code 中一致。
- error behavior 应在各层一致表达。
- optional/nullable 字段在各层间保持一致处理。

## 修复边界

以下架构问题**不得**作为日常 remediation 自动修复：

- 大规模分层重构。
- 跨包循环依赖的解除（需要设计讨论）。
- 变更 tsconfig paths 映射。

如果 Step 发现上述越界问题，标记为 `failed`，设置 `remediation_status: blocked_out_of_boundary`，报告给开发者。
