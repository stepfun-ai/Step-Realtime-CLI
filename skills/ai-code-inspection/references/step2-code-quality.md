# Step 2: 代码质量

本 Step 用于发现常见实现错误和日常质量问题。检查应务实，不等同于严格 release gate。

## 通用检查

- 移除范围内未使用的 import、变量、死分支和过期 TODO。
- 已有共享 type/contract 时，不要重复定义局部契约。
- 函数职责应清晰，不要把多种职责混在一个大函数中。
- 不要静默吞掉 API、SDK、filesystem 或外部 IO 失败；错误应向上传递或显式处理。
- `tsconfig.json` 已开启 `strict: true`，范围内代码不得使用 `any` 类型。
- 已有 union/interface/type 时，不要把窄契约放宽成 `unknown` 或无类型 object。
- async loading/error 状态在成功和失败路径都应复位。
- 对可能为 `null` / `undefined` / 空数组的数据，先做保护再访问集合方法或深层属性。
- 校验和 normalization 应靠近输入边界。
- ESM 模块中不得使用 CommonJS 模式（如 `require`、`module.exports`、`__dirname`）。
- `node:` 前缀导入应优先于裸模块名导入（如 `node:fs` 而非 `fs`）。

## UI (React) 检查

当 ui/ 文件在范围内时执行：

- React component 的 state 更新应使用函数式更新避免闭包陷阱。
- useEffect 依赖数组应完整；lint 规则会覆盖，但逻辑遗漏仍需关注。
- 事件处理函数命名应一致（handleXxx / onXxx）。
- 条件渲染应有合理的 fallback UI。
- 不得在渲染路径中执行有副作用的操作。

## TUI (OpenTUI) 检查

当 src/tui/ 文件在范围内时执行：

- 组件渲染应避免在 render 中执行副作用。
- state 管理应与 OpenTUI 框架约定一致。
- layout 和交互逻辑分离。

## CLI 检查

当 src/cli/ 或 src/commands/ 文件在范围内时执行：

- Commander 命令的解析错误应给出清晰提示。
- 异步命令应正确处理 SIGINT/SIGTERM。
- 命令行参数应有合理的默认值和必填校验。

## Gateway 检查

当 src/gateway/ 文件在范围内时执行：

- service 负责业务编排，不直接处理 transport 细节。
- repository/provider 负责 data access 和外部 IO 边界。
- controller/handler 只处理 route、params、body 和 auth。
- invalid ID、missing record、unauthorized 应使用一致的错误处理策略。
- 不要把内部 persistence shape 泄漏到 public API response。
- session/memory/storage 的边界应清晰。

## Extension 检查

当 extensions/* 文件在范围内时执行：

- extension 应只暴露项目约定的接口，不泄漏外部 SDK 细节到上层。
- 动态 import（如 optional VAD plugin）应做好 fallback。
- extension 不得引入与职责无关的依赖。

## Knip 相关

- 项目中已配置 knip（^6.0.4），用于检测未使用 export、未使用依赖等。
- 如果修改了 knip.config.ts 的 entry/project/ignore 配置，应说明原因。
- 新增导出符号时确保被使用，或明确标记为 public API。
