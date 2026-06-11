# AGENTS.md

Step Realtime CLI 项目架构与开发原则。

## 1. 总体分层

Step Realtime CLI 采用分层 monorepo 架构，默认依赖方向如下：

`packages/protocol <- packages/utils <- packages/core <- packages/agent-sdk <- packages/realtime <- src/gateway <- packages/sdk <- clients`

旁路依赖如下：

- `src/bootstrap -> packages/core`
- `src/commands -> src/runtime -> src/gateway`
- `skills/* -> packages/core`
- `extensions/* -> packages/core` 或 `src/gateway`
- `src/bootstrap` 承载多个入口复用的启动 / 配置 / prompt 辅助逻辑

这里的 `clients` 指：

- `src/cli/`
- `src/tui/`
- `ui/`
- `apps/desktop/`
- `apps/*` 中未来新增的独立端侧应用

基础规则：

- 上层可以依赖下层，下层不得反向依赖上层。
- `packages/core` 不依赖具体厂商 SDK、数据库、WebSocket 服务端或 UI 层。
- `src/gateway` 是应用组装层，不是公共库层。
- `packages/sdk` 依赖的是 gateway 的协议，不是 gateway 的源码实现。
- UI、TUI、CLI、Desktop 默认只依赖 `packages/sdk`，不直接依赖 `src/gateway`。

## 2. 各层职责

### `packages/protocol/`

负责跨边界契约：

- request/response schema
- event schema
- DTO
- session、workspace、agent、model 的共享类型

该层应尽量保持纯类型和纯协议，不放业务实现。

### `packages/core/`

负责核心运行时与领域语义：

- Agent Loop
- Agent / SubAgent / AgentTeam 编排
- session / workspace 领域模型
- context / prompt 组装
- memory 抽象
- tool / skill / provider / model 抽象接口

该层默认依赖 `packages/protocol`，并允许依赖 `packages/utils` 这类无领域语义的基础共享层；不得直接依赖具体外部实现。

### `packages/agent-sdk/`

负责对外暴露的 Agent 构建 SDK：

- 基于 `packages/core` 暴露稳定的 Agent / Tool / Skill 构建 API
- 供第三方或上层应用以编程方式声明 agent / 工具
- 仅依赖 `packages/core`、`packages/protocol`、`packages/utils`

该层不得反向依赖 `packages/sdk`、`src/*`、`apps/*`、`extensions/*`、`skills/*`、`ui/`（由 `.dependency-cruiser.cjs` 的 `agent-sdk-no-implementation-deps` 强制）。

### `packages/realtime/`

负责实时音频 / 语音相关的协议与运行时：

- 实时音频 stream 抽象
- VAD / AEC / 语音通道的协议层与共享类型
- 供 gateway 与 `extensions/realtime-*` 复用的实时运行时基础设施

该层不放具体厂商适配；具体实现走 `extensions/realtime-*`。

### `packages/utils/`

负责基础共享工具与纯辅助函数：

- 文本、路径、错误、token 估算等无业务状态工具
- 纯格式化、解析、归一化函数
- 可被 core / gateway / sdk / src/bootstrap / skills / extensions 复用的轻量 helper

该层不拥有 session authority，不实现 agent loop，不放具体外部系统集成。

### `skills/`

负责 agent-facing 能力单元：

- `skills/builtin/`：内置工具

`skills/custom/` 与 `skills/templates/` 为后续规划目录，新增项目专属技能或模板时再创建。Skill 的执行契约和注册机制在 `packages/core`，具体技能实现放 `skills/`。

### `extensions/`

负责 system-facing 外部集成：

- `extensions/llm/`：LLM provider 适配器
- `extensions/mcp/`：MCP server / client 适配器
- `extensions/realtime-voice/`：实时语音通道（ASR/TTS/realtime API）
- `extensions/realtime-vad-silero/`：silero VAD 适配
- `extensions/realtime-aec/`：基于 Chrome 的 AEC 适配
- 其他第三方系统集成（IM / Email / storage / vector db / search backend 等）

扩展目录只负责外部系统对接，不负责核心编排语义。realtime-\* 系列适配器统一依赖 `packages/realtime` 暴露的协议层。

### `src/gateway/`

负责服务端宿主能力：

- workspace / session 生命周期管理
- Agent Runtime 调度
- attach / detach / reconnect
- checkpoint / persistence / recovery
- event stream 广播
- auth、quota、多客户端协调

