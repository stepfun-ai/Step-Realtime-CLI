# 技能、插件与 MCP

本页讲三种扩展 step-code 能力的方式：技能（SKILL.md）、插件、外部 MCP server。

## 技能（Skill）

技能是带 YAML frontmatter 的 Markdown 文件，封装一套可复用的工作流程或规范（比如"提交信息格式""PR 审查流程"）。采用懒加载：system prompt 里只放「名称+描述」清单（有 8000 字符预算防膨胀），模型判断需要时经 `skill` 工具激活，正文才注入上下文。你也可以用 `/skill <名称> [参数]` 手动激活。

### 写一个技能

在技能目录下建 `<技能名>/SKILL.md`：

```markdown
---
name: commit-message
description: 按约定式提交规范生成 commit message
when_to_use: 用户要求提交代码或生成 commit message 时
---

生成 commit message 时遵循：
- 格式：type(scope): 主题，主题不超过 50 字
- type 取值：feat / fix / docs / refactor / test / chore
```

`name` 和 `description` 必填（name 限小写字母数字、`-`、`_`）。正文支持占位符：`$ARGUMENTS`（全部参数）、`$0`–`$9`（按空格分词的第 n 个）、`${STEP_SKILL_DIR}`（技能目录绝对路径，可引用同目录的参考文件、脚本）。

### 加载路径与优先级

按扫描顺序，同名后者覆盖（具体胜一般、原生胜兼容）：

1. 内置（builtin）：随包发布，优先级最低（如 `update-config`）
2. 用户级：`~/.step-code/skills/`
3. 项目级（兼容目录）：`<项目>/.agents/skills/`——与其他 CLI 共享的目录约定
4. 项目级（原生目录）：`<项目>/.step-code/skills/`
5. 追加目录：config.toml 的 `extra_skill_dirs`
6. 插件提供：优先级最高

同名 skill 只保留一份（清单不重复）；两个目录放了同名 skill 时，生效的是优先级高的那份。发生这种覆盖时，启动和重载后会明确提示冲突清单：哪个来源被采用、覆盖了谁，不会让旧版本悄悄遮蔽新版本。

```toml
# ~/.step-code/config.toml：追加你的私有技能目录，与默认路径共存
extra_skill_dirs = ["~/my-private-skills"]
```

追加目录里的同名技能会 shadow 项目级和用户级——个人修正团队技能的标准做法。路径支持 `~` 和相对工作目录。

### 热加载与 `/skill reload`

会话进行中新增、修改或删除 SKILL.md 不用重启：每个回合边界自动比对各 SKILL.md 的「路径 + 修改时间」指纹，有变更就全量重建注册表，并提示新增/移除/变更清单；重建后下一回合的 system prompt、`skill` 工具和子 agent 立即使用新清单。想立即刷新可随时手动执行：

```
/skill reload    # 强制全量重扫技能目录
```

重载后若存在同名冲突，会随重载结果一起提示。

### 按名排除

```toml
# ~/.step-code/config.toml：任何来源的同名 skill 都不加载
disabled_skills = ["team-noisy-skill"]
```

合并完成后统一过滤：项目级、用户级、追加目录、插件提供的同名 skill 都会被排除。典型场景是目录不归你管（团队仓库共享的 `.agents/skills/`），不能删文件，但想屏蔽个别技能。

### 内置技能

`update-config` 随包内置（优先级最低，可被同名技能遮蔽，也可经 `disabled_skills` 排除）：内嵌 config.toml 的真实键表与「副本编辑 → 校验 → 备份 → 覆盖 → `/reload` 路由」变更协议，模型需要查看或修改配置时走它能拿到一手知识，不用猜键名。配套命令行校验入口 `step doctor config <路径>`。

## 插件（Plugin）

插件是把扩展能力打包分发的机制：一个目录，声明它提供哪些能力，宿主从不执行插件自己的代码。在 `~/.step-code/plugins/<插件名>/` 下放置：

```
my-plugin/
└── .step-code-plugin/
    └── plugin.json     # 插件清单
```

### 清单能提供什么

`plugin.json` 在 `name` / `version` / `description` 之外，可声明四类能力，全部是对已有机制的打包复用：

| 字段 | 内容 | 合流方式 |
|------|------|----------|
| `skills` | skill 目录 | 并入 skill 加载，优先级最高 |
| `mcpServers` | MCP server 配置（stdio，同 mcp.json schema） | 并入 MCP 加载，运行时名强制加 `<插件id>:<server>` 前缀隔离 |
| `hooks` | hooks 配置（同 `[[hooks]]` 四字段） | 并入 hooks 引擎，command 的工作目录固定为插件根，注入 `STEP_CODE_PLUGIN_ROOT` |
| `commands` | markdown 提示词模板（frontmatter 可覆盖 name/description，body 支持 `$ARGUMENTS`） | 注册为斜杠命令，强制命名空间 `<插件id>:<命令名>` |

执行型字段（tools/apps/bootstrap 等）会被识别并忽略——插件不创造新能力类型，只打包分发已有能力。所有相对路径都做根内校验，MCP 的 command 必须是 PATH 命令或 `./` 相对路径，拒绝绝对路径。

### 安装与管理

用 `/plugin` 命令管理（也见[交互使用](./interactive.md)）：

```
/plugin install <本地目录>   # 复制进插件目录，重装同 id 即覆盖更新
/plugin list                 # 列出已装插件及启停/错误状态
/plugin enable <id>          # 启用
/plugin disable <id>         # 停用
/plugin remove <id>          # 移除
/plugin info <id>            # 查看详情
```

启停状态记在 `~/.step-code/plugins.json`（记录 disabled 集合）。清单解析失败的坏插件会标为 error 列出，但不拖垮启动。启停变更后按提示 `/new` 或重启生效。

安装即复制而非软链，所以插件源目录被移动或删除不影响已装插件；代价是更新要重装。

## MCP

连接外部 MCP server（stdio 方式），把外部工具接进 step-code：

```json
// ~/.step-code/mcp.json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"]
    }
  }
}
```

MCP 工具命名为 `mcp__<server>__<tool>`，默认不进初始工具列表——经 `tool_search` 懒加载，模型检索命中后才注册进会话，避免外部工具撑爆上下文。启动时并行连接、单点失败不影响其他 server。`/mcp` 查看各 server 的连接状态、工具数和错误。

## 怎么选

- 一套提示词/流程想复用：写技能，最简单
- 技能要打包分发给团队：做成插件
- 要接外部系统（数据库、第三方 API、内部服务）：写或接 MCP server
