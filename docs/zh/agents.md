# 子 agent 与自动化

本页讲让模型替你并行、定时、持续推进工作的四类机制：子 agent、工作流、自主目标、定时任务，以及配套的后台任务管理。

## 子 agent（spawn_agent）

模型可以派生子 agent：全新上下文、角色化工具白名单、完成后只把摘要回灌主会话。适合"交给它独立搞定一件事，别弄脏主对话"的场景。

- **内置两类**：`general`（工具全集，可读写、可执行命令）、`explore`（只读调查，工具白名单为 `read_file`/`read_media`/`list_dir`/`glob`/`grep`/`web_search`/`web_fetch`/`web_image_search`/`skill`）
- **自定义**：在 `.step-code/agents/<名称>.md`（项目级）或 `~/.step-code/agents/<名称>.md`（用户级）写 agent 定义
- **优先级**：内置 < 用户级 < 项目级，同名后者覆盖
- **护栏**：单会话派生上限、嵌套深度上限、单 agent 轮数上限、并行并发上限，都可在 `[subagent]` 段配置（见[配置参考](./configuration.md)）

你不需要手动调用——描述任务时说明"派子 agent 并行调查这几个方向"即可，模型会自己决定。

### `spawn_agent` 工具参数

| 参数 | 说明 |
|------|------|
| `prompt` | 完整任务描述。子 agent 看不到主对话历史，背景要写全 |
| `subagent_type` | 子 agent 类型，省略默认 `general` |
| `description` | 子任务简述（3-5 词），用于 TUI 单行展示；省略则截断 `prompt` 顶上 |
| `run_in_background` | `true` 则后台异步派生，立即返回 `task_id`，用 `task_output` 取结果 |
| `resume` | 子会话 id：从历史断点续跑该子会话，`prompt` 作为新指令追加进已有历史（不新建会话、不占派生配额）；目标子会话正在运行时会被拒绝 |