Gateway 是 session 的 authority，也是跨端共享状态的宿主。

### `src/cli/`

负责默认命令行客户端实现：

- CLI REPL / one-shot 输入输出
- 终端输入态与本地展示态
- 通过 `packages/sdk` 调用 gateway

`src/index.ts` 是默认 CLI 可执行入口；`src/cli/` 放客户端实现本身。

### `src/commands/`

负责 CLI 命令注册与参数解析：

- 基于 `commander` 的子命令定义（`step exec`、`step voice`、`step resume`、`step config`、`step theme`、`step aec`、`step vad`、`step service` 等）
- 解析后的参数交给 `src/runtime` 装配运行时

该层不放运行时实现，也不直接持有 session authority。

### `src/runtime/`

负责本地 CLI / TUI 运行时装配：

- 把 bootstrap 解析后的配置组装为 `local-cli-app` / `local-tui-app` 等本地运行实例
- 桥接 OpenTUI、voice runtime、本地 session target
- 供 `src/commands` 启动具体子命令使用

该层不实现 agent loop，也不替代 gateway，本质是把 core / gateway / sdk 的能力组装成可执行入口。

### `packages/sdk/`

负责客户端 SDK：

- 封装对 gateway 的调用
- 封装 session / workspace client API
- 封装 event stream 订阅、重连、错误处理

SDK 不负责实现 agent loop，不负责持久化真实 session 状态。

### `src/bootstrap/`

负责多个 CLI/runtime 入口复用的共享启动层：

- config 加载与模板生成
- instruction prompt 文件解析
- 共享启动默认值与入口辅助逻辑

该层是 bootstrap/helper，不拥有 session authority，不实现 agent loop。
该层可以依赖 `packages/core` 的稳定 helper，但不应依赖 `extensions/*` 的具体实现包；配置 DTO 优先放在 bootstrap 自身或 `packages/protocol`。

### `clients`

负责展示与交互：

- TUI
- Web UI
- CLI
- Desktop

客户端只维护本地视图状态，不拥有核心运行时状态。

## 3. 核心对象归属

### Workspace

- 领域模型和共享类型：`packages/core` + `packages/protocol`
- 生命周期、持久化、权限、成员管理：`src/gateway`

Workspace 是 session 的上级聚合，不是简单的前端目录概念。

### Session

- 状态机、运行时语义、checkpoint 抽象：`packages/core`
- 创建、恢复、销毁、attach、并发控制、持久化：`src/gateway`
- 列表缓存、当前选中项、重连状态：客户端本地状态

客户端不能成为 session source of truth。

### Agent / SubAgent / AgentTeam

全部在 `packages/core` 实现：

- 角色定义
- team 编排
- delegation
- handoff
- 协作策略

### Agent 通信

- 消息语义、路由、handoff、delegate：`packages/core`
- 跨网络或跨端事件格式：`packages/protocol`
- 对 UI/TUI/WebSocket 的广播：`src/gateway`

### Agent Loop

必须统一在 `packages/core` 实现。

所有交互模式都必须调用同一套 loop，而不是各自维护独立循环。

### Context / Prompt

放在 `packages/core`：

- prompt builder
- context assembler
- token budget
- system / user / tool message 组织

需要跨边界传输的 message shape 放在 `packages/protocol`。

### Memory（跨 session）

- memory 接口、策略、读写契约：`packages/core`
- 具体存储实现：`src/gateway` 或 `extensions/`

长期记忆不能放在 UI/TUI 客户端。

### Tool / Plugin

- Tool 抽象、注册器、执行器、权限模型：`packages/core`
- 内置工具和项目技能：`skills/`
- 外部系统接入型插件：`extensions/`

### Skill

Skill 应统一放在 `skills/`，不得散落在 UI、gateway 或 apps 中。

### LLM API

- provider-neutral 接口：`packages/core`
- 具体厂商适配器：`extensions/llm/src/*`

例如 OpenAI、Anthropic、Ollama、StepFun、自建推理服务，都应放在扩展层。

### Model

- `ModelSpec`、能力标记、共享类型：`packages/protocol`
- 模型选择策略：`packages/core`
- 厂商模型映射：`extensions/`

## 4. Session 与 SDK 规则

TUI / UI / CLI / Desktop 默认通过 `packages/sdk` 调用 gateway：

`client -> sdk -> gateway -> core`

必须明确区分两类 session 管理：

- gateway 负责真实 session 管理
- client 只负责本地 session 视图状态

