import { t } from '../i18n.js';

/**
 * 退出时的会话恢复提示（形如 "To resume this session: step -r <id>"）。
 * 命令与 CLI 的 -r/--resume 参数对应，是提示文案与命令行之间的契约。
 */

/** 恢复命令文本。 */
export function resumeCommand(sessionId: string): string {
  return `step -r ${sessionId}`;
}

/** 文本模式的提示行（本地化，TUI 与 -p text 模式打到 stderr）。 */
export function resumeHintText(sessionId: string): string {
  return t('exit.resumeHint', { command: resumeCommand(sessionId) });
}

/** stream-json 模式的 meta 事件（session resume hint 结构）。 */
export function resumeHintMeta(sessionId: string): {
  type: 'session.resume_hint';
  session_id: string;
  command: string;
  content: string;
} {
  const command = resumeCommand(sessionId);
  return {
    type: 'session.resume_hint',
    session_id: sessionId,
    command,
    // stream-json 消费方多为程序，content 固定英文，不随界面语言变
    content: `To resume this session: ${command}`,
  };
}
