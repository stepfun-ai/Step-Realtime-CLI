# AGENTS.md 机制

AGENTS.md 是给模型看的项目/个人规范文件。step-code 启动会话时自动收集相关 AGENTS.md，拼到 system prompt 尾部。本页讲清三个问题：默认从哪加载、怎么覆盖某一层、怎么完全自定义来源。

## 默认收集路径

**用户级**（对所有项目生效），两个目录各取一个文件：

| 目录 | 回落顺序 |
|------|----------|
| `~/.step-code/` | `AGENTS.override.md` → `AGENTS.md` |
| `~/.agents/` | `AGENTS.override.md` → `AGENTS.md` → `agents.md` |

`~/.agents/` 是跨工具共享目录，同一份规范可被多个 agent 工具读取，因此这里多认一层小写 `agents.md` 以兼容各家写法；`~/.step-code/` 是本工具专属目录，只认规范化的两个名字。

**项目级**：从当前目录向上找到含 `.git` 的项目根，然后从根逐层向下到当前目录，每层取第一个命中的文件：

```
.step-code/AGENTS.md  →  AGENTS.override.md  →  AGENTS.md  →  agents.md
```

所有命中的文件按「用户级在前、项目级从根到叶」的顺序拼接，每份前加 `<!-- From: <绝对路径> -->` 注释头。越靠近当前目录的文件位置越靠后，模型视角下更具体的规范优先。总量预算默认 32KB（`agents_md_max_bytes` 可调，`0` = 禁用加载），超出时叶子优先分配、UTF-8 安全截断；发生截断或整篇丢弃时，启动后会在转录区一次性提示哪些文件受影响、原始多大。

## 单层覆盖：AGENTS.override.md

想替换某一层（比如某个项目的团队规范），在该目录放一个 `AGENTS.override.md`，它优先于同层的 `AGENTS.md`。

典型用法：仓库里的 `AGENTS.md` 是团队共享版，你在项目根放一份自己的 `AGENTS.override.md` 并加入 `.gitignore`，个人规范生效且不进版本库，无需任何配置。

## 整体覆盖：agents_paths

`~/.step-code/config.toml` 配置后，默认收集**全部关闭**，只按清单加载：

```toml
agents_paths = ["~/my-rules/AGENTS.md", "./team-docs"]
```

- 条目指向 `.md` 文件：直接读取
- 条目指向目录：取其下 `AGENTS.override.md` → `AGENTS.md` → `agents.md` 第一个命中
- 路径支持 `~` 展开和相对当前工作目录
- 靠后的条目在预算分配中更优先

这是逃生门而不是日常入口：配置后团队规范、用户级默认全部失效，加载来源完全由你显式声明。日常共存需求（个人 + 团队都要）不需要它——用户级文件本来就是私有的，默认就会加载。

## 跨工具共享

`~/.agents/AGENTS.md` 放在一个工具中立的目录下，不带 step-code 的私有路径前缀。把「我是谁、我怎么工作、我的技术偏好」这类不依赖具体工具的规范写在这里，多个 agent 工具可以共用同一份，不必逐个维护。

工具专属的指令（只对 step-code 生效的约定）放 `~/.step-code/AGENTS.md` 或项目内 `.step-code/AGENTS.md`，与共享层分开，避免把本工具的实现细节泄漏给其他工具读取。

## 维护建议

- 团队规范入库放项目根 `AGENTS.md`，保持精简，只写对协作者普遍适用的内容
- 个人规范放 `~/.step-code/AGENTS.md`（全局）或项目内 `AGENTS.override.md`（单项目）
- `.step-code/AGENTS.md` 优先级最高，适合放工具专属的指令（比如只对 step-code 生效的约定）