子 agent 的返回串会带上子会话 id——需要它在已有工作基础上继续时，把这个 id 传给 `resume` 即可。子 agent 完成后返回的摘要若短于 200 字符，会被追加一轮要求展开（最多一次），避免"干了很多但只回一句"。子 agent 的过程历史完整落盘：出错或想追查细节时用 `step subagents show <id>` 完整回看，或在交互界面用 `/agents` 命令下钻（列出当前会话派生的子 agent，见[会话管理](./sessions.md#子-agent-会话)）。

### 自定义 agent 定义格式

子 agent 定义可以放在两处：项目级 `<cwd>/.step-code/agents/<名称>.md`、用户级 `~/.step-code/agents/<名称>.md`。加载优先级为 **内置 < 用户级 < 项目级**，同名定义后者**完整覆盖**前者，不是字段合并。因此，如果你在项目里写了 `explore.md`，内置的 `explore` 就会被它完全替换。

YAML frontmatter + 正文，正文即该 agent 的 system prompt：

```markdown
---
name: reviewer            # 可选，缺省用文件名
description: 代码审查专用 agent，只读，输出问题清单
tools: [read_file, grep, glob]   # 可选，缺省 = 工具全集
model: step35             # 可选，缺省继承主会话模型
maxSteps: 40              # 可选，缺省用 [subagent].max_steps
---

你是代码审查子 agent，只读代码不改代码……
```

| frontmatter 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 否 | 注册名；缺省取文件名（去 `.md`） |
| `description` | **是** | 缺失则该文件被跳过；这段描述会进工具说明供模型选型 |
| `tools` | 否 | 工具白名单（数组）；缺省 = 工具全集 |
| `model` | 否 | 该 agent 专用模型，可填别名名（如 `step35`）或真实模型 id。别名对应 `[models.<别名>]` 配置块（推荐用别名）；缺省继承主会话模型 |
| `maxSteps` | 否 | 该 agent 的内部轮数上限，覆盖全局默认 |

正文（system prompt）短于 20 个字符时该文件同样被跳过——这道校验让目录里放的普通 Markdown 不会被误当作 agent 定义。文件解析失败也只是跳过，不影响启动。

### 给子 agent 指定模型

子 agent 默认与主会话同模型。`model` 字段是唯一的模型指定入口，没有"次级模型"这类全局降档开关——要哪个角色用哪个模型，就在该角色的定义里写明。

`model` 的取值可以是别名名（如 `step35-plan`），也可以是真实模型 id。**推荐写别名**：别名承载「渠道 + 模型 id + 上下文窗口 + 显示名」一整组绑定。写真实 id 时，子 agent 会沿用父会话的 provider（不能跨渠道），`max_context_size` 会回落到顶层默认值，压缩时机随之失准；如果多个渠道有同名真实 id，还会因无法指定渠道而走错模型。

典型用途是给只读探索类任务降档——检索、定位、汇总这类工作对推理深度要求不高，用轻量模型足够，还更快更省。有两种做法：

**一是新建一个轻量角色**，内置 `explore` 不受影响，派生时显式选类型。写 `.step-code/agents/explore-fast.md`：

```markdown
---
name: explore-fast
description: 轻量只读探索子 agent，适合不需要强推理的检索/汇总任务
tools: [read_file, read_media, list_dir, glob, grep, web_search, web_fetch, web_image_search, skill]
model: step35
---

你是只读探索子 agent，任务是用最小成本完成检索和资料汇总。不能修改文件或执行命令。
你看不到主 agent 的对话历史，所有必要背景都在给你的任务描述里。
```

**二是覆盖内置 `explore`**，所有探索任务自动走轻量模型。同名定义是**完整覆盖而非字段合并**，所以 `description`、`tools`、正文都得自己带全——只写一个 `model` 字段会因缺 `description`（或正文过短）被直接跳过，覆盖静默失效。代价是内置 `explore` 的 system prompt 后续升级不会同步到你的文件里，需要自己维护。

两种做法的取舍：想要"所有探索都降档"选覆盖，想要"按任务挑轻重"选新建角色。前者省心，后者保留选择权且无维护负担。

自定义角色名会自动出现在主 agent 的 system prompt 里，模型派生时可以直接引用；如果没有自定义角色，则只保留内置 `general` 和 `explore`。

> **恢复旧会话时的模型回退**：如果恢复 `--resume`/`-r` 或 `/resume` 的会话发现其存储的 `model` 已不在当前配置中（例如别名被删除或重命名），会话会自动回退到当前 `config.model`，不会卡死启动。

### 递归防护

子 agent 派生子 agent 的 fork-bomb 风险有两道独立防线：

1. **结构性剔除**：子 agent 的工具集在 `depth + 1` 已达 `max_depth` 时强制剔除 `spawn_agent`，同时不给它注入派生能力——它拿不到这个工具，也就无从调用。
2. **深度硬上限**：即便绕过第一道，运行时仍按 `ToolContext.depth` 校验，超限直接返回错误摘要并提示"请自己完成该任务"。

配额计数也有讲究：深度超限、类型不存在这两类非法请求**不占**单会话派生配额，只有合法派生才计入。`max_depth` 的配置上限硬封在 3，配置文件无法突破。

### 并行执行

模型一轮可以返回多个工具调用，step-code 按**资源冲突**决定谁能并行：每个工具声明自己的访问面（无副作用 / 读某路径 / 写某路径 / 全局独占），互不冲突的并行跑、冲突的串行跑，结果始终按调用顺序回灌。

`spawn_agent` 的访问面按类型区分：`explore` 声明无副作用（可并行），`general` 声明全局独占（自然串行）。所以多个 explore 子 agent、多次只读的 read/grep 会并行；`general` 子 agent、写文件、`bash` 这类会串行。

并行子 agent 额外受 `[subagent].max_concurrent`（默认 4）的并发上限约束——超出的排队等空槽。子 agent 因限流（429）失败时不白占槽位，会退回队尾延迟重试，TUI 会提示重排队次数。授权确认始终串行进行（多个审批不会交错弹出）。这些都由模型自动处理，你不需要显式控制。

## 编排能力

比单个子 agent 更强的编排：现在有两种方式，详见 [JS 动态工作流（`dynamic_workflow`）](#js-动态工作流dynamic_workflow)与 [子 agent（`spawn_agent`）](#子-agentspawn_agent)。

## JS 动态工作流（dynamic_workflow）

`dynamic_workflow` 工具让模型现写一段 JavaScript 编排脚本，在 quickjs 沙箱中执行。结构化任务可直接套用 `dynamic_workflow` 原语，一次性探索编排则靠脚本自由组合。

脚本世界是零能力的：文件、网络、进程、环境变量在里面根本不存在，能用的只有下面注入的原语。控制流不做原语——`if` / `for` / `.map` / 提前 `return` 直接写原生 JS，这是走脚本路线换来的表达力。

脚本内可用的原语：

| 原语 | 说明 |
|------|------|
| `agent(prompt, opts?)` | 派一个子 agent，返回 Promise。终态失败返回 `null` 而不抛错。`opts` 支持 `subagentType`、`description`、`schema`、`phase` |
| `parallel(thunks)` | 并发 barrier：传一组返回 Promise 的**函数**（`[() => agent(...), ...]`），一次并发跑完再汇总。**永不 reject**——失败位置补 `null`，单个失败不拖垮整批 |
| `pipeline(items, ...stages)` | 每项串行过各 stage（`pipeline(items, s1, s2)`）。某项某 stage 失败则该项掉为 `null` 并跳过后续 stage，其他项不受影响 |
| `phase(title)` | 标记执行阶段（展示层语义，不影响执行） |
| `budget({agents, minutes})` | 收紧本次运行的预算，**只能收紧不能放松**；耗尽后 `agent()` 抛错 |
| `args` | 调用时传入的 `args` 对象，在沙箱内以全局 `args` 访问 |
| `console.log` | 限额日志，不进主上下文，只在最终报告里附带 |

**fan-out 必须走 `parallel`，不要用裸 `Promise.all`**：`Promise.all` 一处 reject 就炸掉整批，「单个失败不拖垮整批」这个保证只有 `parallel` 给得起。同理，多个无依赖的 `agent()` 不要顺序逐个 `await`——那会慢 N 倍。

```js
// 无依赖任务并发扇出，再汇总
const rs = await parallel([() => agent('调查X'), () => agent('调查Y'), () => agent('调查Z')]);
return '综合：' + rs.filter(Boolean).join('；');
```

因为失败位是 `null`，**汇总前必须 `.filter(Boolean)` 或逐项判空**，否则 `null` 会混进结果里。

### 结构化输出（`agent` 的 `schema`）

`schema` 是 `agent(prompt, { schema })` 的 **opts 字段**，不是工具调用参数——它约束的是**单次 agent 调用**的返回，不是脚本最终的报告。给了 `schema`（一个 JSON Schema 对象）后：prompt 自动追加输出契约，返回值按 JSON 解析并用 ajv 校验；不匹配则带着校验错误让子 agent 纠正重试，**最多 2 次**；成功返回解析后的**对象**（不是字符串，下游可直接取字段），仍失败返回 `null`。

```js
const S = { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] };
const rs = (await parallel(items.map((it) => () => agent('调研:' + it, { schema: S })))).filter(Boolean);
return rs.map((r) => r.topic).join('\n');
```

`schema` 本身不是合法 JSON Schema 时会抛错（脚本 bug，不吞成 `null`）。

### 阶段标记的现状

`phase(title)` 与 `agent(..., { phase })` 会发出阶段事件，但**当前没有消费方**——事件通道已通，TUI 侧的分阶段展示留待后续实现。所以现在给 `phase` 的实际收益只是进日志缓冲、在最终报告里可见，不要指望界面上出现分组面板。并行时用 `agent(..., { phase })` 给单个 agent 标阶段，不要为了标阶段而把并发拆成顺序执行。

### 确定性禁令

为保证 resume 时缓存前缀能对齐，沙箱封禁四类非确定性 API：

| 封禁 | 说明 |
|------|------|
| `Date()` 调用形式 | 忽略参数、永远返回当前时间字符串 |
| 无参 `new Date()` | 每次构造结果都不同 |
| `Date.now` | 同上 |
| `Math.random` | 同上 |

保留的有：带参 `new Date(timestamp)`、`Date.parse`、`Date.UTC`。**逃生口**：脚本确实需要时间时，从调用方经 `args` 传入时间戳，再用 `new Date(args.ts)` 构造。

### 工具参数

| 参数 | 说明 |
|------|------|
| `script` | JS 编排脚本（async 函数体，以 `return <报告>` 收尾）。与 `name` / `script_path` 三者给一个；同时给 `script` 与 `name` 时以 `script` 为准 |
| `name` | 按名加载 `.step-code/workflows/<name>.js` 已存脚本执行。未命中时报错并列出当前可用脚本名 |
| `save_as` | 把本次 `script` 存为命名脚本（同名覆盖更新），之后可用 `name` 复用。必须配 `script` |
| `script_path` | 从 cwd 内的文件读脚本执行；**路径越界（cwd 之外）直接拒绝**。与 `script` / `name` 同给属歧义会被拒 |
| `args` | 传给脚本的参数对象，沙箱内以全局 `args` 访问 |
| `max_agents` | agent 总数上限（护栏），默认 **100**，硬顶 **1000**；超限向脚本抛错 |
| `description` | 编排任务简述（3-5 词），用于后台任务列表展示；`save_as` 时写入脚本首行注释 |
| `run_in_background` | 后台异步执行，立即返回 `task_id`，终态自动注入通知。**v1 限制**：后台编排被 `task_stop` 时只标记 `killed`，不真正 abort 执行中的子 agent |
| `resume_from_run_id` | 指定上一次失败的 runId，预载其 journal 缓存后从头重放脚本 |

其他护栏：最终报告上限 **32KB**（超出截断）；默认 wall-clock **30 分钟**（`budget({minutes})` 只能往下收紧）；每次执行自动存档 journal 供排查。

### 失败后如何恢复

脚本跑挂时不用从头重来。失败结果里会带三样东西：已完成的子 agent 数、**journal 路径**、**脚本存档路径**（每次运行都自动存档）。据此有两条可叠加的恢复路径：

- `resume_from_run_id: "<失败的 runId>"`：预载该次的 journal 缓存后从头重放脚本——**已成功的 `agent()` 调用瞬时返回旧结果**（不重新烧 token），只有失败的和新增的才真跑。
- `script_path: "<存档路径>"`：直接编辑那个存档文件后重跑，不必把脚本全文再发一遍。

典型修法是两者叠加：编辑存档文件修掉 bug，用 `script_path` 指过去，同时带上 `resume_from_run_id` 复用已完成的部分。

脚本可命名保存复用：`save_as` 存到 `.step-code/workflows/<名字>.js`，之后用 `name` 调同名脚本，名字未命中时列出可用名。不带任何参数调用本工具则列出当前可用脚本（发现入口）。

## 自主目标（goal）

给一个目标，让模型每轮自动续跑直到达成或阻塞：

```
你：把 X 作为目标持续推进，预算 20 轮
你：/goal            # 查看目标状态面板
```

你只需用自然语言描述目标和硬限制，模型会用 `create_goal` 建目标并自驱执行。

### 模型侧工具

| 工具 | 参数 | 说明 |
|------|------|------|
| `create_goal` | `objective`、`completion_criterion?`、`replace?` | 设定目标。已有进行中目标时必须带 `replace` 才能覆盖 |
| `update_goal` | `status`、`reason?` | 状态机唯一入口，`status` 取 `active`/`paused`/`blocked`/`complete` |
| `set_goal_budget` | `turns?`、`tokens?` | 设预算，两者可单设可并设，但不能都不给 |
| `get_goal` | 无 | 读回当前目标与预算用量 |

`complete` 是瞬态：标记完成即清除目标，转录区打一条完成统计行（轮次 + 墙钟用时）。

### 轮级驱动

goal 的自动续跑不是在一次调用里循环，而是**一轮一次独立的 agent 调用**：模型本轮自报停机（`end_turn`）后，控制权回到 App 层，由它裁决是否发起下一轮、并组装下一轮的注入文本（目标提醒 + 续接提示 + 你的留言）。

这样切分的好处是每轮边界都是一个干净的检查点：预算在这里判定、你的留言在这里注入、状态在这里落盘。代价是预算判定的粒度就是"轮"——单轮内部模型可以跑很多个模型↔工具回合，这期间不查预算，所以 token 预算是**轮边界的检查点**而非轮内的硬闸门，单轮有可能超出预算才被拦下。

轮次计数只计**自动续跑的轮**：你发起的那一轮不计入。所以 `turnBudget = 20` 的实际含义是"最多自动续跑 20 轮"，加上你发起的首轮，总共会发生 21 次模型调用。

### 运行期间给它递话（steer）

goal 自主推进时你不必干等，直接打字发出去即可——这条留言**不打断当前轮**，会记进 steer 队列，在下一轮开始时随注入文本一起交给模型（提示语要求优先响应）。TUI 会回一条"已记录你的留言，将在下一个自主轮生效"。

这与"排队等 goal 跑完"是两种不同行为。走 steer 的条件是：goal 状态为 `active`、当前正忙、且你发的是纯文本（非斜杠命令、不带图片）。带图片的消息和斜杠命令走各自原有路径——`/goal`、`/loop` 这类命令在忙时也是即时生效的，所以 `/goal pause` 随时能刹住。

你按 Esc 中断当前轮时，还没被消费的 steer 留言不会丢，会转成普通排队消息继续发出。

### 预算：轮次 + token

目标支持两种硬预算，可单设也可并用：

- **轮次预算**：最多自动续跑多少轮。
- **token 预算**：累计消耗多少 token（按计费口径累计：输入扣掉缓存命中部分，加上输出）。

任一预算用到 ≥75% 时，注入的目标提醒里会追加「预算将尽，收敛收尾」的提示让模型自行收敛；任一预算用尽则在**下一轮边界**标记为 blocked、停止自动续跑。预算是 opt-in 的——只有你明确给出硬限制时模型才设置，不会自行发明。

paused / blocked 期间的 token 不计入目标账本，所以面板上的 token 数是"目标处于 active 状态时的消耗"，不等于该目标生命周期内的全部开销。

### 人工接管

`/goal` 及其子命令随时可用（忙时也即时生效）：

| 命令 | 行为 |
|------|------|
| `/goal`、`/goal status` | 显示状态面板：目标、完成标准、状态、轮次与 token 用量及预算、终止原因、墙钟用时 |
| `/goal pause` | 暂停，停止自动续跑 |
| `/goal resume` | 恢复为 active |
| `/goal cancel` | 取消并清除目标 |

`/goal resume` 只改状态，本身不发起任何一轮——恢复后目标处于"active 但无人推动"的状态，等你下一条消息（或定时任务触发）把它带起来。对已 blocked 且预算没放宽的目标，resume 之后会**先跑完一整轮**才在轮边界再次 blocked，这一轮的开销是真实发生的。命令层没有调预算的入口，放宽预算要通过自然语言让模型调 `set_goal_budget`。

状态栏有 goal 徽章（用时 · 轮次[/预算]，圆点按状态着色），设定、暂停、恢复、阻塞、完成都会在转录区打一条 marker 行。

### 持久化

目标状态随会话一起保存（会话文件的 `goal` 字段），每次状态变化和每轮结束都会落盘。`--continue` / `--resume` 恢复会话时，原本 active 的目标会**降级为 paused**（防止重启后无人看管地自动烧 token），需要你 `/goal resume` 显式复活；paused / blocked 状态原样保留。这次降级是静默的，不打提示行——留意状态栏徽章，或敲 `/goal` 确认。

`/fork` 分叉和 `/new` 新建的会话都不继承目标。

## 团队模式（/team）

把一件大事拆成多个任务，派多个子 agent 在各自独立的 git worktree（工作间）里**并行改同一个（或跨多个）代码库**，最后逐任务审阅收编。与 dynamic_workflow 的分工：workflow 管「流程事先已知」的批量任务，team 管「任务有依赖、有写冲突、要现场判断」的并行开发。

```
你：/team init
你：把数据层换成新 API，文档和测试一起更新
agent：（拆任务 M1 改数据层 / M2 改文档 / M3 改测试，声明各自文件范围与依赖）
      （M1、M2 立即并行开工；M3 依赖 M1，系统暂扣，M1 合并后自动解锁）
      （各 worker 在自己的工作间干活，互相留字条协作）
agent：M1 已完成，我审了 diff，收编进 main。M3 现在自动解锁启动……
```

### 运转规则

- **文件范围互斥**：拆活时每个写类（build）任务声明允许改的路径范围，两两重叠直接拒绝规划；只读调查（survey）任务不占位。
- **写操作硬隔离**：worker 的默认工作目录就是它自己的工作间，`write_file` / `edit_file` 写出界直接被拦（每个 worker 只放行进自己的工作间）。bash 不拦——worker 需要在工作间里 git 提交，正常工作不会出界，这是诚实边界。
- **依赖系统门控**：任务的依赖未全部合并，启动直接被系统拒绝，不靠协调者自觉。
- **合并门禁**：协调者审完 diff 才能收编——① 已审阅（传入审阅时的分支 tip）② tip 未再移动 ③ 依赖全部已合并 ④ diff 无范围外文件 ⑤ typecheck（build 任务在工作间跑 `tsc --noEmit`，非 TS 仓跳过，`--force` 可绕过本门、其余硬门不可），全过才 `--no-ff` 合回。真撞冲突会自动 `merge --abort` 把仓库救回原状并报恢复指引。
- **信箱通信**：worker 与协调者用落盘信箱协作（定向 + `all` 广播，`.teams/comms/inbox/` 下的 md 文件，可审计）。
- **中断语义**：Esc 只停协调者当前回合，后台 worker 继续跑；停 worker 用 `task_stop`。`/team exit` 退出模式但保留全部状态，`/team init` 重进接着跑。

### 命令

| 命令 | 作用 |
|------|------|
| `/team init [--dir <路径>]` | 初始化团队（要求当前目录在 git 仓内且已有提交，否则拒绝）。`--dir` 把团队档案放到仓外独立位置，配合任务级仓库归属实现跨仓协作 |
| `/team status` | 任务清单与状态（忙时也即时生效） |
| `/team exit` | 退出模式，状态全保留 |
| `/team teardown [force]` | 收尾：清理工作间（有未提交改动的默认保留，`force` 才删），档案目录保留作审计 |

### 模型侧工具

`team_init` / `team_plan` / `team_spawn` / `team_merge` / `team_teardown` 仅协调者（主 agent）可调用；`team_send` / `team_inbox` / `team_status` 协调者与 worker 均可用。状态栏在团队模式活跃时显示 `team` 徽章。

## 定时任务（cron）

到点把一段 prompt 注入会话自动执行：

```
你：每天早上 9 点检查一下这个仓库的 CI 状态
```

模型用 `cron_create` 建任务，`/loop`（别名 `/cron`）查看列表，`cron_list` / `cron_delete` 供模型自查自删。

| 工具 | 参数 | 说明 |
|------|------|------|
| `cron_create` | `cron`、`prompt`、`recurring?` | 5 字段 cron 表达式（分 时 日 月 周）；`recurring` 默认 `true`，`false` 为一次性、触发后自动删除 |
| `cron_list` | 无 | 列出 id / 表达式 / 下次触发时间 / 周期或一次性 |
| `cron_delete` | `id` | 删除一个任务 |

调度器每 10 秒 tick 一次，且带**空闲闸门**：当前回合正在跑时不触发，等下一个空闲 tick 补发。所以定时任务不会打断你正在进行的对话。

定时任务**按工作目录持久化**（不绑会话）：每个任务一份 JSON 存在会话数据目录下 `cron/<cwd 分桶>/` 里，创建、删除、每次触发推进下次时间都立即落盘（写用临时文件 + 原子替换，失败只告警不影响运行）。所以进程重启、会话恢复后任务不丢，在这个目录下的任何会话都会接管它们。

离线期间错过的触发，恢复后**合并补投一次**，不会把攒下的十几次全部重放。每次触发在转录区打一张 cron 卡片（表达式、任务 id、合并次数、prompt 正文），合并了几次漏跑看卡片即知；注入给模型的仍只是任务本身的 prompt。恢复时会做两件清理：创建超过 7 天的周期任务直接丢弃，损坏或字段不全的任务文件静默跳过——宁可丢一个坏任务也不让启动失败。

## 后台任务

`bash` 工具支持 `run_in_background`：长命令（构建、测试、服务）转后台跑，主会话继续。同一个参数在另外两个编排工具上也可用——`spawn_agent`（整个子 agent 丢后台）和 `dynamic_workflow`（整条编排丢后台），所以耗时的编排不必占着主会话干等。配套 `task_list` / `task_output` / `task_stop` 管理，状态栏有 `bg:N` 徽章显示进行中的后台任务数。

三个派生类工具的后台模式有一条共同的 **v1 限制**：`task_stop` 只把任务标记为 `killed`，不会真正 abort 已经在跑的子 agent——它们会继续跑到自己结束，只是结果不再回灌。要真正止住，只能中断整个回合。

| 工具 | 参数 | 说明 |
|------|------|------|
| `task_list` | 无 | 列出全部后台任务：id / 状态 / 命令 / 退出码 |
| `task_output` | `task_id` | 看某个任务的输出（内存保留的尾部，上限 64KB） |
| `task_stop` | `task_id` | 终止运行中的任务 |

任务状态有四种：`running` / `completed` / `failed` / `killed`。同时运行的后台任务上限 10 个，撞线时启动请求直接失败并提示先等待或停止部分任务。

界面内 `/tasks` 打开后台任务浏览器：↑↓ 或 `k`/`j` 选择、Tab 切换「全部 / 仅运行中」过滤、Enter 查看完整输出、`s` 停止运行中任务、`r` 刷新、Esc 或 `q` 关闭。对已是终态的任务按 `s` 只提示、不进确认。进入输出查看态后另有一套滚动键位：↑↓ 或 `k`/`j` 滚行、PgUp/PgDn 翻屏、Home/`g` 跳顶、End/`G` 跳底、Esc 或 `q` 回到列表。

按 `s` 后进入停止确认态，此时**只认 `y`（确认）/ `n`（取消）/ Esc（取消）**，其余按键一律被吞掉——这是刻意的防误触设计，免得确认框还开着时一个 `j` 就顺手滚了列表。确认停止的任务不再发终态通知（结果已经摆在眼前）。

前台 `bash` 默认超时 60 秒（`timeout` 参数可调，上限 300 秒），超时后**自动转后台**继续运行、不再阻塞当前回合，已收集的部分输出随工具结果一起回灌（可在 `[background]` 段关掉这个行为，改为超时即杀）。后台任务本身也有超时（`[background].bash_task_timeout_s`，默认 600 秒，0 为不限），到期先 SIGTERM、宽限 2 秒未退出再 SIGKILL。

任务终态时主动注入完成通知，不用你轮询：

- **及时**：通知在回合边界就注入，模型下一个回合即可看到，不用等整个长任务循环结束；主会话空闲时则直接触发一个新回合。
- **精简**：通知本体是一行（任务描述 + 终态 + 退出码），后面只带输出尾部的小段兜底预览（2000 字符量级），完整输出要模型用 `task_output` 自取。
- **不噪音**：用 `task_stop` 亲手杀掉的任务不再发"已结束"通知（结果已经在工具返回里了）。

通知行为可在 `[background]` 段关掉（`notify_on_complete`），关掉后模型回到经 `task_list` 主动查询。终端铃响 / 桌面通知是另一个开关（`notify_terminal`）。

一个反模式要避免：起了后台任务又立刻原地等它——那不如直接前台跑。后台任务的价值在于「先去做别的，完成时自动回来通知」。

## 使用建议

这几类机制的正当用途是**分担你的等待和协调成本**：并行的调查交给 explore 子 agent，多阶段的产出交给 `dynamic_workflow` 或 `spawn_agent`，需要持续推进的交给 goal，定时的交给 cron，耗时命令交后台。主会话只留需要你判断的部分。反过来，一句话能说清的小任务不要动用它们——机制本身有上下文和 token 成本。
