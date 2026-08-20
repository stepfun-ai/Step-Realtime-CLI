# Thinking 重复检测算法优化设计 V2

> 待验证。基于调试包 20260819054540 的实际死循环案例。

## 根因分析

### 调试包发现的实际死循环

调试包 `debug-20260819054540-0f0515-20260820142039.zip` 中发现：

**第 54 条 assistant 消息的 thinking 内容**（557 字符）：
```
I can't use elevation elevation elevation elevation elevation. elevation elevation elevation elevation elevation elevation elevation. Let me use elevation elevation elevation elevation.

Actually, elevation is elevation elevation elevation elevation elevation. elevation elevation elevation elevation...

Elevation elevation elevation elevation elevation elevation. Elevation elevation elevation elevation elevation elevation elevation elevation elevation.

Let me use elevation elevation elevation elevation elevation elevation elevation.
```

**统计**：61 个词，只有 10 个唯一词。"elevation" 出现 40 次，"elevation." 出现 8 次。重复率极高。

### 为什么当前算法没检测到？

当前 `thinkingLoop.ts` 的 `detect()` 函数第一步：

```ts
if (buf.length < MIN_CHARS) return { looping: false };
```

`MIN_CHARS = 1000`，但这个死循环只有 557 字符。**根本没进入检测逻辑就返回 false 了。**

## 用户核心洞察

> 不管长还是短，我就判断重复的内容长度占比。

这个洞察非常准确。死循环的本质是**重复内容占比高**，不是**总长度大**。557 字符的 "elevation elevation elevation..." 和 10000 字符的 "elevation elevation elevation..." 都是死循环，只是长短不同。

## 优化方案

### 方案 A：降低 MIN_CHARS + 加重复率检测（推荐）

**改动 1：降低 MIN_CHARS**
- 从 1000 降到 200
- 200 字符通常是正常的推理展开起点，之前的重复大概率是循环

**改动 2：加一条"重复率"快速检测路径**
- 在 `detect()` 入口处（MIN_CHARS 检查之后）加一条新路径
- 取尾部 200 字符
- 统计其中最高频词的出现次数 / 总词数
- 如果最高频词占比 > 0.4，判定为循环
- 这条路径不依赖精确字符串匹配，对单词级重复敏感

**为什么有效**：
- "elevation elevation elevation..." → 最高频词 "elevation" 占比 40/(40+8+3+2+2+2+1+1+1+1) ≈ 0.59 > 0.4 → 命中
- 正常推理 "The function takes a parameter and returns a value" → 每个词出现 1 次，占比 1/10 = 0.1 < 0.4 → 不命中

### 方案 B：唯一字符率检测（Yuan3.0 Flash 方案）

- 取尾部 256 字符
- 统计唯一字符数 / 总字符数
- 如果比值 < 0.15，判定为循环

**为什么有效**：
- "elevation elevation elevation..." → 唯一字符约 10 个 / 200 字符 ≈ 0.05 < 0.15 → 命中
- 正常中文推理 → 唯一字符通常很多 → 比值高 → 不命中

**局限**：中文文本本身字符重复率就低，这个阈值可能需要调高。

### 方案 C：n-gram 重复率检测

- 取尾部 200 字符
- 提取 2-gram（双字组合）
- 计算重复 2-gram 数 / 总 2-gram 数
- 如果比值 > 0.5，判定为循环

**为什么有效**：
- "elevation elevation elevation..." → "on " 和 "n " 和 " e" 等重复出现 → 比值高
- 正常推理 → 2-gram 重复率低

## 推荐实施

**方案 A**（改动最小，效果最直接）：
1. MIN_CHARS 从 1000 降到 200
2. 在 detect() 入口加最高频词占比检测（阈值 0.4）
3. 两种方法并行（取或关系），任一种命中都判定为循环

预期效果：
- 557 字符的 "elevation" 死循环 → 最高频词占比检测命中 ✅
- 正常推理不误报（每个词占比低）✅
- 现有长重复和短周期检测不受影响 ✅

## 验证方式

1. 用调试包里的 "elevation" 死循环文本测试
2. 正常推理文本不误报
3. 现有测试用例全绿
4. 新增测试用例：
   - 短文本单词级重复（"elevation elevation..."）
   - 短文本短语级重复（"调免 调免 调免"）
   - 边界：200 字符处的正常推理不误报
