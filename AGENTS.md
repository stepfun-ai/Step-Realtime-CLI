# Step Code

> 终端编码 agent CLI · 由阶跃星辰 Step 系列模型驱动 · **主维护版本（pi-tui 渲染层）**
>
> **本仓定位**：`step-code-pi` 是 Step Code 的主维护版本，前端用 pi-tui 差分渲染。
> Ink 版（React 终端框架）已归档至 `step-code-design-draft/step-code-ink/`，仅作设计参考。
>
> **归档版本同步（历史记录）**：两仓同步规则归档在产品设计仓 `两仓关系与差异.md`。
> Ink 版已停止维护，L2 共享层不再需要双向同步。L3 TUI 层（`src/tui-pi/`）是本仓的唯一前端实现。
> 操作细节见 `pi-tui实验/20260816-主仓同步机制与已同步范围.md`。
>
> **定位**：Step Code 是一个运行在终端里的 coding agent，由阶跃星辰 Step 系列模型驱动、UI 层用 pi-tui。为本项目做开发的 AI 代理，在动手前应先读本文件。

## 项目速览

- **语言/运行时**：TypeScript + Node ≥ 22（`glob` 工具用到 `node:fs.globSync`，Node 22 起可用），ESM
- **包管理**：pnpm（项目设置写在 `pnpm-workspace.yaml`，不是 `.npmrc`）
- **UI 层**：pi-tui（@earendil-works/pi-tui，差分渲染、非 React）
- **模型接入**：多协议 provider——Anthropic Messages（`@anthropic-ai/sdk`）、OpenAI Chat Completions、OpenAI Responses，三者均支持工具调用，按渠道 `type` 分发；接阶跃 Step 系列模型
- **CLI 解析**：commander；**配置**：TOML（smol-toml）；**校验**：zod 4
- **构建**：`pnpm build`（tsc）；**开发**：`pnpm dev`（tsx）；**类型检查**：`pnpm typecheck`；**测试**：`pnpm test`（vitest）

核心分层：`config` → `provider` → `tools` → `agent`（循环）→ `tui-pi`（pi-tui）→ `cli.ts`（入口）；`main.ts` 只是 bin 引导（先设 NODE_ENV 再加载 cli.js）。

## 目录结构

