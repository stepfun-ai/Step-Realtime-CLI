import { stored, type StoredMessage } from '../message.js';
import type { BackgroundTask, LostTask } from './manager.js';

/** 通知里给模型看的输出尾部兜底预览上限（任务未落盘 output.log 时才用，防止长输出无谓占上下文）。 */
const PREVIEW_CHARS = 2000;

/** 可通知的任务视图：常规终态任务或对账恢复的 lost 任务。 */
export type NotifiableTask = BackgroundTask | LostTask;

/**
 * 通知幂等 id：`task:<taskId>:<status>`。
 * 同一任务同一终态的通知 id 恒定，配合幂等键（wirelog.notifyDedupKey）实现去重与补投。
 */
export function notificationIdFor(task: NotifiableTask): string {
  return `task:${task.id}:${task.status}`;
}

/** XML 转义：命令等自由文本进信封正文/属性前必须过一遍。 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 终态的中文文案。lost = resume 对账时发现 running 但进程已不存在（任务随旧进程一起死掉）。 */
function statusText(task: NotifiableTask): string {
  const exit = task.exitCode !== undefined ? `（退出码 ${task.exitCode}）` : '';
  switch (task.status) {
    case 'completed':
      return `已完成${exit}`;
    case 'failed':
      return `失败${exit}`;
    case 'killed':
      return '已被终止';
    case 'lost':
      return '已失联（进程已不存在，会话恢复时按丢失标记）';
    case 'running':
      return '仍在运行';
  }
}

/**
 * 把后台任务终态装配为 XML 信封通知文本（合成 user 消息的正文）。
 *
 * 双通道设计：provider API 只有 user 这一个注入位，「这是系统通知不是用户指令」的语义
 * 拆成两个互不干扰的载体——XML 信封给模型（它在正文里唯一的区分依据），结构化 origin
 * 给代码（见 buildSettleMessage）。无 prompt 侧专门段落，防线 = 信封 + 正文措辞 +
 * 工具文档引导（模型被告知终态会主动到达，无需轮询）。
 *
 * 输出指引：任务落盘了 output.log 时只给 <output-file> 指针（完整输出在磁盘，模型按需
 * 用 task_output 读取）；未落盘（内存态管理器）退化为小尾部兜底预览。
 * 给模型看的文案恒中文，不进 i18n。
 */
export function formatSettleNotification(task: NotifiableTask): string {
  const agentAttr = task.agentId !== undefined ? ` agent_id="${escapeXml(task.agentId)}"` : '';
  const lines: string[] = [
    `<notification id="${escapeXml(notificationIdFor(task))}" category="task" type="task.${task.status}"` +
      ` source_kind="background_task" source_id="${escapeXml(task.id)}"${agentAttr}>`,
    `状态：${statusText(task)}`,
    `命令：${escapeXml(task.command)}`,
  ];
  if (task.outputPath !== undefined) {
    lines.push(
      `<output-file path="${escapeXml(task.outputPath)}" bytes="${task.outputBytes ?? 0}">` +
        '完整输出已落盘，用 task_output 按需读取。</output-file>',
    );
  } else if (task.output === '') {
    lines.push('（无输出）');
  } else {
    const tail =
      task.output.length > PREVIEW_CHARS
        ? task.output.slice(task.output.length - PREVIEW_CHARS)
        : task.output;
    lines.push(`输出尾部预览：\n${escapeXml(tail)}`);
  }
  lines.push('（这是系统主动注入的后台任务终态通知，无需用 task_list 轮询。）');
  lines.push('</notification>');
  return lines.join('\n');
}

/**
 * 把终态通知装配为一条完整的 storage 消息：正文 XML 信封 + 结构化 origin
 * （kind=background_task，携带 taskId/notificationId/agentId）。
 * 下游按 origin 路由：幂等去重、UI 渲染、压缩取舍、fork/undo 边界，无需解析正文。
 *
 * startsPromptTurn 由注入方按路由决定：busy 入队（中途注入，false）/ idle 直投（唤醒新回合，true）。
 */
export function buildSettleMessage(
  task: NotifiableTask,
  opts?: { agentId?: string; startsPromptTurn?: boolean },
): StoredMessage {
  return stored(
    { role: 'user', content: formatSettleNotification(task) },
    {
      kind: 'background_task',
      taskId: task.id,
      notificationId: notificationIdFor(task),
      agentId: opts?.agentId,
      startsPromptTurn: opts?.startsPromptTurn,
    },
  );
}

/** 通知注入路由：busy 时留在管理器待投递队列（runAgent 回合边界 flush），空闲时直接提交触发新回合。 */
export type NotifyRoute = 'enqueue' | 'submit';

export function decideNotifyRoute(busy: boolean): NotifyRoute {
  return busy ? 'enqueue' : 'submit';
}
