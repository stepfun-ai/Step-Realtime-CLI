# 快速开始

读完本页你能完成：安装 step-code、配置 API key、跑通第一次对话。

## 1. 安装

最快的方式（需要 Node.js >= 22）：

```bash
npm i -g https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest/download/step-code.tgz
```

装的是预编译好的包，不在本机编译、不拉依赖；链接始终指向最新 Release。没有 Node 环境可从 [Releases](https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest) 直接下载对应平台的单文件可执行；要参与开发则克隆仓库自行构建：

```bash
git clone https://github.com/stepfun-ai/Step-Realtime-CLI.git
cd Step-Realtime-CLI
pnpm install
pnpm build
pnpm link --global   # 之后可直接用 step 命令
```

四种安装方式的取舍、升级、卸载、常见问题见[安装](./installation.md)。

## 2. 配置 API key

Step 模型的 API key 在[阶跃开放平台](https://platform.stepfun.com)获取。首次启动时如果未配置 key，step-code 会提示配置方式。

任选一种方式配置：

```bash
# 方式一：环境变量（推荐，立即可用）
export STEP_CODE_API_KEY=<your-key>

# 方式二：写入 ~/.step-code/config.toml（持久化）
#   [providers.stepfun]
#   type = "stepfun"
#   api_key = "<your-key>"
```

> 提示：也可以启动后按提示粘贴 key，step-code 会自动写入配置文件。

## 3. 第一次对话

```bash
step
```

进入交互界面后直接输入自然语言，例如：

```
看看当前目录的结构，告诉我这个项目是做什么的
```

模型会调用工具读文件、执行命令，并把结论返回给你。工具结果默认折叠成摘要，按 Ctrl+O 展开完整输出。

写文件、执行命令前会弹出确认（这是 manual 权限模式），用 ↑↓ 选择、Enter 确认。想体验全自动，启动时加 `--yolo`。

## 4. 常用操作

```bash
step -p "在 src 下找出所有 TODO"   # 非交互：执行完打印结果退出
step --continue                    # 续接上次会话
step --resume                      # 打开会话选择器
```

交互界面里：

- `/help` 查看全部命令
- `/new` 开新会话
- `/compact` 手动压缩上下文
- `/exit` 退出
- Esc 中断当前生成

## 下一步

- 想让 AI 遵守你的项目规范：在项目根放一份 `AGENTS.md`，见 [AGENTS.md 机制](./agents-md.md)
- 想沉淀可复用的工作流：写一份 SKILL.md，见[技能、插件与 MCP](./skills-and-mcp.md)
- 想调整模型、上下文、权限默认行为：见[配置参考](./configuration.md)