```
src/
├── main.ts               # bin 引导：无 JSX，先设 NODE_ENV=production 再 await import('./cli.js')（防 react/reconciler 构建错配，见「bin 引导入口不可污染」）
├── cli.tsx               # CLI 主入口：commander 参数/子命令，交互 render(<App/>) + -p 非交互
├── i18n.ts               # 中英文案表
├── version.ts            # 版本号单一来源（与 package.json 对齐，有测试断言）
├── config/config.ts      # 读 env / .env / ~/.step-code/config.toml；协议预设、渠道与模型别名解析
├── provider/
│   ├── step/                 # 阶跃专属协议适配（三接口参数语义不互通，无法靠协议族推导）
│   │   ├── stepCommon.ts     #   档位折算（budgetToEffort）+ 三通道 effort 参数形态（messages 走 output_config.effort）+ 三套结束原因归一
│   │   └── stepMessages.ts   #   Messages 通道 provider：发 output_config.effort，不发官方 thinking（后者静默无效）
│   ├── adapter.ts            # stepfun 通道 adapter：投影 + 按能力降级 + 错误驱动重投影
│   ├── capability-registry.ts# 模型能力声明（(channel, model) 精确匹配，未声明默认放行）
│   ├── degrader.ts           # 按能力主动降级：媒体块占位化 / thinking 剥离 / cache_control 剥离
│   ├── projector.ts          # 消息投影：轮次结构规整（补空 user 开场等）
│   ├── anthropicMessages.ts  # anthropic 协议 provider（服务 Anthropic 官方端点）
│   ├── openaiChat.ts         # openai 协议 provider（/v1/chat/completions，翻译成 Anthropic 事件流）
│   ├── openaiResponses.ts    # openai_responses 协议 provider（/v1/responses，流式 + 工具调用）
│   ├── openaiCommon.ts       # OpenAI 两协议共用：请求/响应与 Anthropic 形状互译
│   ├── catalog.ts            # models.dev 模型目录导入（/provider add 的目录路径）
│   ├── compaction.ts         # 压缩专用 provider 装配（[compaction] model 跨渠道解析）
│   ├── factory.ts / types.ts # provider 按协议分发装配与抽象
│   ├── prepare.ts            # cache_control 注入 + 合并 tool_result-only 消息
│   └── retry.ts              # 指数退避重试 + isRetryableError + 空响应诊断上下文
├── agent/
│   ├── loop.ts / runTurn.ts  # 多回合编排 + 单回合核心（流式 → tool_use → 授权执行 → 回灌）
│   ├── toolScheduler.ts      # 并行工具调度：资源冲突判定 + 乱序执行 + 按序回收
│   ├── toolResultLimit.ts    # 工具结果体积上限与截断
│   ├── wirelog.ts            # 原始请求/响应帧留存（排查协议层问题用）
│   ├── hooks.ts / events.ts / message.ts / wire.ts
│   ├── hooks/engine.ts       # 用户可配置 hooks 引擎（PreToolUse 等 5 事件）
│   ├── systemPrompt.ts       # 系统提示词
│   ├── agentsMd.ts           # AGENTS.md 加载
│   ├── turns.ts              # 轮次派生：消息条数 → 对话轮数、按轮截断
│   ├── reflect.ts            # /reflect 方法论回顾
│   ├── toolSearch.ts         # 外部工具（MCP）懒加载检索
│   ├── dynamicWorkflow/      # 动态工作流：sandbox(quickjs) / primitives / runner / journal / scriptStore
│   ├── permission/mode.ts    # 权限判定 manual/auto/yolo + plan 模式硬拦守卫
│   ├── subagent/             # 子 agent：types / registry(内置+md) / runner(嵌套)
│   ├── goal/                 # 自主目标：mode(状态机+双预算+持久化) + drive(纯函数续跑裁决)
│   ├── team/                 # 团队模式：types(任务模型) + git(worktree/merge 封装) + store(规则：互斥/门控/五道门/信箱) + mode(session 状态)
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
│                         #   spawn_agent/dynamic_workflow/task_*/todo_list/*_goal/team_*/exit_plan_mode/ask_user
│                         #   skill/tool_search/cron_*/web_search/web_fetch/web_image_search
│                         #   access.ts(资源声明) / webCache.ts(搜索·抓取共享缓存)
│                         #   shellResolve.ts(跨平台 shell 探测) / fsutil.ts / searchBase.ts
├── tui/                  # Ink 组件与交互逻辑：
│                         #   App / StatusBar / MessageList / ToolCall / Markdown / diffView
│                         #   ApprovalPrompt / QuestionPrompt / GoalPanel / TodoPanel / CronCard
│                         #   DynamicWorkflowPanel / AgentGroup / WorkingStatus / QueuePreview
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

- **anthropic**（Anthropic Messages，`/v1/messages`）：`base_url` **不带 `/v1`**（SDK 自动拼），鉴权 `x-api-key`，`system` 走顶层参数。**思考控制用 `output_config.effort`**（官方 step-3.7-flash 文档明确），**不是**顶层 `effort`，也**不是** Anthropic 官方的 `thinking.budget_tokens`——后两者阶跃都接受但静默无效（HTTP 200、参数不生效）。2026-08-03 并发配对实测：`output_config.effort` 的 low/high 有 6/6 同向差异（低档思考量降 85%），顶层 `effort` 与 `thinking.budget_tokens` 均为 3/6、2/6 的随机水平，因此本通道走 `StepMessagesProvider`（`src/provider/step/stepMessages.ts`）而非通用的 `AnthropicMessagesProvider`。`max_tokens` 在本协议是**必填**，缺省返回 400。
- **openai**（Chat Completions，`/v1/chat/completions`）：`base_url` **带 `/v1`**，鉴权 `Authorization: Bearer`，思考走 `reasoning_content`（与 `reasoning` 恒双写，读任一皆可）。思考控制用顶层 `reasoning_effort`。适合 coding。
- **openai_responses**（Responses，`/v1/responses`）：`base_url` **带 `/v1`**，鉴权 `Authorization: Bearer`，流式，支持工具调用。思考控制用嵌套 `reasoning: { effort }`。工具形状与 Chat 不同——tools 定义平铺（`{type,name,description,parameters}`，不嵌 `function`），工具往返用 `function_call` / `function_call_output` 两类独立 input 项靠 `call_id` 关联，而非 `role:"tool"` 消息。阶跃侧目前仅 `step-3.7-flash` 支持该协议。
- **三协议的思考控制参数名与嵌套层级各不相同**，统一由 `src/provider/step/stepCommon.ts` 的 `stepEffortParam()` 翻译。用户配的是档位名（`[thinking] default_level` = low|medium|high），档位名**直接作为 effort 值发出**，不经任何数字中转。取值域不被服务端校验（传 `xhigh`/`bogus` 也返回 200 并被静默忽略），必须在客户端侧收敛。
  运行时的思考参数类型是 `ThinkingParam`（`src/provider/types.ts`），同时带 `level` 与 `budgetTokens` 两个字段：阶跃三协议取 `level`，原生 Anthropic 渠道取 `budgetTokens`（作 `thinking.budget_tokens` 发出）。两者不可互相推导，所以由 `factory.ts` 一次算好两份下发。
  **注意 TS 结构类型在这里帮不上忙**：`{ budgetTokens?: number }` 与 `ThinkingParam` 结构兼容，改动时漏填 `level` 编译器不报错，但档位会静默失效（退回「不发 effort」= 最高思考量）。改这条链路上的任何一环都要手工确认 `level` 有被填上。
- **三协议的结束原因是三套词汇表**（`finish_reason` / `status`+`incomplete_details.reason` / `stop_reason`），分别由 `mapStepChatFinishReason()` / `mapStepResponsesStatus()` / `normalizeStepMessagesStopReason()` 归一。未知值一律归 `null`（无信号），不冒充 `end_turn`——否则截断与内容拦截会被伪装成正常收尾。
- **`usage` 的 `reasoning_tokens` 恒为 0**（三协议实测），思考消耗不可观测。任何「按预算减去思考量算正文余量」的设计都不成立。
- `base_url` 的 `/v1` 差异按协议区分（anthropic 不带、openai 带），配错会 404。
- **模型与协议不是自由组合**：个别模型只在特定接口开放，配错渠道由服务端返回 400 并指明应改用的接口。配置层目前不做前置校验。
- `ChatProvider` 统一产出 Anthropic 形状的事件流与 `finalMessage()`，OpenAI 协议在 provider 内部翻译，消费方（runTurn/loop/compaction/TUI）零感知；新增协议在 `src/provider/` 加适配器 + `PROVIDER_PRESETS` 注册 type。
- 多模态：支持 base64 图片理解（`image/png`|`jpeg`|`gif`|`webp`），不支持音视频；TUI 里 Alt+V 从剪贴板粘贴图片。
- API key 优先级：`STEP_CODE_API_KEY` > `~/.step-code/config.toml` 的 `api_key`（anthropic/openai 协议另认 `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` 惯例变量）；`STEP_CODE_PROVIDER`/`BASE_URL`/`MODEL` 可经环境变量覆盖。多渠道多模型经 `[providers.<id>]` + `[models.<别名>]` 配置。

## 破坏性迭代与兼容判据

1.0 前允许破坏性迭代。判断一段兼容代码去留的判据只有一条：**只为旧版本自产数据/格式/配置存在的兼容，拆；为不受控外部行为（服务端、SDK、协议、终端、用户手写文件/配置）或前向健壮性（崩溃窗口、中断）存在的容错，留。**

- 拆的例子：读旧格式会话文件时的折算与归一化路径；旧环境变量名的回落识别。
- 留的例子：事件日志读盘时容忍崩溃截断的尾行（防进程死在写入中途）；对用户手写的 base_url 做裸域名/后缀归一化（防配置书写习惯差异导致 404）。
- 每一段被保留的容错，注释里必须写明它防的是哪个外部行为，不允许只写「兼容」「兜底」——否则下次清理时无法区分它是容错还是旧数据兼容。

## 开发纪律

- 改动前先读相关文件；改动最小化，不做无关重构
- 每次改完跑 `pnpm typecheck`（tsc 严格模式全开）与 `pnpm test`（vitest）
- 新增工具：在 `src/tools/` 下写单文件（zod schema + execute，返回 `ok()`/`fail()`），再注册进 `src/tools/index.ts` 的 `ALL_TOOLS`；工具报错返回 `fail()` 不抛异常（循环会回灌给模型自纠）
- 权限判定改 `agent/permission/mode.ts` 的 `decide`；斜杠命令改 `tui/commands.ts` 注册表 + `App` 分发；横切逻辑走 `agent/hooks.ts` 的 `LoopHooks` 缝，不要塞进 `runTurn` 核心
- 子 agent：角色定义在 `agent/subagent/registry.ts`（内置）或 `.step-code/agents/*.md`（frontmatter：description/tools/model/maxSteps + 正文=system prompt）；派生走 `spawn_agent` 工具 → `runSubagent`。递归防护双保险：子 agent 工具集永不含 spawn_agent + `ToolContext.depth` 上限。限制走 `~/.step-code/config.toml` 的 `[subagent]` 段（`max_depth` / `max_steps` / `max_concurrent`，「可配 + 默认 + clamp」，见 `config.ts` 的 `resolveSubagentLimits`）
- 跨平台优先：文件操作用 `node:fs` 原生 API 而非 shell；bash 工具在 Windows 下已封装 Git Bash 探测
- 跨平台路径拼接：只要处理的是 Windows 风格路径（包括只在 `process.platform === 'win32'` 分支内使用的函数、以及被 mock 成 `'win32'` 的单测），必须显式用 `path.win32`（或 `path.posix`），禁止直接使用默认的 `path.join`。默认 `join` 在 POSIX 机器上会把反斜杠当成普通字符，拼出 `D:\Tools\Git/bin/bash.exe` 这类混合分隔符，导致路径匹配失败。
- pnpm 配置改动写在 `pnpm-workspace.yaml`（pnpm 10+ 不再读 package.json 的 `pnpm` 字段）

### bin 引导入口不可污染（硬约束）

`src/main.ts` 是 bin 入口，**只做两件事**：设 `process.env.NODE_ENV`，然后 `await import('./cli.js')`。

**禁止**给它加任何静态 `import`，禁止改成 `.tsx`，禁止把 `NODE_ENV` 赋值挪到 `await import` 之后。

原因：`react` 与 `react-reconciler` 的 CJS 入口按 require 那一刻的 `NODE_ENV` 分流成
production / development 两套构建，两者必须一致。错配时 reconciler 调度**静默失效**——
ink 的 `render()` 正常返回、根组件函数从未被调用、终端零字节输出、无任何异常，TUI 表现为
启动即空白屏。而 `-p` 非交互模式与全部单元测试都不经这条链路，**照常全绿**。

引导文件之所以有效，是因为它没有 JSX（tsc 不会往产物顶部注入 `react/jsx-runtime`）也没有
静态 import（没有模块能在赋值语句之前求值）。加一行静态 import 就会重新打开这个窗口。

**反过来，`src/cli.tsx` 里禁止设置 `NODE_ENV`，也禁止 import 任何设置它的模块。** 这条比上面
那条更反直觉，务必不要「为了更安全」加回去：曾经 `cli.tsx` 的首个 import 是 `./env.js`
（只做 `NODE_ENV ??= 'production'`）当兜底，2026-08-03 实测证明它**净有害**。因为 tsc 注入的
`react/jsx-runtime` 排在所有源码 import 之前，其内部 `require('react')` 已让 **react 主包**
分流完毕；此时设 `NODE_ENV` 只够得到随后由 ink 拉起的 reconciler，够不到 react，于是亲手
制造 react(dev) + reconciler(prod) 错配。用 require hook 记录各包实际加载的构建，实测
（外部一律 `env -u NODE_ENV`）：

| 被测路径 | react | reconciler | stdout | 结果 |
|---|---|---|---|---|
| `node dist/cli.js`（cli 有该兜底） | dev | prod | **0 字节** | 空白屏 |
| `node dist/cli.js`（已删除兜底，现状） | dev | dev | 2000+ | 正常 |
| `node dist/main.js`（引导入口） | prod | prod | 2000+ | 正常 |
| `node dist-bundle/step.mjs`（define 折叠） | 折叠 | 折叠 | 2000+ | 正常 |

即：不设时两包一致走 dev、完全可用；那道兜底唯一真正生效的场合，就是把可用变成静默卡死。
三条分发路径各有自己的机制——bin 靠引导文件，bundle 靠 esbuild `define` 静态折叠，直跑
`cli.tsx`（仅开发调试）靠「不设即一致」。`src/env.ts` 已删除，不得重建。

改动入口相关文件后必须跑这两条（`pnpm test` 已包含）：

- `tests/env.test.ts` —— 9 例结构断言（引导文件无静态 import、赋值早于动态 import、bin 与
  dev 脚本指向、**cli.tsx 不设 NODE_ENV / 不 import 兜底 / env.ts 不存在**、bundle 有 define）
- `tests/tui/firstFrameSmoke.test.ts` —— 进程级冒烟，真实 spawn `dist/main.js` 断言 stdout 非空。
  **依赖 `dist/` 已构建**，未构建时自动跳过，所以改完入口要先 `pnpm build` 再跑，否则这条测不到。

2026-08-03 的实际事故记录、外部同类工具的处置对照与本方案的权衡过程，已归档在内部设计仓。

## 并发开发纪律（多终端并行，必读）

本仓常有**多个终端 / 多个 agent 会话同时开工**。工作区是共享的，你看到的未提交改动**不一定是你的**。

### 一，四个禁用命令

以下命令作用于**整个工作区**，不受你指定的路径限制，会把他人在途改动一并卷走：

```
git stash            git checkout <分支>/.
git switch           git reset --hard
```

`git stash push <单个文件>` **同样危险**：实测指定单文件仍会带走其他 6 个文件的改动（2026-08-02 事故，详见下）。真要用先 `git stash show --stat` 预检，但首选是**根本不用**。

### 二，跑验证不要动工作区状态

需要绕开某个文件的问题时，**单跑目标测试**，不要隔离、不要 stash：

```bash
npx vitest run tests/session/streamJson.test.ts   # vitest 按需编译，无关文件有问题也不影响
```

只有**准备提交前**才跑全量 `pnpm typecheck` + `pnpm test`。

### 三，全量 tsc 的报错不一定是别人的

共享工作区里 `tsc --noEmit` 会同时编译他人在途的半成品，**也会编译你自己上一步的中间态**。看到不认识的报错，按顺序排除：

1. 是不是我刚才编辑到一半？→ 改完再跑一次
2. `git diff <该文件>` 看改动内容，判断归属
3. 单独编译那个文件确认：`npx tsc --noEmit --skipLibCheck <file>`
4. 确认是他人问题 → **记录并告知，不要替他修、不要隔离**

### 四，提交只提自己的

`git add -A` / `git commit -a` 禁用。逐文件 add，提交前 `git status` 核对清单里没有他人文件。

### 五，需要长期隔离才开 worktree

worktree 用于**开工前**就知道要长期并行的场景，不是用来救场的：

```bash
git worktree add ../step-code-worktrees/<名字> -b wt/<名字>
```

改动已经铺开后再建 worktree 是负收益（要么搬运有风险，要么空着没用）。

### 事故记录（2026-08-02）

排查 `-p` 错误路径时，全量 `tsc` 报 `updateConfig.ts` 语法错误。我判定是他人在途改动引入，执行 `git stash push src/skill/builtin/updateConfig.ts` 隔离，**结果卷走了另一会话 6 个文件的改动**（`loop.ts`、`compaction.ts`、`App.tsx` 等）。

事后复核发现两层错误，**后一层更值得记**：

- **操作失误**：`stash push <单文件>` 不是文件级操作。
- **判断失误（根因）**：那个文件**从来就没有语法错误**——表格在普通字符串里不是模板串，`<别名>` 不会被当泛型解析。真实报错来自我自己当时改到一半的 `main.tsx` / `streamJson.ts`，行号恰好落在那个文件上。**我在一个错误的诊断上采取了不必要的隔离动作。**

代价：他人工作未丢（其间已提交为 `6dee63b`），但我自己三个文件的改动在 stash/pop 往复中丢失、全部重做。

教训一句话：**先确认报错是不是自己造成的，再考虑动手；诊断没坐实之前，不要对共享工作区做任何状态变更。**

## 已具备能力

工具循环 + 错误回灌、权限系统（manual/auto/yolo + 审批）、计划模式（`/plan`）、Esc 中断、指数退避重试（`Retry-After` 优先 + 并行子 agent 429 重排队）、Anthropic prompt cache 注入、会话持久化（`--continue` / `--session` / `--resume` / `/fork`）、上下文压缩（micro / full 两级 + `/compact`）、斜杠命令、`--output-format stream-json`、内置联网搜索（`web_search` + `web_image_search`）、markdown 终端渲染、发送缓冲队列、斜杠命令补全、输入框按键导航（Home/End、Ctrl+A/E/W/U/K、词移动）、图片粘贴输入（Alt+V）、thinking 推理过程呈现（流式暗色预览 + 完成折叠）、动态区视口化（防长输出滚动跳顶）、子 agent（`spawn_agent`，内置 general/explore + `.step-code/agents/*.md` 自定义）、并行工具执行（资源冲突驱动）+ 子 agent 并发上限、动态工作流（`dynamic_workflow`，模型写 JS 脚本编排子 agent，TUI 实时显示 phase 阶段）、任务清单（`todo_list`）、自主目标（`create_goal` 等，轮次 + token 双预算、随会话持久化）、后台任务（`bash run_in_background` + `task_*`，step 边界注入通知）、定时任务（`cron_*`，按 cwd 持久化 + 恢复）、技能懒加载（`skill`）、插件（`~/.step-code/plugins/`，skills + mcpServers + hooks + 命令 + `/plugin` 管理）、用户可配置 hooks（`[[hooks]]`，5 事件）、外部工具懒加载（`tool_search`）、MCP 接入（stdio）、多协议 provider（anthropic / openai / openai_responses）与多渠道多模型（`[providers]` + `[models]` + `/model` 选择器）、子 agent 角色模型按别名跨渠道解析、自定义子 agent 角色进入主 agent system prompt、恢复会话时模型别名失效自动回退默认模型、工具调用通道退化检测（模型把调用打成纯文本时发 notice，不静默）、国际化（中 / 英）、启动期 config.toml 轻量自检（语法错误 fail-fast + 语义错误警告 + 别名引用检查，与 `step doctor config` 共用规则）。

## 尚未实现（后续迭代）

ACP / 编辑器集成、MCP 的 http/sse transport 与 OAuth（当前仅 stdio）、流式工具调用参数逐显、历史消息 Ink `<Static>` 静态化的进一步优化。

### 已解决：「服务端返回空响应」的根因（2026-08-03 定位并修复）

完整因果链，四步都在我们这边：

```
messages 通道档位参数位置写错（发顶层 effort，Step 静默忽略未知参数）
  → 用户配的 default_level、会话内 /think 切档全部不生效
  → 实际始终跑服务端默认思考量（并发实测中位 12341tok，接近 high 档）
  → max_tokens 不足时预算在思考阶段耗尽，正文零输出、stop_reason=max_tokens
  → 上层观测到「空响应」，且旧文案把它归因为「网关瞬时故障，请重发」，重发必然再失败
```

修复：`stepEffortParam('messages')` 改发 `output_config.effort`。
实测 `low` 档思考量从 12341tok 降到 1865tok（-85%），这是比调大 `max_tokens` 更根本的手段。

**这条记录的价值在于它是「不报错的 bug」的典型**：请求 200、思考正常返回、
表面一切正常，只有做并发配对统计输出 token 才能发现参数从未生效。
Step 对未知参数一律静默忽略，因此**「发了不报错」永远不能作为「参数生效」的证据**。

### 推翻一个结论后，必须全库扫用户文案（2026-08-03 补，来自一次实际漏改）

修完根因、改完代码、更新完文档之后，**照着旧结论写的用户文案仍然会漏**。
这类残留比代码 bug 更有害：代码 bug 让功能不工作，错误文案会主动劝用户放弃正确的做法。

已发生两次，第二次尤其值得记：

- 「降低思考档位无效，各档思考量相近」这句话测于上面那个 bug 之上（参数发错位置、
  服务端静默忽略，各档当然一样）。参数修好后降档成了压掉 85% 思考量的首选手段，
  但这句话在 4 条 i18n 文案里活到了 2026-08-03，期间一直劝用户别用唯一有效的手段。
- **当次 CHANGELOG 明确写了「相关提示与文档已一并改回」，那 4 条就是在这个前提下漏的。**
  「自认为改完了」是最容易留下残留的状态。

所以推翻结论时按固定清单扫，不靠回忆改过哪几处：
`src/i18n.ts`（zh + en 两张表）、`docs/zh` + `docs/en`、`CHANGELOG.md`、
`src/skill/builtin/*.ts` 的内嵌文本、代码注释。

**已推翻的说法要加测试护栏**，见 `tests/i18n.test.ts` 的
「文案不得复活已被实测推翻的结论」：正则黑名单钉住这类说法，同时正面断言必须给出正确手段
（只禁错的不够，还要要求说对的）。新增护栏的标准是「该说法被实测推翻**且**出现在面向用户的文案里」；
只在代码注释里讲历史不算，注释本来就该记录被推翻的过程。

### 工具调用泄漏检测的判据是尖括号标签，别「优化」回裸词（2026-08-03）

`runTurn.ts` 的 `TOOL_CALL_LEAK_PATTERNS` 只匹配 `<` 开启的标签形态（`<invoke name=`、`<function_calls>` 等），不匹配裸词。原设计写的是裸词，实现时刻意收紧，理由是一个具体的误报场景：

**这些裸词字面就写在本仓库与产品设计仓的文档里**（追踪器第 10 条、健壮性设计 P0.5 节都有），而「读文档并复述给用户」正是本项目 agent 最常做的事。用裸词判据，agent 每次讨论这个机制自己都会触发一次误报。

看起来「更宽的匹配能少漏报」，实际上真实泄漏必然带尖括号——收紧不损失召回，只砍掉误报。`tests/agent/runTurnToolCallLeak.test.ts` 有一条用例专门钉这个（把判据退回裸词 `function_calls` 会让它立刻变红），改判据前先看那条用例的注释。

同样别加的两件事：**不做文本兜底解析**（把漏出的 XML 解析回工具调用——ANTML 非严格 XML 且无转义，参数含尖括号时无法可靠还原，五家参考实现无一家做），**不做回灌重试**（触发条件是上下文长度，回灌不改变它，只会继续泄漏并需要额外的防循环计数）。

### 已知缺口（2026-08-03 三协议实测后登记）

- ~~**档位仍以 token 数暴露给用户**~~ **已修（2026-08-03）**：`[thinking] budget_tokens` 已删除，`default_level`（low|medium|high）成为唯一用户接口，档位名直接作 effort 值发出，`budgetToEffort()` 连同其测试一并移除。同时修掉一个此前未被发现的 bug：该函数的折算阈值（2560 / 18048）是硬编码的，只在默认档位表下无损——用户把 `[thinking.levels]` 的 medium 改成 20000 时，折算结果落到 high，**选中 medium 却发出 high 且无任何提示**。档位名直传后该缺陷消失，`tests/provider/factory.test.ts` 有回归护栏钉住这个场景。
- ~~**`THINKING_TEXT_MARGIN` 余量校验应当删除**~~ **已处理，但结论与原判断不同（2026-08-03）**：`budget_tokens` 那条校验随字段一起删除；`[thinking.levels]` 的逐档校验**保留**，因为原来的删除依据只成立一半。原依据是「被校验的数字不会送达服务端」——这对阶跃渠道成立，但对原生 Anthropic 渠道不成立（那条路径上该数字确实作为 `thinking.budget_tokens` 发出）。更关键的是运行时切档警告（`thinkBudgetSafety`）的结论仍然正确，只是理由换了：不是因为 budget 数字占预算，而是**high 档本身就会让思考吃满 max_tokens**（空响应根因）。所以那个数字在警告里的角色从「即将发出的参数」降级为「档位思考量的估算刻度」——不精确，但单调性对得上，用于排序风险足够。改动理由写在 `src/tui/thinkCommand.ts` 的函数注释里，**不要按旧依据把它删掉**。
- **`max_tokens` 截断未升格为独立分型**：当前映射成 `stop_reason='max_tokens'` 交上层判断，与「服务端瞬时故障」在可重试性上的区别靠 `thinkingExhausted` 标记表达。更彻底的做法是升格为独立错误变体，让「输出预算耗尽」与「可重试故障」在类型层面就分开，不依赖调用方记得读标记。
- ~~**`(model, protocol)` 组合无前置校验**~~ **判定不做（2026-08-03 实测后结案）**：原登记写「应在 `step doctor config` 阶段拦住」，实测服务端报错后判定不必做，理由有三条。
  一是**服务端的报错已经比我们能给的更好**：把只在 Messages 开放的模型配到 Chat Completions 上，返回 400 `this model is not enabled for the Chat Completions API, please use the Messages API (/v1/messages) instead`——直接点出该换哪个接口。填错成非对话模型（TTS/ASR 等）返回 404 并带模型名。两种情况都可自行诊断，不是静默失败。
  二是**客户端预检必然过期**：预检需要硬编码「哪个模型只在哪个接口开放」，那是服务端行为快照，官方开放新协议时我们就变成误报，而服务端那条消息永远是最新的。与 router 那条「快照写进代码会过期」同一个坑。
  三是**真实高频配错不是协议不匹配**：阶跃 `/v1/models` 里 31 个模型只有少数是对话模型，其余是 ASR / TTS / 图像 / GUI / 搜索，手滑填错这些比协议配错常见得多，而它们同样由服务端 404 直接拦住。
  **我们唯一的职责是不吞掉这两条消息**，已由 `tests/provider/openaiChat.test.ts` 的两条护栏测试钉住（断言 400 里「该用哪个接口」那半句与 404 里的模型名完整保留、不截断）。`httpErrorToApiError` 提取 `error.message` 作 summary 且不截断，符合要求。
- **Step Plan 通道有并发限流（HTTP 429），公开 API 没有**：2026-08-03 对照实测，**同一个模型** `step-3.7-flash`、同一协议、同样 18 并发：走 `step_plan/v1` 成功 10/18（失败 8 个全是 429），走公开 `api.stepfun.com/v1` 成功 18/18。**这是通道特性，不是模型特性**——所以 `router` / `step37-plan` / `step35-plan` 三个别名都受影响，而 `step37` / `step35` / `explore` 不受影响。
  客户端侧无需新增限流：429 已被 `isRetryableError` 覆盖走退避重试，并行子 agent 另有 429 重排队（`runTurn.ts` 第二道防线），且 openai 协议路径的 HTTP 错误会被 `httpErrorToApiError` 包成 `Anthropic.APIError`，因此 `isRateLimitError` / `retryAfterMs` 在 Step Plan 通道同样生效。
  （更正：本条初次登记时写作「router 并发上限约 6，当前代码没有防护」，两处都错——归因错了对象，且没查代码。错因是当次实验把错误信息按 `:` 截断，丢掉了 429 状态码。）
- **router 是混合模型：特殊性照实记录，但不为它写专门适配**（项目方确认）。**这不等于不支持 router**——它照常可用，走通用路径；只是不会为它加特例分支。`step-router-v1` 内部路由到多个不同底层模型，因此它的行为在设计上就是不稳定的，**不是可修的 bug**：
  - 档位无单调性且加大采样不收敛——每次请求可能落到不同底层模型，而模型间档位效应差 14 倍（2.9×~59.4×）
  - 同档位样本跨度极大（high 档实测 6/6/177/487/288/270），轻模型与重思考模型混在同组
  - 空响应有两个来源：难题上即使 `low` 档也打满 `max_tokens`（8 次采样 6/8，单请求 111~149s）；以及 `finish_reason=stop` 但只输出 2~30 tok（路由到轻量模型，非截断）。
    后者曾登记为待办「升格独立错误分型」，2026-08-03 复核**判定不做**：它拆开是两种情况且都已有归属——2~30 tok 是 text 块时属合法短答（界面照常显示），全是 thinking 无 text 时 `isEmptyResponse()` 已判 true 并抛 `EmptyResponseError` 带诊断。做成分型必须引入「输出少于 N tok 即异常」的阈值，而输出少本身不是错误信号（问「1+1」答「2」就是 2 tok），唯一能区分合法短答与偷懒的信息是任务复杂度、客户端拿不到。属「需要判断力的要求不写成阈值」。详见 labs README 1.7.1。
  - 单次请求可能返回多个 completion id（多个子模型各自返回）

  **不写特例代码的理由**：首要一条是 **router 自身变更频率高**（项目方确认）——它的路由策略与后端模型池会持续调整，针对某次观测分布写出的适配逻辑会在下次调整后失效甚至反向生效；即使 API 愿意暴露子模型信息，适配也会过期。其次，为多峰分布做客户端适配需要先识别每次请求路由到了哪个子模型，而 API 不暴露该信息。通用健壮性处理（429 退避重试、空响应诊断分型、截断判定）本来就覆盖它。**适配工作优先投给行为稳定的模型。**
  上述观测数据的定位是**排查时对号用**，不作为适配依据，且有时效性——router 侧调整后需重新观测。
- **chat / responses 两通道的 effort 生效性未验证**：写法有官方文档背书，但未做过与 messages 同等强度的并发配对实测。曾据单次采样断言「三协议都支持且单调生效」，重跑即翻转，该断言已撤回。实验方法见 `step-code-labs/api-param-semantics/README.md` 的 1.3 与第二节。
- **effort 效应只在难任务上可观测**：简单任务（模型自主思考量 200~500tok）下三档无差异，包括已证生效的 `output_config.effort`。任何「档位是否生效」的验证都必须用会引发长推理的任务，否则会得出假阴性结论。
