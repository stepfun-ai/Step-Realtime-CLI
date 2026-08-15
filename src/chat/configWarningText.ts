/**
 * 启动期配置诊断的**展示层**渲染：结构化 warning → 当前 locale 的文案。
 *
 * 为什么不放在 config/diagnostics.ts：那里是 headless 规则层，doctor 的输出是固定中文
 * （`warn: <描述>`，有测试断言该格式），而 TUI 必须走 i18n 双表。规则一份、渲染两套，
 * 是这两个入口文案要求不同的必然结果。code 与 i18n key 的对应由
 * tests/config/diagnostics.test.ts 双向钉住，漏加文案会变红。
 *
 * cli.ts（非交互，写 stderr）与 PiChat.ts（交互，转录区 note）共用本模块，避免两条通道
 * 各写一份渲染逻辑后漂移。
 */
import type { IgnoredBadConfigFile } from '../config/config.js';
import type { ConfigWarning } from '../config/diagnostics.js';
import { t } from '../i18n.js';

/** 单条警告的 i18n key（与 ConfigWarningCode 同名收尾）。 */
export function configWarningKey(code: ConfigWarning['code']): string {
  return `app.config.warn.${code}`;
}

/**
 * 渲染完整的启动诊断文本块；无任何问题时返回 undefined（调用方据此决定是否呈现，
 * 正常配置下零输出——不给「一切正常」这类噪声）。
 * @param warnings 警告级问题（不阻塞启动）。
 * @param ignoredBadFile 存在时表示整份配置因语法错误未生效（逃生舱放行）。
 */
export function renderConfigDiagnostics(
  warnings: readonly ConfigWarning[],
  ignoredBadFile?: IgnoredBadConfigFile,
): string | undefined {
  const blocks: string[] = [];
  // 整份配置未生效是更严重的事实，排在逐条警告之前
  if (ignoredBadFile !== undefined) {
    blocks.push(t('app.config.ignoredBadFile', { path: ignoredBadFile.path, message: ignoredBadFile.message }));
  }
  if (warnings.length > 0) {
    const lines = warnings.map((w) => `· ${t(configWarningKey(w.code), w.params)}`);
    blocks.push(`${t('app.config.warn.header', { count: warnings.length })}\n${lines.join('\n')}`);
  }
  return blocks.length > 0 ? blocks.join('\n') : undefined;
}
