# 配置参考

本页是配置项的完整参考。按字段查阅；按场景的用法见各主题页。

## API key

三种方式，优先级：环境变量 > 项目根 `.env` > `~/.step-code/config.toml`。

`.env` 只补齐**尚未设置**的环境变量（已存在的键不被覆盖），因此它的实际位置是「环境变量的补充来源」而非独立的第三优先级。只解析 `KEY=VALUE` 行，忽略注释与空行，自动去掉值两侧包裹的单/双引号。

```bash
# 环境变量（隐式渠道只认 STEP_CODE_API_KEY；anthropic / openai 协议另认各自的惯例变量）
export STEP_CODE_API_KEY=<your-key>

# 可选覆盖
export STEP_CODE_BASE_URL=https://api.stepfun.com
export STEP_CODE_MODEL=step-3.7-flash
export STEP_CODE_PROVIDER=stepfun    # 预设：stepfun / anthropic / openai / openai_responses
```

```toml
# ~/.step-code/config.toml（顶层不再支持 api_key；key 见下方 [providers] / [models]）
model = "step-3.7-flash"
base_url = "https://api.stepfun.com"
provider = "stepfun"                 # 默认 stepfun（anthropic 协议）
```

命令行参数 `--provider` / `--model` 优先级最高。

## config.toml 全字段

文件位置：`~/.step-code/config.toml`。

只有用户级这一份，没有项目级 config.toml——配置文件位置即信任边界：克隆一个仓库不应让它随附的配置文件静默注入 api_key、base_url、`[[hooks]]` 命令这类敏感项。项目粒度的定制因此走目录约定，而不是第二份 config.toml：

| 项目级约定 | 位置 |
|-----------|------|
| 项目级 skills | `<项目>/.agents/skills/`、`<项目>/.step-code/skills/` |
| 项目级子 agent | `<项目>/.step-code/agents/` |
| 项目规范 | `<项目>/AGENTS.md` 等，见 [AGENTS.md 机制](./agents-md.md) |

MCP server 声明（`mcp.json`）与 `[[hooks]]` 同理，只读用户级一份。

