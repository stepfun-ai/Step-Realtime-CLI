# read_media jimp 依赖缺失状态确认

> 2026-08-20 排查结论。

## 用户报告

用户反馈 read_media 报错"Cannot find package 'jimp'"，认为是 step-code 的图像处理依赖缺失。

## 排查结果

### 代码层面：已正确处理

`src/tools/readMedia.ts` 的 `classifyJimpError()` 函数（对应 dist 第 88 行）会匹配
`/cannot find package|cannot find module|err_module_not_found/i` 模式，把 jimp 缺失
和图片损坏分开报，返回友好提示：
> 图像解码依赖（jimp）缺失：... 这是环境问题而非图片损坏，请在所用 step 变体目录执行 pnpm install 修复。

### 环境层面：jimp 已安装

- 开发仓 `step-code-ink/node_modules/jimp` → 符号链接完整，目标存在
- 开发仓 `step-code-pi/node_modules/jimp` → 符号链接完整，目标存在
- 全局安装 `/c/nvm4w/nodejs/node_modules/step-code-pi/node_modules/jimp` → 存在
- 从 dist 目录 `node -e "import('jimp')"` → 成功

### 调试包排查

`debug-20260820014656-570291-20260820133018.zip` 的 errors.log 里没有 jimp 相关错误。
该会话是"模型性格特质测试"，未触发 read_media。

## 结论

1. **代码已健壮**：jimp 缺失有友好提示，不会让模型误判为图片损坏
2. **环境已修复**：jimp 在所有 step-code 变体中都已安装
3. **可能是一次性问题**：如果用户确实遇到了，大概率是某次 pnpm install 不完整导致的，
   之后已被修复

## 如果再次出现

1. 在对应 step-code 变体目录执行 `pnpm install`
2. 检查 pnpm 符号链接是否断裂：`ls -la node_modules/jimp`
3. 如果符号链接断裂，删除 node_modules 后重新 `pnpm install`
