import type { SkillDefinition } from '../registry.js';

/**
 * 内置 skill「update-config」：step-code 对自身配置体系的一手知识（自包含，零联网）。
 *
 * 设计决策：skill 正文内嵌在本文件（模板字符串），不读外部 .md——tsc 构建不拷贝
 * 非 TS 资源，npm 分发的 dist/ 里不会有 .md 文件，内嵌字符串保证任何分发形态
 * （tsc dist / esbuild 单文件 bundle / SEA 可执行文件）下内容都可用。
 *
 * schema 参考表的事实源是 src/config/config.ts 的解析逻辑（TomlConfigShape +
 * 各 resolve* 函数的键与 clamp 边界）。新增/修改配置键时必须同步本表，
 * tests/skill/updateConfigDrift.test.ts 会逐键比对、不同步即变红。
 *
 * 正文内不使用反引号与 ${ 序列：反引号会与外层模板字符串冲突，$ARGUMENTS/$0-$9
 * 会被 expandSkillContent 当占位符展开。代码标记用「」或直接裸写。
 */
const UPDATE_CONFIG_BODY = `# update-config：step-code 自身配置的查询与变更

当用户问到 step-code 自己的配置（某个键是什么意思、当前配了多少、怎么改、改完怎么生效）时，
以本 skill 为唯一事实源直接回答，不要联网搜索，不要凭记忆猜键名。

## 一、配置根定位

- 配置根目录：用户主目录下的 .step-code/（Windows 即 C:\\Users\\<用户名>\\.step-code\\，macOS/Linux 即 ~/.step-code/）。没有环境变量可以覆盖这个根路径，它是固定的。
- 主配置文件：配置根下的 config.toml（TOML 格式）。
- 同目录其他内容：sessions/（会话存档）、skills/（用户级技能）、mcp.json（MCP server 配置）、AGENTS.md（个人指令）。
- 项目级目录：<cwd>/.step-code/（项目级 skills、AGENTS.md、agents 子 agent 定义），不进 config.toml。
- 环境变量只覆盖单个配置值，不改配置根位置；启动时还会读 <cwd>/.env 填充尚未设置的环境变量。

## 二、config.toml schema 参考表

优先级总规则：命令行参数 > 环境变量 > config.toml > provider 预设 > 内置默认。

### 顶层键

| 键 | 类型 | 默认值 | 说明与约束 |
|---|---|---|---|
| provider | string | "stepfun" | 服务商标识，决定预设与协议分发。内置预设：stepfun / anthropic / openai / openai_responses。未知值由 provider 工厂报错 |
| base_url | string | 按 provider 预设 | API 端点。anthropic 协议不带 /v1（SDK 自拼）；openai / openai_responses 协议带 /v1 |
| model | string | 按 provider 预设（stepfun 系为 step-3.7-flash） | 模型 id 或 [models.<别名>] 的别名；写别名会继承该别名绑定的渠道与窗口参数 |
| max_context_size | number | 262144 | 模型上下文上限（token），压缩判定基准。更大窗口的模型必须显式声明 |
| max_tokens | number | 65536 | 单次响应最大输出 token。启用 thinking 时需满足 max_tokens - budget ≥ 2048 |
| language | string | "zh" | 界面语言，仅 "zh" / "en" 合法，其他值按 "zh"。只影响给人看的文案 |
| permission_mode | string | "manual" | 权限模式默认值，仅 "manual" / "auto" / "yolo" 合法，其他值 loadConfig 报错。优先级：命令行 --yolo/--auto > 本键 > 恢复会话存储的模式 > "manual"。运行态 /permission、/yolo 切换不回写本键 |
| proxy | string | 无（直连） | 代理 URL（http:// 或 https:// 开头，其他值 loadConfig 报错）。生效优先级：环境变量 HTTPS_PROXY > 本键 > 直连。全局请求经 Node 内置代理机制生效；NO_PROXY 可排除指定域名。只在启动时读取，/reload 改本键需重启生效 |
| agents_paths | string[] | 无 | AGENTS.md 自定义加载路径，配置后完全覆盖默认收集。支持 ~ 与相对 cwd 路径 |
| agents_md_max_bytes | number | 32768 | AGENTS.md 总字节预算；0 或负数 = 禁用加载 |
| extra_skill_dirs | string[] | 无 | 追加的 skill 扫描目录，同名 skill 追加目录胜出 |
| disabled_skills | string[] | 无 | 按名排除的 skill 清单，任何来源的同名 skill 都不加载 |

顶层没有 api_key 键。密钥只能配在 [providers.<id>] 渠道或 [models.<别名>] 上，或由环境变量提供
（STEP_CODE_API_KEY，或按 provider 类型的惯例变量：stepfun→STEPFUN_API_KEY、anthropic→ANTHROPIC_API_KEY、
openai/openai_responses→OPENAI_API_KEY）。其他环境变量覆盖：STEP_CODE_PROVIDER、STEP_CODE_MODEL、
STEP_CODE_BASE_URL。

### [subagent] 子 agent 限制

| 键 | 类型 | 默认值 | clamp | 说明 |
|---|---|---|---|---|
| max_per_session | number | 10 | [1, 50] | 单会话累计最多派生的子 agent 数 |
| max_depth | number | 1 | [1, 3] | 嵌套深度上限（父=0），硬顶 3 防 fork-bomb |
| max_steps | number | 100 | [1, 1000] | 每个子 agent 内部最大往返轮数全局默认 |
| max_concurrent | number | 4 | [1, 16] | 并行子 agent 并发上限 |

### [subagent.retention] 子会话留存策略

| 键 | 类型 | 默认值 | clamp | 说明 |
|---|---|---|---|---|
| delete_with_parent | boolean | true | — | 删主会话时连带删其子会话（持活跃锁的跳过） |
| max_sessions | number | 0（不限） | [0, 100000] | 子会话数量上限，超出按 updatedAt 删最旧 |
| ttl_days | number | 0（不过期） | [0, 36500] | 子会话过期天数，0 关闭 |

### [compaction] 上下文压缩

| 键 | 类型 | 默认值 | clamp | 说明 |
|---|---|---|---|---|
| trigger_ratio | number | 0.85 | [0.5, 0.99] | 占用达 max_context_size × 此值即触发压缩 |
| reserved_tokens | number | 32000 | [0, 500000] | 剩余窗口不足此值即压缩（安全垫） |
| model | string | 无（用主会话模型） | — | 压缩摘要专用模型 |
| user_message_max_tokens | number | 20000 | [0, 200000] | 用户原话保真预算；0 = 关闭保真块 |
| user_message_head_tokens | number | 2000 | [0, user_message_max_tokens] | 保真预算中划给最早消息的份额 |

### [background] 后台执行

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| bash_auto_background_on_timeout | boolean | true | bash 前台超时后自动转后台；false = 超时即杀 |
| bash_task_timeout_s | number | 600 | 后台任务超时秒数，clamp [0, 86400]，0 = 不限 |
| notify_on_complete | boolean | true | 后台任务终态时主动注入完成通知 |
| notify_terminal | boolean | true | 后台任务终态时发终端铃响/桌面通知 |

### [thinking] 推理过程

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| enabled | boolean | false | 是否主动发送 thinking 请求字段 |
| budget_tokens | number | 无 | 思考预算，clamp ≥1024；启用时须满足 max_tokens - budget ≥ 2048，否则 loadConfig 报错 |
| default_level | string | 无 | 默认档位名，必须命中 levels 内的档位，否则 loadConfig 报错 |
| [thinking.levels] | table | 内置 low=1024 / medium=4096 / high=32000 | 档位名 → budget（每档 clamp ≥1024），整体覆盖内置表 |

### [models.<别名>] 模型别名表（渠道与模型分离）

| 键 | 类型 | 说明 |
|---|---|---|
| provider | string | 渠道 id（[providers.<id>]）或内置预设名；缺省继承顶层 provider。指向不存在的渠道且非预设 = 别名无效 |
| model | string | 真实模型 id；缺省 = 别名本身 |
| base_url | string | 缺省走渠道 → 顶层回落链 |
| api_key | string | 直配密钥（注意落盘风险，优先 api_key_env） |
| api_key_env | string | 只存环境变量名，密钥不落盘，解析时读该环境变量 |
| max_context_size | number | 覆盖顶层 |
| max_tokens | number | 覆盖顶层 |
| display_name | string | 选择器与状态栏展示名 |
| capabilities | string[] | 能力标记（如 thinking / image_in），原样透传给多模态门控 |

### [providers.<id>] 渠道表

| 键 | 类型 | 说明 |
|---|---|---|
| type | string | 必填，必须是内置预设协议 key（stepfun / anthropic / openai / openai_responses），非法则该渠道整条无效 |
| base_url | string | 渠道端点 |
| api_key | string | 渠道密钥 |
| api_key_env | string | 环境变量名间接引用 |

## 二·五、渠道与模型速查（当前全景）

内置预设 stepfun 走 Anthropic Messages 协议（base_url 不带 /v1）；openai / openai_responses 走
Chat Completions / Responses（base_url 带 /v1）。当前已验证的渠道形态：

- stepfun（anthropic，api.stepfun.com）：部分模型只开放 Messages API，走 Chat Completions 通道
  调用会返回 400（提示 not enabled for the Chat Completions API），此类模型必须配 anthropic 渠道。
- stepfun-plan（openai，api.stepfun.com/step_plan/v1）：Step Plan 的 Chat Completions 通道。
- 第三方 OpenAI 兼容后端可以直接按 [providers.<id>] type = openai 接入（已实测可用）。
  OpenAI 协议渠道自报 User-Agent（step-code/版本），不伪装其他客户端。
- image_in 能力声明后，read_media 才会出现在工具表（按 capabilities 门控）；改完 capabilities
  用 /reload 即生效，不必切模型。注意：tool_result 内嵌图片目前仅 Anthropic 协议渠道端到端有效，
  openai 协议渠道声明了 image_in 也会丢图（协议翻译缺口，已登记）。

apiKey 回落链（渠道分支）：渠道 api_key → 渠道 api_key_env → 渠道 type 惯例环境变量 → 别名 api_key →
别名 api_key_env → 顶层环境变量解析结果。跨服务商混用时务必给每个渠道单独配密钥。

### [[hooks]] 用户 hooks（扁平数组，可多条）

| 键 | 类型 | 说明 |
|---|---|---|
| event | string | 必填，合法值：PreToolUse / PostToolUse / UserPromptSubmit / Stop / SessionStart |
| command | string | 必填，要执行的 shell 命令（stdin 收 JSON；exit 0 放行、exit 2 阻断、其余 fail-open） |
| matcher | string | 可选正则，匹配工具名/事件标识；非法正则整条跳过 |
| timeout | number | 秒，默认 30，clamp [1, 600] |

### 最小示例

    provider = "stepfun"
    model = "step-3.7-flash"
    max_context_size = 262144
    language = "zh"

    [thinking]
    enabled = true
    budget_tokens = 4096

    [providers.anthropic]
    type = "anthropic"
    api_key_env = "ANTHROPIC_API_KEY"

    [models.claude]
    provider = "anthropic"
    model = "claude-sonnet-4-5"
    max_context_size = 200000

## 三、变更协议（代用户改配置时必须按此执行）

1. 澄清意图：确认用户要改哪个键、改成什么值。键名先查上面第二节的表，猜不到就问。
2. 改前 Read 原 config.toml 全文。若内容无法解析（TOML 语法已坏），报告现状并停止，绝不覆盖坏文件。
3. 用 cp 复制出候选副本 config.toml-new，只对副本做 Edit，只动目标键，不原地改、不整体重写、不动无关条目与注释。
4. 校验副本：执行 step doctor config <副本路径>，退出码非 0 就把错误报给用户并停止，不进入覆盖步骤。
5. 备份原文件为 config.toml.bak-<yyyyMMdd-HHmmss>（时间戳命名，保留全部历史，绝不覆盖旧备份）。
6. 用 mv 把校验通过的副本覆盖为 config.toml。
7. 告知用户生效方式：TUI 内执行 /reload 热生效，或下个会话自动生效。

只解释配置（当前值、含义）时走只读路径：Read config.toml 直接回答，不触发变更协议。

## 四、能力三分

- 解释配置：只读不改。用第二节的表解释含义，Read 文件报当前值。
- 代用户改：严格走第三节协议（副本 → 校验 → 备份 → 覆盖）。
- 生效方式：/reload 热生效或重启会话；saveDefaultModel/saveLanguage 这类由 /model、/language 命令自动写回的键除外。

## 五、Don'ts

- 不猜键名：先查第二节内嵌表，表里没有的键不存在（如顶层 api_key、default_yolo 都是臆造键）。
- 不丢无关条目：只动目标键，其余字段、注释、section 原样保留。
- 备份不覆盖旧备份：永远用新时间戳。
- 校验不过不覆盖：step doctor config 退出码非 0 时停止并报告。
- 密钥优先 api_key_env 间接引用，避免明文落盘；用户坚持明文时提醒风险后照做。
`;

/**
 * 内置 skill 定义。dir 用伪路径 builtin:// 前缀：builtin skill 没有文件系统目录，
 * ${STEP_SKILL_DIR} 展开成伪路径可接受（本 skill 正文不引用同目录资源）。
 */
export const UPDATE_CONFIG_SKILL: SkillDefinition = {
  name: 'update-config',
  description:
    '查询或修改 step-code 自身配置（~/.step-code/config.toml）。内嵌完整 schema 参考表与变更协议（副本编辑 → doctor 校验 → 时间戳备份 → 覆盖 → /reload）。当用户问配置键含义、当前配置值、改模型/渠道/thinking/语言等自身配置时使用。',
  content: UPDATE_CONFIG_BODY,
  dir: 'builtin://update-config',
  source: 'builtin',
};
