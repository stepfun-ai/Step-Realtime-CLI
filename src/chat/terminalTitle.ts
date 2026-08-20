/**
 * 终端窗口/tab 标题写入（OSC 0）。
 *
 * 用途：把会话标题显示在终端 tab 上，多开几个 step-code 时能一眼分辨哪个 tab 在干什么。
 * 标题来源是会话标题（session.name ?? title，见 session/title.ts 的 AI 生成），
 * 本模块只管「怎么安全地写进终端」，不管标题内容怎么来。
 *
 * 为什么用 OSC 0 而不是 OSC 2：OSC 0 同时设 icon name 与 window title，
 * 主流终端（Windows Terminal、VSCode 内置、iTerm2、Terminal.app、gnome-terminal、
 * konsole、alacritty、wezterm、kitty）都拿它更新 tab 标题；OSC 2 只设窗口标题，
 * 在部分终端上不改 tab。终止符用 BEL 而非 ST：BEL 是 xterm 传统写法，兼容面更宽
 * （老 conhost 只认 BEL）。
 *
 * 三个必须处理的坑（都由本模块内部消化，调用方只管传人话标题）：
 * 1. tmux / screen 会吞掉 OSC 序列，必须用 DCS passthrough 包装才能透传到外层终端；
 * 2. 分号是 OSC 的参数分隔符，标题里的分号会让其后内容被当成新参数，必须替换；
 * 3. dumb 终端与重定向管道不解析转义序列，会把 `\x1b]0;…` 当正文打出来污染输出，
 *    因此写入前必须探测（这是本模块最重要的职责，宁可不显示也不能污染）。
 *
 * Windows Terminal 侧有一个程序无法绕过的情况：profile 里设了
 * `suppressApplicationTitle: true` 时 tab 标题被锁定，我们发的序列不生效。
 * 那属于用户的终端配置选择，不做兼容尝试。
 */

/** 逃生舱环境变量：设为 1 时完全不写终端标题（不改 config 也能立刻关掉）。 */
export const NO_TERMINAL_TITLE_ENV = 'STEP_CODE_NO_TERMINAL_TITLE';

/**
 * 标题显示宽度上限（中文按 2 宽计）。
 * 60 的依据：tab 可视宽度本就有限，超出由终端自行省略；留出前缀后仍够放一句话主题。
 */
const TITLE_MAX_WIDTH = 60;

/** 标题前缀：与其它 CLI 共用 tab 时能分辨来源。 */
const TITLE_PREFIX = 'step · ';

/**
 * 是否可以写终端标题。env 与 isTTY 作参数注入（便于单测，也避免模块级读取 process）。
 *
 * 判 false 的四类情形：逃生舱开关、非 TTY（管道/重定向/非交互）、
 * 无能力终端（TERM=dumb/unknown）、CI 环境（日志里出现转义序列纯属噪声）。
 */
export function canSetTerminalTitle(
  env: Record<string, string | undefined>,
  isTTY: boolean | undefined,
): boolean {
  if (env[NO_TERMINAL_TITLE_ENV] === '1') return false;
  if (isTTY !== true) return false;
  const term = env['TERM'] ?? '';
  if (term === 'dumb' || term === 'unknown') return false;
  if (env['CI'] !== undefined || env['GITHUB_ACTIONS'] !== undefined || env['GITLAB_CI'] !== undefined) {
    return false;
  }
  return true;
}

/** 字符显示宽度：CJK 与全角算 2，其余算 1（与 tab 上的实际占位对齐）。 */
function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  // CJK 统一汉字、扩展 A、兼容表意、假名、韩文、全角形式
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

/**
 * 清洗标题文本，产出可安全放进 OSC 参数位的字符串。
 *
 * - 删控制字符（含 ESC 与 BEL）：ESC 会启动新转义序列（注入风险），BEL 会提前终止标题；
 * - 分号换全角冒号：分号是 OSC 参数分隔符，留着会截断标题；
 * - 空白折叠成单空格：标题是一行，换行与制表在 tab 上没有意义；
 * - 按显示宽度截断并加省略号。
 */
export function sanitizeTitleText(raw: string): string {
  /* eslint-disable-next-line no-control-regex -- 删控制字符正是本函数的职责 */
  const noCtrl = raw.replace(/[\x00-\x1f\x7f]/g, ' ');
  const flat = noCtrl.replace(/;/g, '：').replace(/\s+/g, ' ').trim();
  let width = 0;
  let out = '';
  for (const ch of flat) {
    const w = charWidth(ch);
    if (width + w > TITLE_MAX_WIDTH) return `${out}…`;
    width += w;
    out += ch;
  }
  return out;
}

/**
 * 构造写入终端的完整序列。空标题产出「清空标题」序列（退出恢复用，让终端回落自身默认）。
 *
 * tmux / screen 内需要 DCS passthrough：外层包 `\x1bPtmux;` … `\x1b\\`，
 * 且内部所有 ESC 必须双写（tmux 用它区分「透传内容」与「自己的序列结束」）。
 * 注意 tmux 3.3+ 还要求 `set -g allow-passthrough on`，那是用户侧配置，我们无法代设。
 */
export function buildTitleSequence(
  title: string,
  env: Record<string, string | undefined>,
): string {
  const safe = title === '' ? '' : sanitizeTitleText(title);
  const base = `\x1b]0;${safe}\x07`;
  const inMultiplexer = env['TMUX'] !== undefined || (env['TERM'] ?? '').startsWith('screen');
  if (!inMultiplexer) return base;
  const escaped = base.replace(/\x1b/g, '\x1b\x1b');
  return `\x1bPtmux;${escaped}\x1b\\`;
}

/** 给标题加统一前缀（空标题不加，那是清空语义）。 */
export function withTitlePrefix(title: string): string {
  return title === '' ? '' : `${TITLE_PREFIX}${title}`;
}

/**
 * 终端标题写入器：持有能力判定结果与写出通道。
 *
 * 之所以做成对象而非裸函数：能力探测只需在启动时做一次，且 enabled=false 时
 * 后续所有调用都应是零成本的空操作（不重复读 env、不构造序列）。
 */
export class TerminalTitleWriter {
  private readonly enabled: boolean;

  constructor(
    private readonly env: Record<string, string | undefined>,
    isTTY: boolean | undefined,
    /** config 层开关（[tui] terminal_title = false 时关闭）。 */
    configEnabled: boolean,
    private readonly write: (s: string) => void,
  ) {
    this.enabled = configEnabled && canSetTerminalTitle(env, isTTY);
  }

  /** 设置标题（自动加前缀）。未启用时空操作。 */
  set(title: string): void {
    if (!this.enabled) return;
    const text = withTitlePrefix(title);
    if (text === '') return;
    this.write(buildTitleSequence(text, this.env));
  }

  /**
   * 清空标题（退出时调用），让终端回落到自身默认（shell 名或 profile 名）。
   *
   * 为什么不「恢复原标题」：读取原标题没有跨终端一致的机制（OSC 21 查询响应
   * 各家实现不一），读不到就无从恢复。发空标题是业界通行做法，且多数 shell 的
   * 提示符钩子会在下一个提示时重设标题，实际观感等同恢复。
   */
  reset(): void {
    if (!this.enabled) return;
    this.write(buildTitleSequence('', this.env));
  }
}
