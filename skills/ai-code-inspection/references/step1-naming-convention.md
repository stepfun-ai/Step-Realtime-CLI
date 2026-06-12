# Step 1: 命名与放置

本 Step 检查文件名、符号名、导出名、路径别名使用、模块放置和术语一致性。

## 输入

- `../project-environment-profile.md` 中的稳定环境事实。
- `AGENTS.md`、`tsconfig.json`、`package.json` 中与命名、路径别名和目录职责相关的项目事实。
- 已声明的检查边界。
- 变更文件或范围内文件。
- 所属目录中相邻的现有文件。

## 通用检查

- 遵循所属目录已有命名风格。
- 优先使用清晰领域名词和动词，避免 `helper`、`common2`、`newService`、`dataUtil`、`temp`、`utils` 等模糊名称。
- 前后端（或 client/server）同时变更时，契约术语必须一致。
- 已有模块或目录能承接该职责时，不要新增顶层目录。
- 除非是明确的 adapter/infrastructure 类型，否则不要把实现技术名泄漏进领域类型。
- 文件名应与主要导出符号对应（如 `foo-bar.ts` 导出 `FooBar`）。

## 包与模块命名

- 包名使用 kebab-case（如 `realtime-voice`），目录名与包名一致。
- 包入口文件为 `src/index.ts`，类型入口通过 `exports` 字段声明。
- 扩展包（extensions/*）以能力命名，如 `realtime-aec`、`realtime-vad-silero`。
- Skill 包（skills/*）以功能命名，如 `builtin`。

## 导出与类型命名

- 公共导出名使用 PascalCase（类、接口、类型）。
- 内部/私有符号使用 camelCase。
- 常量使用 SCREAMING_SNAKE_CASE。
- TypeScript 接口使用 PascalCase 名词命名，**不使用 `I` 前缀**。
- 泛型参数使用简短 PascalCase（如 `TValue`、`TContext`）。

## 路径别名检查

当使用 `@step-cli/*` 路径别名时：

- 导入来源必须与 `tsconfig.json` 中声明的 `paths` 映射一致。
- `@step-cli/core` 只能从 `packages/core/src` 解析。
- `@step-cli/protocol` 只能从 `packages/protocol/src` 解析。
- `@step-cli/utils` 只能从 `packages/utils/src` 解析。
- `@step-cli/sdk` 只能从 `packages/sdk/src` 解析。
- `@step-cli/agent-sdk` 只能从 `packages/agent-sdk/src` 解析。
- `@step-cli/realtime` 只能从 `packages/realtime/src` 解析。
- extension 别名（`@step-cli/llm`、`@step-cli/mcp`、`@step-cli/realtime-*`）只能从对应 `extensions/*/src` 解析。
- `@step-cli/skills-builtin` 只能从 `skills/builtin/src` 解析。
- 不得使用相对路径跨越包边界（如 `packages/core/src` 中不得 `../../extensions/...`）。

## UI (React) 检查

当 ui/ 文件在范围内时执行：

- React component 使用 PascalCase 命名。
- Hook 使用 camelCase 并以 `use` 开头。
- 共享类型应放在 `ui/src` 内已有 type 目录中。

## TUI (OpenTUI) 检查

当 src/tui/ 文件在范围内时执行：

- 新增 TUI 组件时应使用 PascalCase 命名。
- composable/store 使用 camelCase。
- 保留在现有 tui 目录结构下，不随意新增顶层目录。

## CLI 检查

当 src/cli/ 或 src/commands/ 文件在范围内时执行：

- 命令文件放在 `src/commands/` 下，与命令职责对应。
- Commander 的 command/option 命名使用 kebab-case。
- 参数解析和业务逻辑分离。

## Gateway 检查

当 src/gateway/ 文件在范围内时执行：

- 文件使用 kebab-case 命名（如 `session-store.ts`、`http-server.ts`、`session-event-bus.ts`）。
- 子目录按职责划分（session、memory、plugins、logging、storage、service、team、worktree、artifacts、restore）。
- 新增文件放入已有子目录；只有全新职责时才新建目录。
- 不使用 NestJS 风格的 `*.module.ts`、`*.controller.ts`、`*.service.ts` 后缀。
