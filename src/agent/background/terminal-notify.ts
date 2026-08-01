/**
 * 终端通知：后台任务完成时提醒用户。
 * 两层机制：
 * 1. BEL（`\x07`）—— 所有终端通用，系统铃响。
 * 2. OSC 9 —— 现代终端桌面通知（iTerm2、WezTerm、Kitty、Ghostty、Windows Terminal、Warp）。
 *    tmux 内自动套 DCS 透传，否则被吞掉。
 *
 * 取业界终端 agent 的通行做法，精简为 Step Code 最小面（只做完成提醒，不做进度条）。
 */

const ESC = '\u001B';
const BEL = '\u0007';
const ST = '\\';

/** 检测当前终端是否支持 OSC 9 桌面通知。 */
export function supportsTerminalNotification(env: NodeJS.ProcessEnv = process.env): boolean {
  const termProgram = env['TERM_PROGRAM'] ?? '';
  if (termProgram === 'iTerm.app' || termProgram === 'WezTerm' || termProgram === 'ghostty' || termProgram === 'WarpTerminal') {
    return true;
  }
  const term = env['TERM'] ?? '';
  if (term === 'xterm-kitty' || term === 'xterm-ghostty') return true;
  // Windows Terminal
  if ((env['WT_SESSION'] ?? '').length > 0) return true;
  return false;
}

/** 检测是否在 tmux 内。 */
function isInsideTmux(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['TMUX'] ?? '').length > 0;
}

/** 清理通知文本中的控制字符，防止逃逸序列污染终端。 */
function sanitize(value: string): string {
  return Array.from(value)
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp >= 0x00 && cp <= 0x1f ? ' ' : ch;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 构建终端通知的 ANSI 序列。
 * 支持 OSC 9 → 回退 BEL。
 */
export function buildNotificationSequence(message: string): string[] {
  const text = sanitize(message);
  if (text.length === 0) return [];

  if (!supportsTerminalNotification()) {
    return [BEL];
  }

  const osc9 = `${ESC}]9;${text}${BEL}`;
  if (isInsideTmux()) {
    const escaped = osc9.replaceAll(ESC, `${ESC}${ESC}`);
    return [`${ESC}Ptmux;${escaped}${ESC}${ST}`];
  }
  return [osc9];
}

/** 向 stdout 写终端通知序列（后台任务完成时调用）。 */
export function emitTerminalNotification(message: string): void {
  const sequences = buildNotificationSequence(message);
  for (const seq of sequences) {
    process.stdout.write(seq);
  }
}
