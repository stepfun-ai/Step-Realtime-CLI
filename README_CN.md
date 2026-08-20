<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README_CN.md">简体中文</a>
</p>

> [!IMPORTANT]
> **非官方 —— 社区自主探索的 CLI。** Step Code 由社区贡献者自主探索实现。

# Step Code

[![CI](https://github.com/stepfun-ai/Step-Realtime-CLI/actions/workflows/test.yml/badge.svg?branch=step-code-explore-pi](https://github.com/stepfun-ai/Step-Realtime-CLI/actions/workflows/test.yml)

终端里的编码 agent CLI，阶跃星辰 **Step 系列模型**为主要适配目标，UI 层用 **pi-tui**。模型接入层支持三种协议（Anthropic Messages、OpenAI Chat Completions、OpenAI Responses），任何兼容的模型都能直接接入；Step 是默认且经过最充分验证的目标。

> 本仓库是 [stepfun-ai/Step-Realtime-CLI](https://github.com/stepfun-ai/Step-Realtime-CLI) 的 `step-code-explore-pi 探索分支。

## 它是什么

Step Code 是一个终端编码 agent CLI，核心是一个 agent 主循环：模型通过工具直接读写真实文件、执行真实命令，结果回灌给模型继续推进，直到任务完成。它用 **pi-tui** 构建 UI，以阶跃星辰 **Step 系列模型**为主要适配目标，同时通过三种开放协议（Anthropic Messages、OpenAI Chat Completions、OpenAI Responses）支持任何兼容的模型接入。

核心能力：
- **三档权限 + 计划模式**：管住「改什么之前先说清楚」
- **子 agent 与 JS 动态工作流**：大任务拆开并行执行
- **自主目标**：跨回合持续推进同一个目标
- **记忆观察池（/memory）**：agent 把观察到的偏好与约定沉淀到纯 markdown 目录（全局 + 项目两层）；观察不直接生效，经你回顾确认后才晋升进规范层。默认关闭
- **团队模式（/team）**：多任务并行改代码库——git worktree 隔离 + 文件范围互斥 + 依赖系统门控 + 五道门审阅收编，支持跨仓
- **上下文压缩 + 会话持久化**：历史完整保留，数天后仍可续接
- **技能、插件与 MCP**：外部能力按需懒加载
- **后台执行**：长命令与整个子 agent 都可转后台运行
- **媒体降级全通道**：图片超限时自动保留最近 N 张重试，anthropic / openai / openai_responses 三协议行为一致
- **图片粘贴与路径回读**：Alt+V 从剪贴板粘贴图片，read_media 支持按路径直读与 probe 分块规划
- **思考过程呈现**：模型的思考过程在 TUI 中呈现——流式期暗色滚动预览、完成后折叠块；模型只回思考签名、不回思考正文时，状态行仍显示「思考中…」，把长时间静默与请求卡死区分开

## 快速上手

需要 Node.js >= 22（用单文件可执行版则不需要 Node）。

```bash
npm i -g https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest/download/step-code.tgz
export STEP_CODE_API_KEY=<your-key>
step
```

装的是预编译好的包，不在本机编译、不拉依赖；链接始终指向最新 Release。不想装 Node 就从 [Releases](https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest) 下对应平台的单文件可执行（Windows / macOS / Linux）；要改代码请走源码安装。

更细的安装与配置见[快速开始](./docs/zh/quickstart.md)，四种安装方式的取舍见[安装](./docs/zh/installation.md)。

如果你手上已经有别的 AI agent，仓库里的 [`skills/step-code-install/`](./skills/step-code-install/SKILL.md) 是一份安装说明技能：clone 后让你的 agent 读它，它就知道怎么装、怎么配 key、装不上时怎么排查。

## 文档

| 文档 | 内容 |
|------|------|
| [快速开始](./docs/zh/quickstart.md) | 安装、配 key、第一次对话 |
| [安装](./docs/zh/installation.md) | 环境要求、源码构建、全局命令、升级卸载 |
| [配置参考](./docs/zh/configuration.md) | config.toml 全字段、多协议渠道与模型别名、环境变量、数据目录 |
| [交互使用](./docs/zh/interactive.md) | TUI 界面、斜杠命令、快捷键、权限三档、计划模式、切模型与渠道 |
| [工具集](./docs/zh/tools.md) | 全部内置工具的参数与行为边界、并行执行与结果回灌机制 |
| [子 agent 与自动化](./docs/zh/agents.md) | spawn_agent、dynamic_workflow、自主目标、定时任务、后台任务 |
| [会话管理](./docs/zh/sessions.md) | 持久化、续接与恢复、分叉、上下文压缩、回顾、非交互输出 |
| [技能、插件与 MCP](./docs/zh/skills-and-mcp.md) | SKILL.md 格式、加载层级、plugin、MCP 接入 |
| [hooks 机制](./docs/zh/hooks.md) | 五个生命周期事件点执行 shell 命令 |
| [AGENTS.md 机制](./docs/zh/agents-md.md) | 项目规范怎么加载、覆盖、自定义来源 |

## 开发

源码分层：`config` → `provider` → `tools` → `agent`（循环）→ `tui-pi`（pi-tui）→ `cli.ts`（入口）；`main.ts` 只是 bin 引导（先设 NODE_ENV 再加载 cli.js）。

```bash
pnpm dev          # tsx 直接跑，交互式开发
pnpm typecheck    # tsc 严格模式
pnpm test         # vitest
```

CI 在 Ubuntu、Windows、macOS 三平台运行 typecheck、build 与 test。开发约定与模型接入铁律见 [`AGENTS.md`](./AGENTS.md)，贡献流程见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

## 致谢

Step Code 的源码由本项目自行编写，与任何第三方项目无隶属、赞助或背书关系。第三方开源许可证原文收录于 [`licenses/`](./licenses/) 目录作为合规留痕，详见 [`licenses/NOTICE.md`](./licenses/NOTICE.md)。

## 许可证

MIT，详见 [`LICENSE`](./LICENSE)。第三方致谢与许可证见 [`licenses/`](./licenses/)。
