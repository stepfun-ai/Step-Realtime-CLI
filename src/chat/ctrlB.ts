import type { BackgroundTask } from '../agent/background/manager.js';

/** Ctrl+B 决策依赖的后台任务数据源（BackgroundManager 的公开子集，结构化类型便于测试 mock）。 */
export interface ForegroundDetachSource {
  listForeground(): BackgroundTask[];
  detach(id: string, viaTimeout?: boolean): boolean;
}

/**
 * Ctrl+B 转后台：busy 且有前台任务时把全部前台任务转后台（任务继续跑、终态自动通知），
 * 返回成功 detach 的数量；idle 或没有前台任务时返回 null（不消费按键，放行）。
 * 弹层互斥由调用方（App 键位链上方各弹层早退分支）保证，本函数不感知弹层。
 */
export function applyCtrlB(busy: boolean, background: ForegroundDetachSource): number | null {
  if (!busy) return null;
  const targets = background.listForeground();
  if (targets.length === 0) return null;
  let detached = 0;
  for (const task of targets) {
    if (background.detach(task.id)) detached += 1;
  }
  return detached;
}
