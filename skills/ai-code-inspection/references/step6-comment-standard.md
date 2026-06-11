# Step 6: 注释与文件头规范

本 Step 在实现、测试和文档检查后执行，用于确认注释和文件头是否仍然有用。

## 通用规则

- 只有代码意图无法从命名和结构直接看出时，才添加注释。
- 删除或更新与当前行为矛盾的注释。
- 不添加重复下一行代码含义的注释。
- 不虚构作者、日期、历史修改或业务决策。
- 除非当前项目已有文件头约定，否则不强制新增文件头。
- TypeScript 类型定义通常不需要注释，类型本身即文档。

## 适合保留的注释

以下情况可以使用简短注释：

- 不明显的 fallback 行为或兼容性保留原因。
- 保护真实 workflow 的边界条件。
- 外部格式或协议到内部 contract 的 mapping 逻辑。
- concurrency、transaction、retry 或 cleanup 规则。
- 有意保留的兼容行为或临时 workaround（应标注 TODO 和期望移除条件）。
- 平台差异处理（如 win32 vs 非 win32 的进程 kill 逻辑）。
- 动态 import 的 fallback 原因（如 optional VAD plugin）。

## 前端注释

当 ui/ 或 src/tui/ 文件在范围内时执行：

- comment 应只在命名不足以说明 component/composable/store 行为时补充。
- 不新增可见的 in-app instructional text（属于产品 UX 范畴）。
- 复杂的 layout 或交互逻辑可以使用简短注释说明意图。

## 后端注释

当 src/gateway/ 或 extensions/* 文件在范围内时执行：

- service 注释应解释业务规则或编排约束，而不是复述函数名。
- repository/provider 注释可以解释 mapping、transaction、migration 或外部 IO 意图。
- extension 注释应说明外部系统交互的关键约定。
- 复杂类型定义可以使用 JSDoc 说明用途。

## 文件头检查

如果项目已有标准文件头约定：

- 确认变更过的手写 source 文件符合本地文件头形态。
- 新增修改记录必须来自可观察变更，不得写泛泛描述。
- 不更新 generated output、build artifact、dependency folder、lockfile。

如果项目没有标准文件头约定，文件头检查不适用。当前项目无统一文件头约定。

## 不应有的注释

- 删除过期的 TODO（已完成的工作应移除对应 TODO）。
- 删除重复代码含义的注释（如 `// increment x` 在 `x++` 旁边）。
- 删除标注作者和日期的历史注释（git 已记录）。
