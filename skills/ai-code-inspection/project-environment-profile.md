# 项目环境档案

本文件记录 `ai-code-inspection` 使用的稳定环境事实。

不得在这里记录临时运行状态、Step 输出、命令日志、检查发现或执行历史。只有稳定项目环境事实变化时，才允许更新本文件。

## 工作区

workspace:
  package_manager: pnpm@10.17.0
  monorepo: true
  monorepo_tool: pnpm workspaces
  module_system: ESM
  typescript_version: ~5.7.3
  workspace_packages:
    - packages/protocol
    - packages/utils
    - packages/core
    - packages/agent-sdk
    - packages/realtime
    - packages/sdk
    - extensions/llm
    - extensions/mcp
    - extensions/realtime-aec
    - extensions/realtime-vad-silero
    - extensions/realtime-voice
    - skills/builtin
    - apps/desktop
    - ui
  root_scripts:
    build: `pnpm build`
    lint: `pnpm lint`
    check: `pnpm check`
    check:staged-files: `pnpm check:staged-files`
    format: `pnpm format`
    format:check: `pnpm format:check`
    dep-guard: `pnpm dep-guard`
    deadcode: `pnpm deadcode`
    test: `pnpm test` (vitest, 当前无测试文件)
  build_tool: tsdown (各包独立构建)
  bundler: rolldown (binary bundle)

## 架构分层与依赖规则

本项目的依赖方向有严格层级，由 `dependency-cruiser` 和 `tsconfig paths` 共同约束：

```
packages/protocol  ← 最底层（纯类型和协议）
       ↓
packages/utils     ← 基础工具层
       ↓
packages/core      ← 核心运行时与领域语义
       ↓
packages/agent-sdk ← 对外 Agent 构建 SDK
       ↓
packages/realtime  ← 实时音频/语音协议层
       ↓
packages/sdk       ← 客户端 SDK
       ↓
src/bootstrap      ← 启动/配置（旁路依赖 core）
       ↓
src/gateway        ← 应用组装层（旁路依赖 bootstrap）
       ↓
extensions/*       ← 外部系统适配（可依赖 core 或 gateway）
skills/*           ← Skill 插件（仅可依赖 core 层）
       ↓
src/commands       ← CLI 命令
src/runtime        ← 运行时
src/tui            ← TUI 客户端
src/cli            ← CLI 客户端
apps/*             ← 独立端侧应用
ui/                ← React + Vite 前端
```

关键约束（违反会触发 `dep-guard` 错误）：
- `packages/protocol` 不得依赖任何上层
- `packages/utils` 不得依赖 runtime 或 client 层
- `packages/core` 不得依赖 gateway、client、skill、extension
- `packages/sdk` 不得依赖 core 实现或 runtime 层
- `packages/agent-sdk` 不得依赖 sdk、gateway、clients、extensions、skills、ui
- `skills/*` 仅可依赖 core 抽象，不得依赖 sdk、gateway、clients、extensions、ui
- `extensions/*` 不得依赖 clients 或无关 app 组装代码
- `clients`（src/cli、src/tui、apps/*、ui/）不得直接依赖 core、gateway、bootstrap、skills、extensions
- 不得有循环依赖

## 前端

frontend:
  path: ui/
  framework: React
  language: TypeScript + TSX
  build_tool: Vite
  state_management: not_declared
  ui_library: not_declared
  package_scripts:
    build: `pnpm --dir ui build`
    dev: `pnpm --dir ui dev`
  path_aliases:
    - @step-cli/core -> packages/core/src/index.ts
    - @step-cli/protocol -> packages/protocol/src/index.ts
    - @step-cli/utils -> packages/utils/src/index.ts
    - @step-cli/sdk -> packages/sdk/src/index.ts
    - @step-cli/agent-sdk -> packages/agent-sdk/src/index.ts
    - @step-cli/realtime -> packages/realtime/src/index.ts
    - @step-cli/skills-builtin -> skills/builtin/src/index.ts
    - @step-cli/llm -> extensions/llm/src/index.ts
    - @step-cli/mcp -> extensions/mcp/src/index.ts

## TUI 与 CLI

tui:
  path: src/tui
  framework: OpenTUI (@opentui/core + @opentui/react)
  language: TypeScript + TSX

cli:
  path: src/cli
  framework: Commander
  language: TypeScript

## 后端 / 服务端

gateway:
  path: src/gateway
  language: TypeScript
  description: 应用组装层，负责 Agent Loop、session/workspace 管理、plugin 注册、REST 服务等
  no_orm: true
  no_database: true

## Extensions

extensions:
  - path: extensions/llm
    name: @step-cli/llm
    description: LLM 提供方适配
    deps: core, protocol, utils
  - path: extensions/mcp
    name: @step-cli/mcp
    description: Model Context Protocol 集成
    deps: core, protocol, @modelcontextprotocol/sdk
  - path: extensions/realtime-aec
    name: @step-cli/realtime-aec
    description: 声学回声消除（AEC），使用 headless Chrome getUserMedia
    deps: realtime, ws
  - path: extensions/realtime-vad-silero
    name: @step-cli/realtime-vad-silero
    description: Silero VAD 语音活动检测插件
    deps: realtime, avr-vad
  - path: extensions/realtime-voice
    name: @step-cli/realtime-voice
    description: 实时语音交互（使用 OpenTUI + React）
    deps: realtime, core, agent-sdk, @opentui/react, react

## 工具链

tooling:
  linter: oxlint (~0.15.15)
  formatter: prettier (^3.8.1)
  dead_code: knip (^6.0.4) + ts-prune (^0.10.3) + ts-unused-exports (^11.0.1)
  dep_guard: dependency-cruiser (^17.3.9) + scripts/check-dependency-guardrails.mjs
  type_check: tsc (--noEmit)
  bundler: tsdown (~0.6.10) + rolldown (binary)
  test_runner: vitest (已配置，当前无测试文件)
  hooks: simple-git-hooks (pre-commit: check:staged-files + check)

## 日常验证命令

validation_commands:
  lint: `pnpm lint`
  type_check: `pnpm exec tsc --noEmit`
  dead_code: `pnpm deadcode`
  dep_guard: `pnpm dep-guard`
  format_check: `pnpm format:check`
  full_check: `pnpm check` (lint + dep-guard + deadcode + tsc + format:check)
  root_build: `pnpm build`
  package_build: `pnpm build:packages`
  ui_build: `pnpm --dir ui build`

## 数据库与迁移

database:
  orm: none
  schema_tool: none
  migration_tool: none
  migration_status_policy: 不适用。本项目无数据库依赖，不存在 Prisma schema 或 migration 检查。

## CI/CD

ci_cd:
  remote_platform: Gitea
  ci_enabled: true
  workflow_path: .gitea/workflows/deploy.yml
  ci_capabilities:
    - clean install
    - lint
    - type check
    - dead code check
    - dependency guard check
    - build
    - backend tests
    - frontend build
    - deployment
