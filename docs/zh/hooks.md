# hooks 机制

hooks 让你在不改代码的前提下，于生命周期事件点执行自己的 shell 命令：观察 agent 在做什么，或在特定时机阻断它。本页讲配置形态、五个事件的语义、执行与阻断约定。字段速查见[配置参考](./configuration.md)。

## 它和权限系统的关系

step-code 内部已有一层程序内挂载点（授权、结果后处理、续接判定），权限系统就挂在上面。hooks 是**在这层之上开放给用户的一道口子**：用配置声明的 shell 命令参与同样的生命周期。

一条底线要先讲清楚：**hooks 不是安全边界**。命令超时、崩溃、返回非约定退出码时一律放行（fail-open），安全边界永远在权限系统。hooks 的定位是体验增强——记录日志、注入上下文、拦掉个别明显不该做的操作，不要指望它兜底安全。

## 配置

在 `~/.step-code/config.toml` 用 `[[hooks]]` 数组声明，每条四字段：

```toml
[[hooks]]
event = "PreToolUse"                          # 事件名
matcher = "^bash$"                             # 可选正则，匹配工具名/事件标识
command = "python ~/.step-code/hooks/guard.py" # 要执行的 shell 命令
timeout = 30                                   # 秒，可选，默认 30，硬顶 600
```

- 同一事件可声明多条，命中的多条**并行执行**。
- `matcher` 缺省时匹配该事件的全部触发。
- 只支持用户级全局配置，不做项目级：配置文件位置即信任边界，这样就不需要额外的内容审查机制。

## 五个事件

| 事件 | 能否阻断 | 触发时机 | stdout 用途 |
|------|----------|----------|-------------|
| `PreToolUse` | 可阻断（只能否决） | 工具执行前，作为授权链第一环 | — |
| `PostToolUse` | 观察 | 工具执行后 | — |
| `UserPromptSubmit` | 可阻断 + 注入 | 用户提交输入后、调模型前 | 作为上下文注入本轮 |
| `Stop` | 可阻断续行 | agent 判定本轮结束时 | — |
| `SessionStart` | 观察 + 注入 | 会话创建或恢复后一次 | 注入会话上下文一次 |

几点要注意的语义：

- **PreToolUse 只能否决，不能批准**。hook 放行只是「不反对」，随后仍走既有权限审批（该弹确认还是弹）。它不替代人工确认。
- **Stop 只给一次续行机会**。Stop hook 阻断时会把原因注入让模型继续跑，但同一轮只生效一次，防止阻断型 hook 把 agent 卡进死循环。
- **UserPromptSubmit 阻断**则本轮不调用模型；放行时它的 stdout 文本作为上下文注入。

## 执行与阻断约定

每个 hook 是一条 shell 命令，通过 **stdin 收到一段 JSON**（snake_case 字段），据此决定放行还是阻断：

- 基础字段：`hook_event_name`、`session_id`、`cwd`。
- 事件相关字段：如 `tool_name`、`tool_input`、`tool_output`（PostToolUse 下工具输出会先截断）等，随事件不同而不同。

退出码决定结果：

| 退出码 | 含义 |
|--------|------|
| `0` | 放行；在 UserPromptSubmit / SessionStart 下，stdout 作为上下文注入 |
| `2` | 阻断；stderr 作为原因（PreToolUse 下作为 deny 理由回灌给模型） |
| 其他非零 / 超时 / 崩溃 | **fail-open 放行**，stderr 摘要进 notice 提示 |

超时默认 30 秒（`timeout` 可配，硬顶 600 秒），超时会杀掉整个进程树。hook 的执行可见性通过对话区的 notice 条目表达（开始 / 阻断 / 超时）。

## 一个例子：拦截对某目录的写入

```python
#!/usr/bin/env python3
# ~/.step-code/hooks/guard.py
import json, sys

data = json.load(sys.stdin)
if data.get("tool_name") in ("write_file", "edit_file"):
    path = (data.get("tool_input") or {}).get("path", "")
    if path.startswith("/etc/"):
        print("禁止写入 /etc", file=sys.stderr)
        sys.exit(2)   # 阻断
sys.exit(0)           # 放行
```

```toml
[[hooks]]
event = "PreToolUse"
matcher = "^(write_file|edit_file)$"
command = "python ~/.step-code/hooks/guard.py"
```

## 插件提供的 hooks

插件也能声明 hooks（见[技能、插件与 MCP](./skills-and-mcp.md)）。插件 hook 复用同一套四字段与执行约定，区别在于 `command` 的工作目录固定为插件根目录，并注入 `STEP_CODE_PLUGIN_ROOT` 环境变量，方便引用插件内的脚本。安全语义与用户 hooks 一致（fail-open）。
