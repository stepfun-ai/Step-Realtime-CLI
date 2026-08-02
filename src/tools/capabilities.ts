/**
 * 能力门控的工具过滤：模型没声明对应能力时，把工具从工具表中卸载（不进请求的 tools
 * 数组，也不进执行白名单），模型看不到也就不会尝试调用。运行时仍保留工具内的
 * 能力检查作为兜底第二层（防御纵深）。
 */

/** 能力门控映射：工具名 → 所需能力标记。新增门控工具在此登记。 */
export const CAPABILITY_GATED_TOOLS: Readonly<Record<string, string>> = {
  read_media: 'image_in',
};

/**
 * 按模型能力过滤工具表。capabilities 为 undefined（裸模型/未命中别名）时，
 * 所有门控工具一律卸载——与 read_media 运行时检查的口径一致（无 image_in 即不可用）。
 */
export function filterToolsByCapabilities<T extends string>(
  tools: readonly T[],
  capabilities: readonly string[] | undefined,
): T[] {
  return tools.filter((tool) => {
    const required = CAPABILITY_GATED_TOOLS[tool];
    if (required === undefined) return true;
    return capabilities?.includes(required) === true;
  });
}
