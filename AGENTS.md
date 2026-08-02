# Step Code

> 终端编码 agent CLI · 由阶跃星辰 Step 系列模型驱动 · Ink TUI
>
> **定位**：Step Code 是一个运行在终端里的 coding agent，由阶跃星辰 Step 系列模型驱动、UI 层用 Ink。为本项目做开发的 AI 代理，在动手前应先读本文件。

## 项目速览

- **语言/运行时**：TypeScript + Node ≥ 22（`glob` 工具用到 `node:fs.globSync`，Node 22 起可用），ESM
- **包管理**：pnpm（项目设置写在 `pnpm-workspace.yaml`，不是 `.npmrc`）
- **UI 层**：Ink 7 + React 19
- **模型接入**：多协议 provider——Anthropic Messages（`@anthropic-ai/sdk`）、OpenAI Chat Completions、OpenAI Responses，三者均支持工具调用，按渠道 `type` 分发；接阶跃 Step 系列模型
- **CLI 解析**：commander；**配置**：TOML（smol-toml）；**校验**：zod 4
- **构建**：`pnpm build`（tsc）；**开发**：`pnpm dev`（tsx）；**类型检查**：`pnpm typecheck`；**测试**：`pnpm test`（vitest）

核心分层：`config` → `provider` → `tools` → `agent`（循环）→ `tui`（Ink）→ `main.tsx`（入口）。

## 目录结构

```
src/
├── main.tsx              # CLI 入口：commander 参数/子命令，交互 render(<App/>) + -p 非交互
├── i18n.ts               # 中英文案表
├── version.ts            # 版本号单一来源（与 package.json 对齐，有测试断言）
├── config/config.ts      # 读 env / .env / ~/.step-code/config.toml；协议预设、渠道与模型别名解析
├── provider/
│   ├── stepfun.ts            # stepfun provider（流式 messages.stream）
│   ├── anthropicMessages.ts  # anthropic 协议 provider
│   ├── openaiChat.ts         # openai 协议 provider（/v1/chat/completions，翻译成 Anthropic 事件流）
│   ├── openaiResponses.ts    # openai_responses 协议 provider（/v1/responses，流式 + 工具调用）
│   ├── openaiCommon.ts       # OpenAI 两协议共用：请求/响应与 Anthropic 形状互译
│   ├── factory.ts / types.ts # provider 按协议分发装配与抽象
│   ├── prepare.ts            # cache_control 注入 + 合并 tool_result-only 消息
│   └── retry.ts              # 指数退避重试 + isRetryableError
├── agent/
│   ├── loop.ts / runTurn.ts  # 多回合编排 + 单回合核心（流式 → tool_use → 授权执行 → 回灌）
│   ├── toolScheduler.ts      # 并行工具调度：资源冲突判定 + 乱序执行 + 按序回收
│   ├── hooks.ts / events.ts / message.ts / wire.ts
│   ├── hooks/engine.ts       # 用户可配置 hooks 引擎（PreToolUse 等 5 事件）
│   ├── systemPrompt.ts       # 系统提示词
│   ├── agentsMd.ts           # AGENTS.md 加载
│   ├── turns.ts              # 轮次派生：消息条数 → 对话轮数、按轮截断
│   ├── reflect.ts            # /reflect 方法论回顾
│   ├── toolSearch.ts         # 外部工具（MCP）懒加载检索
│   ├── workflow.ts           # 工作流编排
│   ├── permission/mode.ts    # 权限判定 manual/auto/yolo + plan 模式硬拦守卫
│   ├── subagent/             # 子 agent：types / registry(内置+md) / runner(嵌套)
│   ├── goal/                 # 自主目标：mode(状态机+双预算+持久化) + drive(纯函数续跑裁决)
│   ├── cron/                 # 定时/循环任务：cronexpr + scheduler + store(按 cwd 持久化)
│   ├── background/           # 后台任务：manager + notify + terminal-notify(BEL/OSC 9)
│   └── compaction/compact.ts # token 估算 + 微压缩 + 全量摘要压缩
├── session/
│   ├── store.ts              # 会话持久化：JSON 快照，按 workdir 分桶（+ fork/resume）
│   ├── attachments.ts        # 大附件内容寻址落盘 + 回填（消息里只留指针）
│   ├── inputHistory.ts       # 输入历史：按 cwd 隔离持久化 + 上下键回溯
│   ├── resumeHint.ts         # 恢复提示文案（轮次 · 条消息双口径）
│   └── debugBundle.ts / debugCli.ts  # 调试包打包（脱敏）+ 无头子命令入口
├── skill/registry.ts     # 技能懒加载：扫描 + frontmatter 解析 + 清单预算 + 激活注入
├── plugin/
│   ├── manager.ts            # 插件发现与能力合流（skills + mcpServers + hooks + commands）
│   └── manage.ts             # 插件安装/启停管理（install/list/enable/disable/remove）
├── mcp/                  # MCP：manager（stdio 连接/发现/调用）+ status
├── tools/                # 各工具（zod schema + execute）+ index.ts 注册表
│                         #   read_file/write_file/edit_file/list_dir/glob/grep/bash
│                         #   spawn_agent/workflow/task_*/todo_list/*_goal/exit_plan_mode/ask_user
│                         #   skill/tool_search/cron_*/web_search/web_fetch/web_image_search
│                         #   access.ts(资源声明) / webCache.ts(搜索·抓取共享缓存)
│                         #   shellResolve.ts(跨平台 shell 探测) / fsutil.ts / searchBase.ts
├── tui/                  # Ink 组件与交互逻辑：
│                         #   App / StatusBar / MessageList / ToolCall / Markdown / diffView
│                         #   ApprovalPrompt / QuestionPrompt / GoalPanel / TodoPanel / CronCard
│                         #   WorkflowPanel / AgentGroup / WorkingStatus / QueuePreview
│                         #   SessionPicker / ModelPicker / ThinkPicker / UndoPicker
│                         #   ExpandedReview(Ctrl+O 展开层) / LiveViewport(动态区视口化)
│                         #   commands.ts / pluginCommand.ts / thinkCommand.ts / reload.ts
│                         #   undo.ts / backtrack.ts / historyReplay.ts / clipboardImage.ts
│                         #   imageAttachment.ts / imageMeta.ts / promptEdit.ts / PromptInput.tsx
└── utils/                # logger / redact
tests/                    # vitest 单元 + 集成测试
```

