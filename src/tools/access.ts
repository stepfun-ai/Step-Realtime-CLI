/**
 * 工具资源访问声明：供 runTurn 并行调度做冲突判定。
 * 工具未声明 access 时一律视为 all —— 永远独占，新工具忘了声明就退化为安全的串行行为。
 */
export type ToolAccess =
  | { kind: 'none' } // 无本地副作用（web 类、只读 explore 子 agent）
  | { kind: 'read'; path: string } // 读文件 / 目录（read_file、grep、glob、list_dir）
  | { kind: 'write'; path: string } // 写文件（write_file、edit_file）
  | { kind: 'all' }; // 完全独占（bash 等副作用不可判定的工具，缺省）

/** 路径重叠判定：相等或前缀重叠（按目录边界，/a/b 与 /a/bc 不算重叠）。统一分隔符后比较。 */
function pathOverlap(a: string, b: string): boolean {
  const na = a.replace(/\\/g, '/').replace(/\/+$/, '');
  const nb = b.replace(/\\/g, '/').replace(/\/+$/, '');
  return na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/');
}

/**
 * 冲突判定：任一边 all 必冲突（最高优先级，all 连 none 也不放行——
 * general 子 agent / bash 必须与只读任务互斥）；none 与其余不冲突；
 * read-read 不冲突；其余（至少一边 write）仅当路径相等或前缀重叠时冲突。
 */
export function accessConflict(a: ToolAccess, b: ToolAccess): boolean {
  if (a.kind === 'all' || b.kind === 'all') return true;
  if (a.kind === 'none' || b.kind === 'none') return false;
  if (a.kind === 'read' && b.kind === 'read') return false;
  return pathOverlap(a.path, b.path);
}
