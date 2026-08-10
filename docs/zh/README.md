<p align="center">
  <a href="../en/README.md">English</a> |
  <a href="./README.md">简体中文</a>
</p>

# Step Code 使用指南

Step Code 是终端里的编码 agent CLI，由阶跃星辰 Step 系列模型驱动。模型通过工具直接读写真实文件、执行真实命令，结果回灌后继续推进，直到任务完成。

本指南按使用路径组织，建议新用户从快速开始读起。

## 文档地图

| 页面 | 解决什么问题 |
|------|-------------|
| [快速开始](./quickstart.md) | 10 分钟跑通：安装、配 key、第一次对话 |
| [安装](./installation.md) | 环境要求、源码构建、全局命令、升级与卸载 |
| [配置参考](./configuration.md) | API key、config.toml 全字段、多协议 provider、多渠道/多模型、thinking、hooks、环境变量、mcp.json、数据目录 |
| [交互使用](./interactive.md) | TUI 界面、斜杠命令、快捷键、权限三档、计划模式、模型选择器、插件管理 |
| [子 agent 与自动化](./agents.md) | spawn_agent、并行执行、dynamic_workflow、goal、cron、后台任务 |
| [会话管理](./sessions.md) | 持久化、续接与恢复、分叉、压缩、回顾、非交互输出 |
| [stream-json 事件流](./stream-json.md) | 被外部程序调用：事件信封契约、全部事件类型、版本与兼容规则 |
| [技能、插件与 MCP](./skills-and-mcp.md) | SKILL.md 格式、加载层级、extra_skill_dirs、plugin 能力面、MCP |
| [hooks 机制](./hooks.md) | 生命周期钩子：五个事件、执行与阻断约定、注入 |
| [AGENTS.md 机制](./agents-md.md) | 项目规范怎么加载、怎么覆盖、怎么自定义来源 |

## 速查

```bash
step                    # 进入交互界面
step -p "指令"          # 非交互执行单条指令
step --continue         # 续接上次会话
```

交互界面里输入 `/help` 查看全部斜杠命令。