面向用户的功能说明在 `docs/`，README 只保留一段概述与文档索引。README 是双语的：`README.md` 英文、`README_CN.md` 简体中文，两者顶部有互链索引块，改动其中一份时必须同步另一份。

---

## 模型接入（多协议，按渠道 type 分发）

阶跃 Flash 系列（如 `step-3.7-flash`）三协议均可接入，三者都支持工具调用；coding 默认走 anthropic：

- **anthropic**（Anthropic Messages，`/v1/messages`）：`base_url` **不带 `/v1`**（SDK 自动拼），鉴权 `x-api-key`，`system` 走顶层参数，支持 `thinking` 字段（`[thinking]` 段配 `enabled` + `budget_tokens`）。
- **openai**（Chat Completions，`/v1/chat/completions`）：`base_url` **带 `/v1`**，鉴权 `Authorization: Bearer`，思考走 `reasoning_content`。适合 coding。
- **openai_responses**（Responses，`/v1/responses`）：`base_url` **带 `/v1`**，鉴权 `Authorization: Bearer`，流式，支持工具调用。工具形状与 Chat 不同——tools 定义平铺（`{type,name,description,parameters}`，不嵌 `function`），工具往返用 `function_call` / `function_call_output` 两类独立 input 项靠 `call_id` 关联，而非 `role:"tool"` 消息。阶跃侧目前仅 `step-3.7-flash` 支持该协议。
- `base_url` 的 `/v1` 差异按协议区分（anthropic 不带、openai 带），配错会 404。
- `ChatProvider` 统一产出 Anthropic 形状的事件流与 `finalMessage()`，OpenAI 协议在 provider 内部翻译，消费方（runTurn/loop/compaction/TUI）零感知；新增协议在 `src/provider/` 加适配器 + `PROVIDER_PRESETS` 注册 type。
- 多模态：支持 base64 图片理解（`image/png`|`jpeg`|`gif`|`webp`），不支持音视频；TUI 里 Alt+V 从剪贴板粘贴图片。
- API key 优先级：`STEP_CODE_API_KEY` >（兼容）`STEPFUN_API_KEY` > `~/.step-code/config.toml` 的 `api_key`；`STEP_CODE_PROVIDER`/`BASE_URL`/`MODEL` 可经环境变量覆盖。多渠道多模型经 `[providers.<id>]` + `[models.<别名>]` 配置。

