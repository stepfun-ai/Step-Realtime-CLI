import { isAbsolute, resolve } from 'node:path';

/**
 * 把工具传入的路径解析为绝对路径。相对路径以 ctx.cwd 为基准。
 * 不做越界限制（初版信任模型 + 用户环境），但统一走这里便于后续加沙箱。
 */
export function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}
