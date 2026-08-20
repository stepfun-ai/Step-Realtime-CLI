# stream-json 事件流

`step -p "..." --output-format stream-json` 会把本次运行的每个事件按**一行一个 JSON 对象**写到 stdout，供外部程序消费。

```bash
step -p "读一下 README 并总结" --output-format stream-json --yolo
```

```json
{"type":"text","text":"这个项目"}
{"type":"tool_start","id":"tu_1","name":"read_file","input":{"path":"README.md"}}
{"type":"tool_end","id":"tu_1","name":"read_file","result":"...","isError":false}
{"type":"usage","totalTokens":19414,"measuredLength":2,"billedDelta":19414}
{"type":"turn_done"}
{"type":"session.resume_hint","session_id":"20260802-abc","command":"step -r 20260802-abc","content":"To resume this session: step -r 20260802-abc"}
```

## 信封契约

三条规则，写代码前先读：

**一，顶层 `type` 是唯一判别式。** 每行必有 `type` 字段，按它分派即可，不需要递归解包，也不需要看第二个字段来决定类型。

**二，遇到不认识的 `type` 必须跳过，不要报错。** 新版本会加新事件类型，把未知类型当异常处理的程序会在升级后炸掉。正确写法：

```python
for line in proc.stdout:
    ev = json.loads(line)
    match ev["type"]:
        case "text": ...
        case "tool_start": ...
        case _: continue      # 未知类型跳过，不是错误
```

**三，可选字段缺省时是「不存在」而不是 `null`。** 用「字段在不在」判断，别拿 `=== null` 比。

## 版本与兼容

`STREAM_JSON_PROTOCOL_VERSION` 当前为 **2**（v2 起 `session.resume_hint` 的 meta 信封不再带 `role` 字段，只认 `type` 判别）。

递增规则明确划两类：

| 变更 | 是否递增版本 | 说明 |
|------|------------|------|
| 新增事件类型 | **否** | 靠上面规则二保证兼容，老消费方跳过即可 |
| 给已有事件加可选字段 | **否** | 老消费方不读也不受影响 |
| 改字段语义 | **是** | 同名字段含义变了，老消费方会静默算错 |
| 删字段 / 改字段名 / 改类型 | **是** | 老消费方直接取不到值 |

也就是说：**只增不改的变更不会打断你的程序**，只有语义变更或字段删除才是 breaking change。

## 事件族

三族共用一个平坦命名空间，按 `type` 前缀区分来源。

### agent 循环事件（无前缀）

| type | 关键字段 | 说明 |
|------|---------|------|
| `text` | `text` | assistant 正文增量 |
| `thinking_start` / `thinking_delta` / `thinking_end` | `text` | 思考过程与边界。有的模型不吐可见思考文本，此时只有 start/end 没有 delta |
| `tool_start` | `id` `name` `input` | 工具开始执行 |
| `tool_end` | `id` `name` `result` `isError` | 工具执行结束 |
| `retry` | `attempt` `delayMs` `message` | 请求重试 |
| `usage` | `totalTokens` `measuredLength` `billedDelta` | 上下文用量。`billedDelta` 是本轮计费增量（input − cache_read + output），只有真实 API 往返才带 |
| `notice` | `message` | 提示信息（压缩发生、溢出重试等） |
| `continuation` | `inject` | 自主续接：本轮结束，将注入下一轮 |
| `aborted` | — | 被中断 |
| `error` | `message` | 出错。**收到即意味着退出码为 1** |
| `turn_done` | — | 一轮结束 |

### 子 agent 事件（`subagent.*`）

主 agent 派生子 agent 时产生。**并行派生时靠 `subagent_id` 归属**——同一时刻可能有多个子 agent 在跑。

| type | 关键字段 |
|------|---------|
| `subagent.start` | `subagent_id` `subagent_type` `description` |
| `subagent.tool` | `subagent_id` `name` |
| `subagent.usage` | `subagent_id` `tokens`（累计值，不是增量） |
| `subagent.error` | `subagent_id` `message` |
| `subagent.end` | `subagent_id` `is_error` `summary` `summary_truncated` `session_id` `tool_uses` `duration_ms` |

```json
{"type":"subagent.start","subagent_id":"1","subagent_type":"explore","description":"读取配置文件"}
{"type":"subagent.tool","subagent_id":"1","name":"read_file"}
{"type":"subagent.usage","subagent_id":"1","tokens":7068}
{"type":"subagent.end","subagent_id":"1","is_error":false,"summary":"配置文件在 ~/.step-code/config.toml…","session_id":"f2c14fb3-…","tool_uses":1,"duration_ms":10153}
```

关于 `subagent.end`：

- **一定会到达。** 无论正常完成、被中断、还是内部异常，每个 `subagent.start` 都有对应的 `subagent.end`。可以放心用它做「子 agent 是否还在跑」的判定。
- `summary` 超过 500 字符会被截断，此时出现 `summary_truncated: true`。完整产出用 `session_id` 取：`step sessions show <session_id>`。
- `tool_uses` 与 `duration_ms` 是该子 agent 的工具调用次数与墙钟耗时。

### 会话元信息（`session.*`）

| type | 说明 |
|------|------|
| `session.resume_hint` | 运行结束时发出，带 `session_id` 与 `command`，用于续接本次会话 |

## 错误处理

程序消费时需要区分两种失败：

**一，agent 报错。** 流里出现 `{"type":"error","message":"..."}`，进程退出码为 1。这是可预期的失败，`message` 里有可读原因。**即使中途出错，流也是完整的**——已产出的事件不会被丢弃，错误事件追加在尾部，会话照常落盘、可以 resume。

**二，进程异常退出。** 没有 `error` 事件但退出码非 0（如启动阶段配置校验失败）。此时错误信息在 **stderr**，不在 stdout。

所以稳妥的消费方式是：**stdout 解析事件，stderr 单独收集，退出码用来兜底**。

## 与 text 模式的区别

| | `text`（默认） | `stream-json` |
|---|---|---|
| stdout | 只有 assistant 正文，可直接进管道 | 每行一个 JSON 事件 |
| 工具调用 / 提示 / 错误 | stderr | stdout（作为事件） |
| 思考过程 | 不输出 | `thinking_*` 事件 |
| 子 agent | stderr 简讯（仅工具与错误） | 完整五种事件 |

`text` 模式面向人和 shell 管道，`stream-json` 面向程序。

## 已知限制

- **单向**。目前只能读事件流，外部程序无法回答 agent 的提问。需要确认的操作在非交互模式下一律拒绝，用 `--yolo` 或 `--auto` 放行。
- 一次运行一个 prompt，不支持常驻会话多轮对话。多轮请用 `-r <session_id>` 续接。