## 开发纪律

- 改动前先读相关文件；改动最小化，不做无关重构
- 每次改完跑 `pnpm typecheck`（tsc 严格模式全开）与 `pnpm test`（vitest）
- 新增工具：在 `src/tools/` 下写单文件（zod schema + execute，返回 `ok()`/`fail()`），再注册进 `src/tools/index.ts` 的 `ALL_TOOLS`；工具报错返回 `fail()` 不抛异常（循环会回灌给模型自纠）
- 权限判定改 `agent/permission/mode.ts` 的 `decide`；斜杠命令改 `tui/commands.ts` 注册表 + `App` 分发；横切逻辑走 `agent/hooks.ts` 的 `LoopHooks` 缝，不要塞进 `runTurn` 核心
- 子 agent：角色定义在 `agent/subagent/registry.ts`（内置）或 `.step-code/agents/*.md`（frontmatter：description/tools/model/maxSteps + 正文=system prompt）；派生走 `spawn_agent` 工具 → `runSubagent`。递归防护双保险：子 agent 工具集永不含 spawn_agent + `ToolContext.depth` 上限。限制走 `~/.step-code/config.toml` 的 `[subagent]` 段（`max_depth` / `max_per_session` / `max_steps`，「可配 + 默认 + clamp」，见 `config.ts` 的 `resolveSubagentLimits`）
- 跨平台优先：文件操作用 `node:fs` 原生 API 而非 shell；bash 工具在 Windows 下已封装 Git Bash 探测
- 跨平台路径拼接：只要处理的是 Windows 风格路径（包括只在 `process.platform === 'win32'` 分支内使用的函数、以及被 mock 成 `'win32'` 的单测），必须显式用 `path.win32`（或 `path.posix`），禁止直接使用默认的 `path.join`。默认 `join` 在 POSIX 机器上会把反斜杠当成普通字符，拼出 `D:\Tools\Git/bin/bash.exe` 这类混合分隔符，导致路径匹配失败。
- pnpm 配置改动写在 `pnpm-workspace.yaml`（pnpm 10+ 不再读 package.json 的 `pnpm` 字段）

## 已具备能力

工具循环 + 错误回灌、权限系统（manual/auto/yolo + 审批）、计划模式（`/plan`）、Esc 中断、指数退避重试（`Retry-After` 优先 + 并行子 agent 429 重排队）、Anthropic prompt cache 注入、会话持久化（`--continue` / `--session` / `--resume` / `/fork`）、上下文压缩（micro / full 两级 + `/compact`）、斜杠命令、`--output-format stream-json`、内置联网搜索（`web_search` + `web_image_search`）、markdown 终端渲染、发送缓冲队列、斜杠命令补全、输入框按键导航（Home/End、Ctrl+A/E/W/U/K、词移动）、图片粘贴输入（Alt+V）、thinking 推理过程呈现（流式暗色预览 + 完成折叠）、动态区视口化（防长输出滚动跳顶）、子 agent（`spawn_agent`，内置 general/explore + `.step-code/agents/*.md` 自定义）、并行工具执行（资源冲突驱动）+ 子 agent 并发上限、动态工作流（`workflow`）、任务清单（`todo_list`）、自主目标（`create_goal` 等，轮次 + token 双预算、随会话持久化）、后台任务（`bash run_in_background` + `task_*`，step 边界注入通知）、定时任务（`cron_*`，按 cwd 持久化 + 恢复）、技能懒加载（`skill`）、插件（`~/.step-code/plugins/`，skills + mcpServers + hooks + 命令 + `/plugin` 管理）、用户可配置 hooks（`[[hooks]]`，5 事件）、外部工具懒加载（`tool_search`）、MCP 接入（stdio）、多协议 provider（anthropic / openai / openai_responses）与多渠道多模型（`[providers]` + `[models]` + `/model` 选择器）、子 agent 角色模型按别名跨渠道解析、自定义子 agent 角色进入主 agent system prompt、恢复会话时模型别名失效自动回退默认模型、国际化（中 / 英）。

## 尚未实现（后续迭代）

ACP / 编辑器集成、MCP 的 http/sse transport 与 OAuth（当前仅 stdio）、流式工具调用参数逐显、历史消息 Ink `<Static>` 静态化的进一步优化。
