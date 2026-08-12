# 统一单行文本编辑器（TextEditField）

> 设计决策记录。约束：**除本文列明的例外，仓内所有单行文本输入一律使用
> `src/tui/TextEditField.tsx`**。新增输入框时先检查能否复用；不能复用必须在本文
> 补充例外条目并说明理由，才允许单独实现。

## 背景

统一前，仓内单行文本输入分三个梯队：

1. **主输入框 `PromptInput`**：能力最全（编辑键集、光标、粘贴折叠）；
2. **复用内核的三个拷贝**：`QuestionPrompt` 的 Other、`FirstRunSetup` 的 EditableInput、
   `ProviderWizard` 的文本步——都基于 `promptEdit.ts`，但按键分发与反色光标渲染
   各自手写（`renderOtherInput` / `renderField` / EditableInput 是同一逻辑的三份拷贝）；
3. **原始版搜索词**：`ModelPicker` / `SkillPicker` / `SessionPicker`（搜索 + 重命名）/
   `ProviderWizard` 选择步——只能追加字符 + 退格删尾，无光标、无编辑键。

第三梯队的行为缺陷是真实的用户可感问题：搜索词打错一个字符只能整段删光重打。
三份拷贝则是维护风险：任何编辑行为修正（如 CJK 光标、粘贴归一）要同步改多处，
历史上已出现过两侧漂移（placeholder 反色花屏的修法只落在其中一处）。

## 组件边界

`TextEditField` 提供：

- 受控值 `{ text, cursor }`（cursor 为 code point 索引），`onChange` 传值式回调；
- 完整编辑键集（`promptEdit`：←→/Home/End/Ctrl+←→/Ctrl+W/U/K/退格/Delete）；
- 单行语义：插入前剥掉所有 `\r`/`'\n'`（粘贴的长 key/URL 折行进字段会毁 TOML
  解析，FirstRunSetup 的历史教训）；
- bracketed paste 整体插入；
- 反色光标渲染（空文本时反色独立空格、不覆盖 placeholder 首字符——反色 CJK
  全宽字符会让该字无法辨认）；
- `onInterceptKey` 父组件拦截钩：返回 true 则内置编辑不处理该键。

### 按键归属规则（重要）

Ink 的 input 事件是**广播**，所有激活的 `useInput` 处理器都会收到同一按键，没有
stopPropagation。因此：

- `TextEditField` 不消费 Enter/Esc/↑↓/Tab——归父组件（提交/取消/导航/切 tab 语义
  各场景不同）；
- 父组件需要占用某个编辑键（如 SessionPicker 的 Delete 删会话、`r` 进重命名、
  QuestionPrompt 多题的 ←→ 切题）时，**必须经 `onInterceptKey` 拦截**，不能在父组件
  自己的 `useInput` 里同时处理——那样同一按键会被处理两次。

### 同一拍连续按键的值一致性

`TextEditField` 内部用 `valueRef` 镜像最新值并乐观更新：同一宏任务拍内连续到达的
按键（终端连打、测试连续 `stdin.write`）在 React 批处理 flush 前执行，传值式
`onChange` 若读 props 闭包旧值会丢字符。这是 PromptInput `selfChangeRef` 的同款坑；
旧搜索框用函数式 setState 才没暴露。组件内所有 handler（按键/粘贴）一律
从 ref 读、变更后立即写回。

## 迁移清单（已统一）

| 位置 | 说明 |
|---|---|
| `QuestionPrompt` Other 自由文本 | — |
| `ProviderWizard` 文本步（id/baseUrl/apiKey 等） | — |
| `ProviderWizard` 供应商选择步搜索词 | 原第三梯队 |
| `FirstRunSetup` EditableInput（baseUrl/key/modelId） | 外壳（标题/提示/边框）保留，内核替换 |
| `ModelPicker` 搜索词 | 原第三梯队 |
| `SkillPicker` 搜索词 | 原第三梯队 |
| `SessionPicker` 搜索词 | 原第三梯队；Delete/Ctrl+D、`r` 经 onInterceptKey 拦截 |
| `SessionPicker` 重命名草稿 | 原第三梯队 |

## 例外与理由

### 1. `PromptInput`（主输入框）——组件层例外，内核已统一

不迁移的理由（三条都成立才保留例外）：

- **多行编辑**：粘贴可带入 `\n`，按行渲染且行高参与动态帧预算
  （`computePromptRows`）；`TextEditField` 是单行语义，强行支持多行会把
  折叠、预算、折行命中三套多行逻辑搬进去，组件边界反而模糊；
- **按键分发深度耦合**：斜杠菜单补全、历史导航、队列取回、粘贴折叠与文本编辑
  是线性优先级链（菜单 → 队列 → 历史 → 编辑 → 字符），拆出编辑器后这条链要
  跨组件协调，复杂度高过收益；
- **内核本无重复**：编辑动作复用 `promptEdit.ts`，光标渲染与 `TextEditField`
  共享同一反色范式，不存在行为漂移的存量风险。

若未来 `TextEditField` 演进多行能力，本例外应重新评估。

### 2. 单键确认（y/n、审批按钮）——不是文本输入

`ApprovalPrompt`、SessionPicker 删除确认等只认单键选择，不产生可编辑文本，
不适用编辑器抽象。

### 3. 选择器列表导航（↑↓/Enter）——不是文本输入

各 Picker 的列表移动、Tab 切栏属于导航，归各组件自己的 `useInput`。

英文版：[../../../en/design/unified-text-editor.md](../../../en/design/unified-text-editor.md)