### 顶层字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `provider` | string | 服务商预设：`stepfun`（默认，anthropic 协议）/ `anthropic` / `openai` / `openai_responses`。预设决定协议与默认端点，见下方[协议与 provider](#协议与-provider) |
| `base_url` | string | API 地址；**是否带 `/v1` 取决于协议**——anthropic 不带（SDK 自拼 `/v1/messages`），openai / openai_responses 要带（拼 `/chat/completions`、`/responses`），见下方[协议与 provider](#协议与-provider) |
| `model` | string | 模型名，缺省用 provider 预设；可填 `[models]` 里的别名（启动时展开）；可用环境变量或命令行 `--model` 覆盖。**会被 `/model` 切换自动改写**（见下方[默认模型自动跟随](#默认模型自动跟随)） |
| `max_context_size` | int | 上下文上限 token 数，默认 262144。不做 clamp，按填写值生效 |
| `max_tokens` | int | 单次响应最大输出 token，默认 65536（足够容纳最高思考档位的预算 + 正文余量，避免思考吃满配额导致正文零输出）。不做 clamp |
| `language` | string | 界面语言：`zh`（默认）/ `en`。其他值一律落回 `zh` |
| `permission_mode` | string | 权限模式默认值：`manual`（默认）/ `auto` / `yolo`，其他值启动报错。优先级：命令行 `--yolo` / `--auto` > 本键 > 恢复会话存储的模式。运行态 `/permission`、`/yolo` 切换不回写本键 |
| `proxy` | string | 代理 URL（`http://` 或 `https://` 开头，其他值启动报错）。生效优先级：环境变量 `HTTPS_PROXY` > 本键 > 直连。全局请求经 Node 内置代理机制生效；`NO_PROXY` 可排除指定域名（如国内端点）。只在启动时读取，`/reload` 改本键需重启生效 |
| `agents_paths` | string[] | 覆盖 AGENTS.md 收集，见 [AGENTS.md 机制](./agents-md.md) |
| `agents_md_max_bytes` | int | AGENTS.md 总量预算（UTF-8 字节），默认 32768；`0` 或负数 = 禁用加载；发生截断时启动会提示，见 [AGENTS.md 机制](./agents-md.md) |
| `extra_skill_dirs` | string[] | 追加 skill 扫描目录，见[技能、插件与 MCP](./skills-and-mcp.md) |
| `disabled_skills` | string[] | 按名排除 skill（任何来源生效），见[技能、插件与 MCP](./skills-and-mcp.md) |
| `media_keep_recent` | int | 媒体降级时保留的最近图片张数，默认 10；`0` = 全部换占位。触发 413/400 图片超限时，只把更旧的图换成占位文本、保留最近 N 张重试，避免「全剥光、模型变瞎」。全通道生效；`[models.*]` 下可按别名覆盖，见[媒体降级](#媒体降级) |

字符串字段的空串等同未配置；数字字段填非数字（含 `NaN` / 无穷）时该字段视为未配置、落默认值。三个字符串数组字段（`agents_paths` / `extra_skill_dirs` / `disabled_skills`）要求**整体合法**：非数组、空数组，或其中任一元素不是非空字符串时，整个字段被丢弃而不是逐项过滤。路径类字段支持 `~` 展开与相对当前工作目录的写法。

顶层 `provider` / `base_url` / `model` 是「单模型」的最简写法。API key **不在顶层配置**，key 只能配在下面的 `[providers.<id>]` 渠道或 `[models.<别名>]` 上，或用环境变量提供。要登记多个模型、多个渠道并在运行时切换，用 `[providers]` + `[models]` 两张表。

### 协议与 provider

provider 层支持三种协议，由预设名或 `[providers.<id>]` 的 `type` 选定：

| 协议 | 端点后缀 | `base_url` 是否带 `/v1` | 工具调用 | 适用 |
|------|----------|------------------------|----------|------|
| `anthropic` | `/v1/messages` | **不带**（SDK 自拼） | 支持 | coding（默认，`stepfun` / `anthropic` 预设走它） |
| `openai` | `/v1/chat/completions` | **带** | 支持 | coding |
| `openai_responses` | `/v1/responses` | **带** | 支持 | coding（阶跃侧目前仅 `step-3.7-flash` 支持此协议） |

阶跃 Step 系列（如 `step-3.7-flash`）三协议均可接入，三种协议都支持流式输出与工具调用，都能跑 agent 主循环。默认 `stepfun` 预设走 anthropic 协议，行为与既有版本一致。`openai_responses` 在阶跃侧目前只有 `step-3.7-flash` 开放，换别的模型走这个协议会被服务端拒绝。

> **最常见的坑：`base_url` 的 `/v1` 差异。** anthropic 协议的 `base_url` 写到域名即可（`https://api.stepfun.com`），SDK 自动拼 `/v1/messages`；openai 与 openai_responses 协议的 `base_url` 必须带 `/v1`（`https://api.stepfun.com/v1`），否则端点拼错、请求 404。四个内置预设已按各自协议设好默认，只有自定义 `base_url` 时才要注意这条。

### `[providers.<id>]` 渠道表

一个渠道就是「一套接入端点 + 凭据」。声明后可被多个模型别名引用，同一服务商的多个端点或多把 key 也能分开表达。

```toml
[providers.step-anthropic]
type = "anthropic"                    # 协议类型：anthropic / openai / openai_responses
base_url = "https://api.stepfun.com"  # anthropic 协议不带 /v1

[providers.step-openai]
type = "openai"                       # OpenAI Chat Completions，适合 coding
base_url = "https://api.stepfun.com/v1"  # openai 协议带 /v1
api_key = "<your-key>"                # 多渠道推荐写法：key 配在渠道上
# api_key_env = "MY_GW_KEY"           # 或只存环境变量名，密钥不落盘（与 api_key 二选一，api_key 优先）
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `type` | 是 | 协议类型：`anthropic` / `openai` / `openai_responses`（也接受 `stepfun` 预设名）；缺失或非法值该渠道无效被整条跳过 |
| `base_url` | 否 | 渠道专属 API 地址，缺省回落别名 → 顶层；渠道与别名都没给、且渠道 `type` 与顶层 `provider` 不同时，回落该 `type` 预设的默认端点（避免把 anthropic 的地址发给 openai 协议）。带不带 `/v1` 按协议区分（见上表） |
| `api_key` | 否 | 渠道专属 key（多渠道推荐写法），缺省按[密钥解析优先级](#密钥解析优先级)回落 |
| `api_key_env` | 否 | 间接引用：只存环境变量名，密钥不落盘；优先级低于 `api_key`、高于惯例环境变量 |

渠道未配 `api_key` / `api_key_env` 时，按渠道 `type` 回落对应的惯例环境变量——这些协议各有自己被广泛使用的变量名，直接沿用可以让已有环境零改动接入：

| 渠道 type | 惯例环境变量 |
|-----------|--------------|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` / `openai_responses` | `OPENAI_API_KEY` |

内置预设 `stepfun` / `anthropic` 只是零配置默认策略的载体：不配任何 `[providers]` 时顶层 `provider` 直接生效。`[models]` 里的 `provider` 字段只能指 `[providers.<id>]` 自定义渠道 id 或缺省继承顶层；显式写内置预设名视为无效别名。

### 密钥解析优先级

每个模型别名展开时按所属分支沿以下链路取第一把可用的 key（`env(X)` 表示读取名为 X 的环境变量，空串视为未设置）：

- **渠道分支**（别名 `provider` 指向 `[providers.<id>]` 渠道）：渠道 `api_key` → env（渠道 `api_key_env`）→ 渠道 type 的惯例环境变量 → 别名 `api_key` → env（别名 `api_key_env`）→ 隐式渠道 key（`STEP_CODE_API_KEY` 或顶层 provider 的惯例环境变量）。
- **继承分支**（别名 `provider` 缺省）：别名 `api_key` → env（别名 `api_key_env`）→ 顶层 provider 的惯例环境变量 → `STEP_CODE_API_KEY`。

隐式渠道 key 本身来自 `STEP_CODE_API_KEY`（顶层 provider 为 anthropic / openai 协议时另认其惯例环境变量）。config.toml 顶层不再支持 `api_key`；整条链都找不到 key 时启动不再报错，由 provider 构造时抛出带配置指引的「缺少 API key」错误。

> **跨服务商混用警告**：隐式渠道 key 是所有渠道的最后一级回落——渠道没配 key 时会把它发给该渠道的端点。混用多家服务商时务必给每个渠道单独配 `api_key` 或 `api_key_env`，避免 key 被发到错误的服务商。

### `[models.<别名>]` 别名表

一个别名把「渠道 + 模型 id + 窗口 + 展示信息」打包成一个可切换单元。字段全部可选，缺省项合并时继承顶层配置；`model` 缺省时等于别名本身。

```toml
[models."step-3.7-flash"]
# provider = "<渠道id>"                # 可选：引用 [providers.<id>] 自定义渠道；缺省继承顶层 provider
model = "step-3.7-flash"
max_context_size = 262144
display_name = "Step 3.7 Flash"         # 可选，选择器与状态栏显示用
capabilities = ["thinking", "image_in"] # 可选，见下方 capabilities 能力标签
```

| 字段 | 说明 |
|------|------|
| `provider` | `[providers.<id>]` 自定义渠道 id，缺省继承顶层 provider。显式写内置预设名（stepfun / anthropic 等）或指向未声明的 id 时，该别名无效（展开时不生效，回落到顶层配置） |
| `model` | 真实模型 id，缺省等于别名本身 |
| `base_url` / `api_key` | 覆盖渠道/顶层的端点与凭据 |
| `api_key_env` | 间接引用：只存环境变量名，密钥不落盘；在回落链中的位置见[密钥解析优先级](#密钥解析优先级) |
| `max_context_size` | 该模型的上下文窗口，缺省回落顶层默认 |
| `max_tokens` | 单次响应最大输出 token，缺省回落顶层 |
| `display_name` | 选择器与状态栏显示名，缺省用别名 |
| `capabilities` | 能力标签数组（如 `thinking` / `image_in`），工具门控与请求整形的唯一依据。要求非空的纯字符串数组、取值在白名单内，否则启动报错（见 [capabilities 能力标签](#capabilities-能力标签)） |
| `media_keep_recent` | 按别名覆盖媒体降级保留张数，缺省继承顶层 `media_keep_recent`。通道图片限制差异大（step-3.7 实测 60 张、Gemini 10 张），宽松通道可多留、严格通道少留，见[媒体降级](#媒体降级) |

- 启动时对最终 model 展开一次别名，因此 `--model 别名`、`STEP_CODE_MODEL=别名`、toml 顶层 `model = "别名"` 三条路径同效。
- 运行时用 `/model` 打开交互式选择器或 `/model <别名>` 直切，切换会按合并配置重建 provider，上下文窗口随之跟随，见[交互使用](./interactive.md)。
- 别名内的未知字段被忽略；别名名为空串或其值不是表时，该条被跳过。

#### 默认模型自动跟随

`/model` 切换（选择器确认或 `/model <别名>` 直切）会把顶层 `model` 一并改写为所选**别名**，因此下次启动 `step` 开新会话时自动沿用上次的选择，不需要手改配置文件。

写入行为：

- 只改顶层 `model = ` 那一行；注释、`[providers.*]`、`[models.*]` 各段与原文件的换行风格（CRLF/LF）逐字保留，不做整文件重写。
- 写的是**别名**而不是展开后的真实模型 id。别名承载「渠道 + 真实模型 + 窗口大小 + 显示名」一整组绑定，写真实 id 会让下次启动查不到别名，`max_context_size` 回落到顶层默认值（压缩时机随之失准）。
- 与当前值相同时不写盘。
- 配置文件不可写（只读、权限不足）时，本次切换照常生效，仅在转录区提示一行——配置写入只影响下次启动。

以下两种情况**不会**改动配置文件：

| 场景 | 原因 |
|------|------|
| `step --model <x>` 命令行覆盖 | flag 表达的是「本次运行临时用它」，让一次性覆盖产生持久后果违反 flag 语义 |
| `/resume` 恢复了用别的模型的旧会话 | 恢复是回到那个会话的现场，不是表达对未来新会话的偏好；翻一眼旧会话不该悄悄改掉全局默认 |

多个 step 进程同时切模型时，最后写入者胜出。该竞态只影响「下次启动用哪个」，不损坏配置内容。

#### capabilities 能力标签

`capabilities` 是别名的能力声明，也是模型能力的**唯一来源**——工具门控与请求整形都读它。

| 值 | 含义 | 效果 |
|----|------|------|
| `image_in` | 模型接受图片输入 | `read_media` 工具挂载；请求里的图片块不被剥离 |
| `thinking` | 模型带推理过程输出 | 历史思考块随请求回传，不被剥离 |
| `tool_use` | 模型支持工具调用 | 工具表正常下发 |
| `cache_control` | 模型接受 prompt cache 断点 | 允许注入该字段（Step 系列实测不兼容，默认不注入） |
| `video_in` | 模型接受视频输入 | `read_media` 可读取视频（mp4/mov/webm，按原始字节 inline 交付，默认预算 32MB）；请求里的视频块不被投影为占位文本 |
| `audio_in` | 模型接受音频输入 | 预留 |

**未声明时的默认值**：`image_in` / `thinking` / `tool_use` 默认视为**支持**，`video_in` 默认视为**不支持**（视频块体积大、端点接受面窄，未声明时发送前投影为占位文本），`cache_control` 默认不注入。

这个取向是刻意的：能力猜少了，客户端会静默剥掉你真实发出的内容（图片被换成占位文本、历史思考被删），不报错也看不见；猜多了服务端会明确报错，且有自动降级重投影兜底。**静默丢内容比显式报错难查得多**，所以默认放行。

`capabilities` 的语义：写了某个值就是声明支持，没写的维度沿用上面的默认值，不会因为漏写而丢能力。此外支持 `-` 前缀**显式取负**（如 `capabilities = ["-image_in"]` 声明该模型不收图片），用于你确知端点行为的场景——声明不收图后，带图提交会被拦下并提示，历史中的图片在发送前以占位文本投影（原图保留，切回多模态模型即恢复）。孤立的 `-` 视为未知值，启动报错。

- 取值域有校验：写了未知能力名（如把 `image_in` 拼成 `image-in`）会在启动时报错并列出可用值，不再静默失效。字段类型不对（不是非空字符串数组）同样报错。
- 大小写与首尾空白会被归一（`IMAGE_IN` 等同 `image_in`）。
- 声明修改后用 `/reload` 即时生效（无需切换模型或重启）。
- 思考的**展示**不看 `capabilities`：状态栏的 `think:` 段来自会话级 `/think` 档位，思考块渲染是无条件的。是否发送思考控制字段由 `[thinking]` 段决定。
- **协议限制**：`read_media` 的图片回传目前只在 `anthropic` 协议渠道端到端有效——`openai` 协议渠道的工具结果折叠只保留文本，图片会被静默丢弃。openai 渠道声明了 `image_in` 也实际读不到图，该协议翻译缺口已登记待修。
- **模型与协议不是自由组合**：个别模型只在特定接口上开放，配错渠道会在实际请求时收到服务端的 400 提示（错误信息里会指明应改用哪个接口）。

#### 媒体降级

当一次请求因图片超限被 API 拒绝（413 载荷过大、400 图片太多/太大）时，step-code 会把历史里较旧的图片换成占位文本、只保留最近 N 张，然后自动重试——避免整张会话被一张超限图「毒化」（后续所有消息包括纯文本都报同一个错）。

**降级档位**（沿链逐档重试，每档每请求最多一次）：

| 档位 | 行为 |
|------|------|
| `media-degraded` | 保留最近 `media_keep_recent` 张图，更旧的换占位文本（占位文案保留「原图因 API 限制被移除」语义，模型不会以为自己记错） |
| `media-stripped` | 全部媒体块移除 |
| `strict` | 媒体移除 + 思考块与 cache_control 剥掉（最保守形态） |

**触发识别**：413 直接触发（语义唯一）；400 只在报错文案命中媒体方言时触发——`Input images too many`（stepfun 实测）、`image exceeds 5 MB maximum` / `image dimensions exceed max allowed size`（Anthropic）、`You can only include N image links`（Gemini/Vertex）、`At most N image(s)`（vLLM 推理端）等。裸 400 参数错误（如 `max_tokens` 非法）**不触发**，不会被降级掩盖。

**配置**：

- 顶层 `media_keep_recent`（默认 10）设全局保留张数；`0` = 全部换占位（旧行为）。
- `[models.*]` 下的 `media_keep_recent` 按别名覆盖。通道图片限制差异大（step-3.7 实测 60 张/请求、Gemini 10 张、GLM 5 张），宽松通道可多留、严格通道少留。

**默认值 10 的依据**：step-3.7-flash 实测单请求 60 张上限（2026-08-06 直连 API，61 张报 `max: 60`），10 是其 1/6 安全值——日常几乎不触发降级，触发时也保留足够上下文。「长图分段阅读」场景一段对话读 10+ 张很常见，3 张的旧默认值会让主 agent 立刻忘记除最近 3 张外的所有图。

**全通道生效**：stepfun 通道走 adapter 的发送路径，其余协议通道（anthropic / openai / openai_responses）走统一的媒体降级包装层，行为一致。

**已知边界**：修改历史图片会让 prompt cache 前缀失效，降级后的一两轮请求成本可能上升；这是 API 侧行为，无法避免。

### `/provider` 渠道向导

`/provider` 命令是渠道的交互式管理入口：

- **无参**：打开渠道管理面板——`[providers]` 自定义渠道与内置预设的合并列表（自定义渠道与预设同名时自定义优先，预设独有行标「内置」，当前生效渠道标 `← 当前`）。Enter 切换渠道：自定义渠道切到它按配置文件顺序的第一个模型别名（与 `/model` 选择器同一条路径，按别名合并配置重建 provider 并写回默认模型指针），预设走预设重建；渠道下无别名时不切换并提示。A 或末尾 CTA 行进入新增向导；D 删除自定义渠道（见下）；Esc 关闭。
- **`/provider list`**：只读文本列表（id / 协议 / 端点 / 别名数与归属别名），供 print 模式与脚本场景使用。
- **`/provider <id>`**：文本直切，解析顺序为自定义渠道 id > 内置预设名，都不命中时报错并列出全部可用渠道。
- **`/provider add`**：唤起新增向导，两条路径——
  - **手动录入**：逐步填写渠道 id、协议类型、base_url、API key（或环境变量引用）、首个模型别名（模型 id / 显示名 / 窗口）、capabilities 多选。
  - **目录导入**：从 models.dev 模型目录拉取供应商清单（地址默认 `https://models.dev/api.json`，可用 `--url` 覆盖为镜像或本地文件），选中供应商后按目录元数据自动预填端点、全部模型别名、窗口与能力，只需补 API key。deprecated / alpha 状态的模型不进导入列表。
- 写入方式为在 config.toml **末尾追加** `[providers]` / `[models]` 段：不重序列化文件、已有内容与注释原样保留；写前自动时间戳备份，写完自动跑 `step doctor config` 校验，失败回滚。新增成功后配置自动刷新，并直接拉起模型选择器（预选到新渠道 tab）设默认模型——Esc 只是「不设默认」，已落盘的渠道与模型不撤销。
- 目录拉取走全局代理约定：环境变量 `HTTPS_PROXY` > 顶层 `proxy` 键 > 直连。目录不可达时向导会提示检查网络、代理设置或 `--url` 镜像。

**删除渠道**（面板内 D，内联 [y/N] 确认）：文本级摘除——从 config.toml 删掉 `[providers.<id>]` 整节与所有 `provider = "<id>"` 的 `[models.<别名>]` 整节；顶层 `model` 指针若指向被删别名一并清除（下次启动回落默认解析）。与新增同款安全链：写前时间戳备份 → 一次落盘 → doctor 校验 → 失败回滚。内置预设不可删（不在 config.toml 中）。删除当前生效渠道时本会话内存中的 provider 实例继续可用，重启或切换后失效；删除后 `/reload` 让配置全面生效。

### `[thinking]` 推理过程

Step 3.x 系列是恒思考模型，无论是否发送思考控制字段，响应都可能带思考块——TUI 会无条件渲染（见[交互使用](./interactive.md)）。本段控制**请求侧是否主动声明思考深度，以及用哪一档**。

```toml
[thinking]
enabled = true            # 默认 false：不主动声明思考深度，由服务端决定
default_level = "medium"  # 思考档位，只能是 low / medium / high；缺省 medium

[thinking.levels]         # 高级选项，一般不用配；只对原生 Anthropic 渠道生效
low = 1024
medium = 4096
high = 32000
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | false | 是否主动声明思考深度。默认关，此时思考深度由服务端默认值决定 |
| `default_level` | `"medium"` | 思考档位，取值只能是 `low` / `medium` / `high`，其他值加载时报配置错误 |
| `levels` | low/medium/high = 1024/4096/32000 | **高级选项**：档位 → budget token 数。只在原生 Anthropic 渠道生效，见下文 |

运行时可用 `/think` 会话级切换档位（选择器/直切/off），见[交互使用](./interactive.md)。

档位名会直接作为思考强度值随请求发出。三个协议的参数名与嵌套位置各不相同（`output_config.effort` / 顶层 `reasoning_effort` / 嵌套 `reasoning.effort`），Step Code 各自翻译，你不需要关心配的是哪条渠道。

**没有 `budget_tokens` 这个键**。曾经有，已删除：阶跃三个接口都只收档位字符串、不收 token 数字，那个数字从来没有真正发出过，只是被用来折算档位——而折算阈值是固定的，改了 `[thinking.levels]` 的数字反而会导致选中的档位和实际发出的档位不一致。既然填了不生效、还可能错档，就不该让用户填。配了这个键现在会直接报错并提示改用 `default_level`。

**`[thinking.levels]` 的数字只在原生 Anthropic 渠道（`api.anthropic.com`）生效**，在那条路径上作为 `thinking.budget_tokens` 真实发出。用阶跃渠道时改这些数字零影响，通常不需要动这段。

**不配 `default_level` 时缺省是 `medium`，而不是「不声明档位」**。这不是保守取值，是必要的：实测「不声明档位」并不中性，三条通道在不声明时的思考量都落在最高档附近，难任务上会把输出预算占满导致空回答。换句话说，「不替用户选」的实际效果等于「悄悄选了最高档」，所以缺省必须显式取中档。

#### 关于「思考吃满输出预算」

思考和正文共用 `max_tokens` 这一份输出预算，思考写在前面。预算不足时思考会把额度用光，正文一个字也发不出来——这时你会看到一个空回答，结束原因是「达到输出上限」。

两个办法，都有效：

1. **降低思考档位**。实测低档相比不声明档位可把思考量压掉约 85%（同一道难题上，思考从约 12000 token 降到约 1900 token）。运行时用 `/think low`，或在配置里把 `default_level` 设低。
2. **调大 `max_tokens`**。默认值 65536 对绝大多数编程任务足够；如果你手工调小过它，遇到空回答优先调回来。

需要注意档位的作用范围：档位管的是「模型倾向想多深」，是训练出来的行为倾向而非硬上限。
所以在**简单任务**上你几乎看不出档位差别（模型自主思考量本就只有几百 token，各档都够用），
差异只在需要长推理的任务上才显现。

复杂任务（长文档分析、严格 JSON 结构化输出、多模态输入）需要的思考量更大，预算也要相应留足。

> **一条历史更正**：本节此前写着「降低思考档位并不能解决这个问题，实测各档思考长度几乎没有差别」。
> 那个结论来自一次错误实现——档位参数发在了错误的字段位置上，服务端静默忽略，
> 于是所有档位实际都在跑服务端默认深度，自然「没有差别」。参数位置修正后档位真实生效。

### `[continuation]` 输出截断自动续写

```toml
[continuation]
max_auto_continues = 3  # 默认 3；设 0 关闭自动续写
```

| 字段 | 默认 | 范围 | 说明 |
|------|------|------|------|
| `max_auto_continues` | `3` | 0–100 | 单回合输出被 `max_tokens` 截断后自动续写的次数；`0` = 关闭自动续写，回到手动「继续」 |

自动续写只对「正文写到一半被截断」生效；思考吃满预算、正文零输出的情况不走续写（那是预算配置问题，续写改变不了预算）。每轮续写都经过循环守卫，会在零进展 / 完全重复 / 从头重写 / 周期性复读 / 龟速循环时停下。

### `[subagent]` 子 agent 限制

| 字段 | 默认 | 范围 | 说明 |
|------|------|------|------|
| `max_depth` | 1 | 1–3 | 嵌套深度上限 |
| `max_steps` | 100 | 1–1000 | 子 agent 内部最大往返轮数 |
| `max_concurrent` | 4 | 1–16 | 并行子 agent 并发上限 |

#### `[subagent.retention]` 子会话留存

| 字段 | 默认 | 说明 |
|------|------|------|
| `delete_with_parent` | true | 删除主会话时连带删除其子会话（持活跃锁的跳过） |
| `max_sessions` | 0 | 子会话数量上限，超出删最旧；0 = 不限 |
| `ttl_days` | 0 | 子会话过期天数；0 = 不过期 |

`max_sessions` / `ttl_days` 的清理只在进程启动时执行一次，所有清理路径都会跳过正在运行的子会话。子会话的查看与管理见[会话管理](./sessions.md#子-agent-会话)。

### `[compaction]` 上下文压缩

| 字段 | 默认 | 范围 | 说明 |
|------|------|------|------|
| `trigger_ratio` | 0.85 | 0.5–0.99 | 占用达到上下文上限 × 此值即触发压缩 |
| `reserved_tokens` | 32000 | 0–500000 | 剩余窗口不足此值即触发压缩 |
| `model` | — | — | 压缩摘要专用模型，缺省用主模型。可写模型 id，也可写 `[models.<别名>]` 的别名——写别名时摘要走该别名绑定的**渠道**（端点 / 密钥 / 协议），因此能让主会话与压缩分属不同渠道 |
| `user_message_max_tokens` | 20000 | 0–200000 | 用户原话保真预算：压缩时在摘要之外单独保留的用户原始消息总量。0 = 关闭保真块，回到纯摘要行为 |
| `user_message_head_tokens` | 2000 | 0–上一项 | 保真预算中划给「最早消息」的份额，其余给最近消息 |

运行时可用 `/compact-model` 会话级切换压缩模型（覆盖 `model` 配置，不落盘，`/new` 与重启后回到配置）：
`/compact-model <别名|模型id>` 切换、`/compact-model reset` 清除覆盖、无参查询当前绑定来源与解析结果。

压缩时除了生成交接摘要，还会把被压缩掉的用户原始消息在预算内以**独立消息**形态逐条**原样**保留，排在摘要之前。
这是对「摘要转述丢失原始意图」的正面修补：摘要是模型的二手转述，措辞一旦漂移，后续回合会按错误理解继续干活。

保真消息在 storage 层有独立来源标记（`user_verbatim`），因此**能跨多轮压缩存活**：每轮压缩都重新参与预算竞争，
越旧的原话越可能在预算不足时被挤出，衰减是渐进的而非一到第二轮就全丢。它不计入会话轮次、
不会被回退编辑当成「上一条用户输入」取回；但压缩过的会话会用它派生标题（此时最早的真人输入已不在历史里）。

预算不足时的取舍：最早的消息留开头（任务定义与全局约束通常在此），最近的消息留结尾（当前意图在此），
单条超预算按方向截断并标注「本条前半/后半已截断」，其中最近段边界那条被截掉的前缀会回收到最早段
（一条大 paste 因此头尾都能保住、只丢中间）。中段整条丢弃时插一条 system-reminder 写明省略了多少 token、
内容由摘要覆盖，避免模型误以为用户从未说过；该提示每轮重新生成，不会层层累积。

纯确认语（「继续」「好的」「ok」「收到」这类整条只有确认语义的消息）不占保真预算：它们信息量为零，
除占预算外更会稀释注意力。只做整条全等匹配、不用长度阈值，因为「用方案 B」这类同样很短却载有决策的消息必须保留。

保真消息占「被压缩段」的比例超过 60% 时会自动退回纯摘要形态：这说明被压缩段本身太小、原话几乎就是全部内容，
再搬一遍等于原地搬运而非压缩。真实长会话里被压缩段以模型输出和工具结果为主，此守卫不会触发。

#### 摘要质量校验

摘要不是拿到就用。生成后要过三道检查，任一不合格即视为本次摘要失败：

1. **非空白**。
2. **信息量下限**：摘要 token 数不得低于「被压缩内容的 2%」，并封顶在 200 token。下限随压缩量上浮——压得越多，对摘要的信息量要求越高；被压缩内容本身很小时几乎不设限（一句话摘要本就够用）。下限恒被压在原文体量之下，不会出现「要求摘要比原文长」的死锁。
3. **不含历史渲染标记**：摘要里出现 `[调用工具 X]`、`[工具结果]`、`[image ...]`、`[audio ...]`、`[video ...]` 这类标记时判失败——这些标记只在喂给摘要模型的历史里出现，写回摘要说明模型在抄原文而不是写交接笔记。

不合格时丢掉最老的一条消息、缩小输入后重新生成，最多尝试 3 次。三次都不合格则**放弃本次压缩、完整保留历史**——宁可不压，也不拿一份失效摘要替换掉整段历史。摘要返回空内容、或摘要请求遇到网络与 API 错误时，走同一条「缩小输入后重试」路径。

这三道检查目前是内置行为，不开放配置。

#### 压缩何时被评估

**每次向模型发出请求之前**都会评估一次，与上一轮是什么结局无关——模型调了工具、直接给出回答、你按 Esc 中断、或是新提问开启的新一轮，都会评估。

这一点值得单独说明，因为它决定了两件事：

- 你**新提问**时若上一轮结束时占用已过线，压缩会在第一个请求发出之前完成，而不是等某一轮工具调用之后。
- 纯对话的长会话（很少调工具）同样受压缩管辖。

除此之外还有一条兜底：请求已经发出、被接口判定上下文溢出时，会做一次更激进的保命压缩再重试本轮。两条路径压缩完都会立即刷新状态栏的占用数字。

#### 压不下去时

需要保留的最近消息本身就超出预算时，压缩会「做了但没压到阈值以下」。这种情况下**不会**每轮反复重试摘要（那样只是持续花钱且不见效），而是停止本轮的自动压缩，并提示你用 `/compact` 或 `/new` 处置。

区分一种不算「压不下去」的情况：历史还太短、需要摘要的部分本就为空时，压缩无从下手，此时不触发上述停止——随着对话变长它会自然恢复正常压缩。

### `[memory]` 记忆观察池

agent 自主维护的长期观察目录：对话中出现「用户明确要求记住、用户纠正了 agent、稳定的项目约定」时，agent 会把观察写入两级 markdown 目录（全局 `~/.step-code/memory/` 与项目 `.step-code/memory/`），system 尾部注入目录说明与观察索引。观察**不直接生效**（标注为未经确认，与 AGENTS.md 等规范冲突时以规范为准），定期回顾经你确认后才晋升进规范层。

```toml
[memory]
enabled = true   # 默认 false：不注入记忆段、不建目录；已有文件原样保留，重开即恢复
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | false | 观察池开关。中途 `/memory on` 开启时，会注入一条回看引导让 agent 补沉淀本次会话的遗留观察 |

要点：

- 存储是 markdown 正文 + `<!-- MEMORY_FIELDS {...} -->` 注释字段（version / occurrences / updated_at），人可直接编辑。
- 无 embedding、无后台提取管线；更新只发生在对话回合内（agent 用文件工具自主写），索引每轮现扫目录。
- 子 agent 只读：能看到索引、不能写（避免并行写冲突与临时上下文噪声）。
- `/memory` 无参列出全部观察、索引字符用量与解析失败的文件。

### `[background]` 后台任务

四个字段全部可选，缺省按下表默认值生效。

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `bash_auto_background_on_timeout` | bool | true | 前台 bash 超时后自动转后台；`false` 为超时即杀 |
| `bash_task_timeout_s` | int | 600 | 后台任务超时秒数，clamp 到 0–86400，`0` = 不限 |
| `notify_on_complete` | bool | true | 后台任务进入终态时主动注入完成通知；`false` 则回到由模型经 `task_list` 主动查询 |
| `notify_terminal` | bool | true | 后台任务进入终态时发终端铃响与桌面通知；`false` 为静默 |

`notify_terminal` 的两层机制：BEL 铃响所有终端通用；OSC 9 桌面通知只在识别得出支持的终端里发送（iTerm2、WezTerm、Kitty、Ghostty、Windows Terminal、Warp），tmux 内自动套 DCS 透传。不支持的终端只会响铃，不报错。

非布尔值写在 bool 字段上、非数字写在 `bash_task_timeout_s` 上时，该字段视为未配置、落默认值。

### `[tui]` 终端界面

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `error_preview_lines` | int | 4 | 工具错误输出折叠态预览行数，clamp 到 1–20 |
| `terminal_title` | bool | true | 把会话标题写进终端 tab 标题（OSC 0）；`false` 为不写 |

`terminal_title` 开启时，会话的 tab 标题在新会话时为当前目录名，第一轮回答后自动换成 AI 生成的会话标题，`/resume` 切换会话、`/rename` 改名时同步更新，退出时清空。不支持的终端（非 TTY 重定向、`TERM=dumb`、CI 环境、tmux 未开启 passthrough）会自动跳过，不会污染输出；也可用环境变量 `STEP_CODE_NO_TERMINAL_TITLE=1` 强制关闭。Windows Terminal 的 profile 若设了 `suppressApplicationTitle: true`，tab 标题被终端侧锁定，程序无法修改。

### `[search]` 联网搜索

联网搜索（`web_search` 内容搜索、`web_image_search` 文搜图）是阶跃平台专属能力，与主会话用哪家模型、哪个渠道在业务上无关。默认它复用主会话渠道的 `base_url` + `api_key`——主会话走阶跃渠道时开箱即用，但主会话切到非阶跃渠道（其他厂商模型、自建网关）时，搜索请求会打到错误地址而失败。

`[search]` 段把搜索配置独立出来，三层结构：`[search]` 是通用兜底，`[search.web]` 覆盖内容搜索，`[search.image]` 覆盖文搜图。所有字段可选。

```toml
# 通用段：内容搜索与文搜图的默认 url/key
[search]
url = "https://api.stepfun.com/v1"
key = "sk-xxxxxxxx"

# 内容搜索专用段（覆盖通用段）
[search.web]
url = "https://api.stepfun.com/v1"
key = "sk-xxxxxxxx"

# 文搜图专用段（文搜图仅 Step Plan 通道提供，建议显式配置）
[search.image]
url = "https://api.stepfun.com/step_plan/v1"
key = "sp-xxxxxxxx"
```

| 字段 | 说明 | 兜底 |
|------|------|------|
| `[search].url` / `.key` | 两个搜索工具默认的 Base URL 与 key | 空 |
| `[search.web].url` / `.key` | 内容搜索专用，覆盖通用段 | 回退 `[search]` |
| `[search.image].url` / `.key` | 文搜图专用，覆盖通用段 | 回退 `[search]` |

**endpoint 解析优先级**：专用段（`[search.web]`/`[search.image]`）→ 通用段（`[search]`）→ 主会话渠道。独立配置的 `url` 视为精确意图，只在末尾拼 `/search` 或 `/search-image`，不做 `/v1` 裁剪；只有回退到主会话渠道时才沿用旧的归一化（去 `/v1` 后拼 `/step_plan/v1/...`）。独立配置只给 `url` 没给 `key` 时，`key` 回退主会话渠道的 `api_key`。

**api 与 plan 两条通道**：阶跃的联网内容搜索同时支持标准 API 通道（`https://api.stepfun.com/v1/search`，按量付费）与 Step Plan 通道（`https://api.stepfun.com/step_plan/v1/search`，消耗订阅 Credit），同一 API key 两通道均可用；文搜图仅 Step Plan 通道提供（`.../step_plan/v1/search-image`）。有 Step Plan 订阅时建议 `[search].url` 统一配 plan 通道地址。

配了 `[search]` 后改动即改即生效（`/reload` 热重载），主会话用什么模型渠道都不再影响搜索可用性。

### `[tools.web]` 网页结果缓存

`web_search`（内容搜索）与 `web_fetch`（正文提取）共享一个进程级缓存，避免同一 URL 重复抓取。
`[tools.web]` 控制缓存容量，三个维度任一传 `0` 表示该维度不限制。

```toml
[tools.web]
max_size = 100          # 条目数上限，默认 100
max_bytes = 33_554_432  # 总字节上限（估算值），默认 32MB（32 * 1024 * 1024）
max_entry_bytes = 2_097_152  # 单条字节上限（估算值），默认 2MB；超限则整条不入缓存
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `max_size` | `100` | 缓存条目数上限。`0` = 不限制条目数 |
| `max_bytes` | `33554432`（32MB） | 缓存总字节上限（V8 堆估算值，非 UTF-8 字节）。`0` = 不限制总字节 |
| `max_entry_bytes` | `2097152`（2MB） | 单条内容字节上限；超过则整条不入缓存（大页面缓存收益低、内存代价高）。`0` = 不限制单条 |

字节按 `字符串长度 × 2` 估算（V8 对含非 Latin1 字符的串用 2 字节/字符）。
未配置 `[tools.web]` 时使用内置默认值，无需手改。

长会话或大量子 agent 并行抓网页时，可按内存预算调小 `max_bytes`；抓取大页面为主时调大 `max_entry_bytes`。

## `[[hooks]]` 生命周期钩子

在生命周期事件点执行你的 shell 命令，可观察、可阻断。用 `[[hooks]]` 数组声明，每条四字段：

```toml
[[hooks]]
event = "PreToolUse"                        # 事件名
matcher = "^bash$"                           # 可选正则，匹配工具名/事件标识
command = "python ~/.step-code/hooks/guard.py"
timeout = 30                                 # 秒，可选，默认 30，硬顶 600
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `event` | 是 | 事件名：`PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` / `SessionStart`；不在此集合内的事件名该条无效 |
| `matcher` | 否 | 正则，匹配工具名或事件相关标识；缺省匹配全部。非法正则该条无效 |
| `command` | 是 | 要执行的 shell 命令 |
| `timeout` | 否 | 超时秒数，默认 30，clamp 到 1–600 |

校验按条独立：某一条的 `event` 非法、`command` 缺失或为空串、`matcher` 编译不过时，只跳过该条，其余 hook 照常加载。

只支持用户级全局配置（`~/.step-code/config.toml`），不做项目级——配置文件位置即信任边界。事件语义、阻断规则、stdin/exit 约定见 [hooks 机制](./hooks.md)。

## 环境变量一览

| 变量 | 说明 |
|------|------|
| `STEP_CODE_API_KEY` | API key，隐式渠道只认这个变量 |
| `STEP_CODE_NO_TERMINAL_TITLE` | 设为 `1` 时不写终端 tab 标题（同 `[tui] terminal_title = false`，不改 config 也能立刻关掉） |
| `ANTHROPIC_API_KEY` | 渠道/provider 类型为 `anthropic` 时的惯例 key 变量 |
| `OPENAI_API_KEY` | 渠道/provider 类型为 `openai` / `openai_responses` 时的惯例 key 变量 |
| `STEP_CODE_PROVIDER` | 服务商，优先级高于 config.toml、低于 `--provider` |
| `STEP_CODE_BASE_URL` | API 地址，优先级高于 config.toml |
| `STEP_CODE_MODEL` | 模型名或 `[models]` 别名，优先级高于 config.toml、低于 `--model` |
| `STEP_CODE_DEBUG` | 设为 `1` 把运行日志级别从 info 放宽到 debug（日志写 `~/.step-code/logs/step-code.log`；`-p` 非交互模式下 debug 日志同时进 stderr） |
| `STEP_SHELL_PATH` | Windows 专用：`bash` 工具的解释器绝对路径，用于 Git Bash 装在非标准路径的情况，优先于自动探测 |
| `STEP_DEBUG_RENDER` | 设为 `1` 开启动态帧渲染预算诊断：触发降级（`DEGRADED`）或帧高触线（`DANGER`）时追加写 `%TEMP%/step-code-render-debug.log`，用于排查渲染/滚动问题 |

`api_key_env` 指向的变量名由你自定义，不在此表内。上表中的 key 类变量空串等同未设置。

## 数据目录

`~/.step-code/` 下的内容：

| 路径 | 内容 |
|------|------|
| `config.toml` | 主配置 |
| `mcp.json` | 外部 MCP server 声明，见[技能、插件与 MCP](./skills-and-mcp.md) |
| `AGENTS.md` | 用户级规范；同目录的 `AGENTS.override.md` 优先，见 [AGENTS.md 机制](./agents-md.md) |
| `skills/` | 用户级技能 |
| `agents/` | 用户级自定义子 agent（`*.md`） |
| `plugins/` | 插件目录，见[技能、插件与 MCP](./skills-and-mcp.md) |
| `plugins.json` | 插件启停状态（记录 disabled 集合） |
| `hooks/` | 惯例上存放 `[[hooks]]` 引用的脚本（非强制） |
| `logs/step-code.log` | 运行日志（诊断通道），超 5MB 在启动时轮转为 `.log.old`；写入前做脱敏 |
| `sessions/<工作目录键>/` | 会话快照 `<id>.json` 与全量历史 `<id>.full.jsonl`，按工作目录分桶 |
| `sessions/<工作目录键>/subagents/` | 子 agent 会话快照、全量日志与运行期活跃锁（`.lock`），独立于主会话桶，见[会话管理](./sessions.md#子-agent-会话) |
| `sessions/<工作目录键>/attachments/` | 图片附件按内容寻址落盘（文件名为 sha256），会话里只留引用指针 |
| `sessions/cron/<工作目录键>/` | 定时任务持久化，按工作目录分桶、每任务一 JSON，见[子 agent 与自动化](./agents.md) |
| `input-history/` | 输入历史，按工作目录隔离 |
| `debug-<会话 id>-<时间戳>.zip` | `/export-debug-zip` 导出的调试包（脱敏后的会话、配置、日志与环境元数据） |

## 校验：`step doctor config`

配置写坏时的诊断出口，无头运行、不进 TUI、不改任何文件：

```bash
step doctor config              # 校验 ~/.step-code/config.toml
step doctor config ./my.toml    # 校验指定路径
```

`path` 缺省为 `~/.step-code/config.toml`。它跑在 `loadConfig` **之前**，所以配置坏到起不了进程时校验器本身仍然能用。退出码只有两个：**0** 表示解析与校验通过（有警告也是 0），**1** 表示失败。

四类失败（退出码 1，报 `error:` 并立即返回）：

| 失败 | 说明 |
|------|------|
| 文件不存在 | 报出查找的绝对路径 |
| TOML 语法错误 | 带上解析器的原始报错 |
| 顶层不是 TOML 表 | 文件根是数组或标量 |
| 语义错误 | `thinking`（budget 余量、`default_level` 是否命中档位表）、`permission_mode` 非法值、`proxy` 形态非法——这三项与 `loadConfig` 共用抛错路径，属安全/正确性相关，不降级为警告 |

三类警告（退出码仍为 0，逐条列在 `ok:` 行之后）：

| 警告 | 说明 |
|------|------|
| 未知顶层键 | `loadConfig` 会静默忽略它，多半是拼写错误 |
| `[providers.<id>]` 的 `type` 缺失或非法 | 该渠道会被整条忽略 |
| `[[hooks]]` 某条的 `event` 缺失或非法 | 该条 hook 会被忽略 |

**拼错的顶层键只有 doctor 能发现**：`loadConfig` 对不认识的顶层键一律静默忽略，把 `permission_mode` 敲成 `permision_mode` 不会报错、也不会生效，配置看着写了却毫无作用。这类问题跑一次 `step doctor config` 即可暴露。

## 启动自检

`step` 启动时会自动校验 `~/.step-code/config.toml`，**不需要你主动跑 `step doctor config`**。正常配置下零输出；有问题时按严重级分流：

| 级别 | 覆盖 | 行为 |
|------|------|------|
| **致命** | TOML 语法错误、顶层不是表 | 报错 + `exit 1`，并给出修复指引（`step doctor config` 校验 / `STEP_CODE_IGNORE_BAD_CONFIG=1` 忽略坏配置以默认配置启动） |
| **警告** | 未知顶层键、渠道 `type` 非法、别名引用不可用渠道、`hooks` 非法条目 | 提示，不阻塞启动 |

**为什么必须有逃生舱**：配置文件在 home 目录，而用户常用 step-code 自己修改它（内置 `update-config` skill 就是干这个的）。若语法错误一律 `exit`，就出现「起不来 → 无法用 step-code 修 step-code 的配置」的死锁。`STEP_CODE_IGNORE_BAD_CONFIG=1` 时整份配置不生效，但会在界面上持续告知（不能悄悄用默认配置跑）。

**别名引用检查**覆盖三种成因（`step doctor config` 与启动自检共用同一份规则）：

| 成因 | 示例 | 后果 |
|------|------|------|
| 引用未声明的渠道 id | `[models.k3] provider = "ch-typo"`（`[providers]` 里没有 `ch-typo`） | 别名整体失效，退回顶层渠道发送裸模型名 |
| 引用协议预设名 | `[models.k3] provider = "anthropic"`（没声明 `[providers.anthropic]`） | 别名整体失效，需先声明 `[providers.anthropic]` 再引用 |
| 引用被忽略的渠道 | `[models.k3] provider = "ch1"`（`[providers.ch1]` 的 `type` 非法） | 别名连带失效，该修的是渠道不是别名 |

**警告的呈现通道**按运行模式分流：交互 TUI 走转录区 note（TUI 独占终端，不写 stderr/stdout），非交互（`-p` / `--output-format stream-json`）走 stderr（stdout 是协议通道，不污染）。

它也是内置 `update-config` skill 变更协议里「覆盖前独立校验」的那一环，以及 `/provider add`、删除渠道等写配置操作的写后校验入口（校验失败即回滚）。