客户端允许维护：

- 当前连接的 `sessionId`
- session 列表缓存
- 消息展示缓存
- 本地输入状态
- 断线重连状态

客户端不得负责：

- session 持久化
- session authority
- checkpoint source of truth
- agent loop 生命周期
- 多客户端并发协调

## 5. 实现约束

- 单一 Agent Loop：所有入口必须复用 `packages/core` 的 loop。
- 单一 Session Authority：默认在 `src/gateway`。
- 单一协议层：跨边界类型统一放在 `packages/protocol`。
- 单一工具契约：Tool / Skill 注册与执行契约统一放在 `packages/core`。
- 单一客户端入口：客户端默认走 `packages/sdk`，不直接 import gateway 内部实现。
- 单一配置文件加载入口：默认在 `src/bootstrap/`，gateway 消费的是已归一化的 `StepCliConfig`。
- 默认 CLI 入口：`src/index.ts`，其客户端实现放在 `src/cli/`。

## 6. 目录使用规则

- 新增核心语义或运行时逻辑：`packages/core/`
- 新增共享协议或 DTO：`packages/protocol/`
- 新增对外 Agent 构建 SDK：`packages/agent-sdk/`
- 新增实时音频 / 语音协议或运行时基础设施：`packages/realtime/`
- 新增客户端调用封装：`packages/sdk/`
- 新增可被多个入口复用的启动、配置、prompt 辅助逻辑：`src/bootstrap/`
- 新增 CLI 子命令注册：`src/commands/`
- 新增本地 CLI / TUI 运行时装配：`src/runtime/`
- 新增内置工具或技能：`skills/`
- 新增第三方集成或通道（含 LLM / MCP / realtime-\* 适配）：`extensions/`
- 新增服务端宿主能力：`src/gateway/`
- 新增默认 CLI 客户端实现：`src/cli/`
- 新增界面与交互：`src/tui/`、`ui/`、`apps/*`

如果某个能力会被多个扩展、多个客户端或多个运行时复用，应优先上移到 `packages/*`，而不是留在 app 层。

Windows 语音模式必须使用 `BrowserAudioDriver`（Chrome / Edge / Chromium）；`SoxAudioDriver` 仅作为 macOS / Linux 的命令行音频 fallback，不得在 Windows 上回退到 `arecord` / `aplay` / `sox`。

Windows 脚本不得直接假设 `pnpm` 可被 `spawn("pnpm")` 找到；需要从 Node 脚本调用 pnpm 时，统一使用 `scripts/package-manager-command.mjs` 解析命令和 Windows shim 包装。

## 7. 开发与协作规范

- 使用 `tsx` 进行开发热重载，`tsdown` 进行生产构建。
- 提交前必须执行 `pnpm check`，该命令依次执行：`oxlint`（lint）、`pnpm dep-guard`（依赖 guardrail：`dependency-cruiser` 分层与 cycle 校验 + `scripts/check-dependency-guardrails.mjs` workspace 依赖声明一致性校验）、`knip`（dead-code）、`tsc --noEmit`（类型检查）、`prettier --check`（格式校验）。
- 提交前必须避免将二进制、构建产物、缓存目录纳入提交。
- 所有公开接口必须提供完整 TypeScript 类型定义。
- 重要分层调整必须同步更新本文件与 `.dependency-cruiser.cjs`。

## 8. 任务执行协议 (Execution Protocol)

1. **计划阶段 (Exec-plan)**：在编写代码或执行命令前，必须输出一个 Markdown 格式的执行计划。
   - 包含：Step (步骤), Tool (使用工具), Expectation (预期结果), Rollback (失败回退方案)。
2. **确认机制**：对于具有副作用的操作（如删除、部署、线上迁移），必须在 Exec-plan 末尾请求人工确认。
3. **工具调用**：优先使用项目根目录下 `scripts/` 中的脚本，而非临时拼凑命令。

## 9. Agent 协作

- 关键任务（新 workspace / 新流程 / 高风险改动 / 需要交接）结束前，默认做一次轻量 Improve Pass：把这次最有价值的 prior 落到 `AGENTS.md` 里。
- `AGENTS.md` 只放强约束、边界和默认值；不要把大而全教程塞进 `AGENTS.md`。
- 需要交接或复盘的工作，优先留下可追溯信息：小步 commit、在 MR / issue 写清 why。不要把 secrets 写进仓库或 MR。
