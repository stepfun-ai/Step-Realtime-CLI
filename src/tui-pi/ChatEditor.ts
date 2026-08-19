/**
 * ChatEditor：pi-tui Editor 的子类，把 Esc 与 Ctrl+C 的判定权交回控制器。
 *
 * Editor 内部对 escape 的唯一用途是关闭自动补全菜单，故在子类里先问控制器、
 * 控制器不处理再交给父类，两边语义都不破坏。Ctrl+C 父类也是交回父级，这里接住。
 */
import {
  Editor,
  type EditorOptions,
  type EditorTheme,
  matchesKey,
  truncateToWidth,
  type TUI,
  visibleWidth,
} from '@earendil-works/pi-tui';

/**
 * 输入提示符。用 `›`（U+203A）：比 `>` 窄一格，不与正文引用块（`>`）或 diff 标记混淆。
 */
export const PROMPT_SYMBOL = '› ';
/** 提示符占用的列数（`›` 是窄字符，加一个空格共 2 列）。 */
export const PROMPT_WIDTH = 2;
/** paddingX 产生的行首空白，render 里用它定位要覆盖的那几列。 */
const PROMPT_PAD = ' '.repeat(PROMPT_WIDTH);
/**
 * pi-tui 画光标用的反显序列（实测 2026-08-16）。占位文案要插在它之后，
 * 否则会挤在光标前面看着像已输入的内容。
 */
const CURSOR_SEQ = '\x1b[7m \x1b[0m';

export class ChatEditor extends Editor {
  /** 返回 true 表示控制器已消费这次 Esc，不再下传给编辑器。 */
  onEscapeKey?: () => boolean;
  /** 返回 true 表示控制器已消费这次 Ctrl+C。 */
  onCtrlC?: () => boolean;
  /**
   * Ctrl+V：读剪贴板图片。返回 true 表示已消费。
   *
   * 终端里的 Ctrl+V 通常不是「粘贴」——粘贴由终端软件处理并以 bracketed paste 送进来，
   * Ctrl+V 这个按键本身原样到达应用，故借作贴图入口。
   */
  onCtrlV?: () => boolean;
  /**
   * Alt+V：同 onCtrlV 的另一个入口。Alt+V 是主仓原键位；Ctrl+V 兜住 Alt 被终端/窗口管理器吃掉的场景
   * （macOS Option 作组字键、部分 Linux 桌面把 Alt 拿去拖窗口）。
   * 实测两种模式下 Alt+V 都解析为 `alt+v`，不会被误判成 `escape`，故 Esc 语义不受影响。
   */
  onAltV?: () => boolean;
  /**
   * Ctrl+B：把前台工具任务转后台（释放等待，进程继续跑）。返回 true 表示已消费。
   * Editor 父类不用这个键位，接住它不破坏编辑语义。
   */
  onCtrlB?: () => boolean;
  /**
   * Ctrl+O：打开全屏查看器（展开被折叠的工具输出与长 thinking）。
   * 返回 true 表示已消费（有可展开内容）；false 让按键下传。
   */
  onCtrlO?: () => boolean;
  /**
   * Ctrl+G：拉起外部编辑器写长 prompt。
   * 返回 true 表示已消费（编辑器启动成功）；false 让按键下传。
   *
   * 主流终端编码 agent 的通行能力。终端输入框写长 prompt / 多行代码是痛点，
   * 外部编辑器是公认解法。返回 false 的典型场景：$EDITOR 未配置且找不到 fallback。
   */
  onCtrlG?: () => boolean;
  /**
   * Ctrl+S：主动插队——把队列里的草稿与输入框文本注入运行中的回合（step 边界生效）。
   * 无事可做（空闲/队列空）也返回 true 消费掉：Ctrl+S 在历史终端上是 XOFF 流控键，
   * 让它漏出去用户会以为终端卡死。
   */
  onCtrlS?: () => boolean;
  /**
   * ↑：busy + 空输入时取回队列尾部一条进输入框编辑。
   *
   * 返回 true 表示已消费（队列非空且取回成功）；false 让按键下传父类做历史导航。
   * 只在 busy + 输入框空时生效——空闲时 ↑ 走正常历史回溯（如果有的话）。
   */
  onUpArrow?: () => boolean;
  /**
   * 除 Esc / Ctrl+C 之外的任意按键。用于解除双击确认（primed）态。
   *
   * 不设返回值：它永远不消费按键，只是个旁路通知——按键仍走正常处理链。
   */
  onOtherKey?: () => void;
  /**
   * 自动补全菜单是否打开。Editor 的补全状态是私有字段，外部读不到；M4 接补全时由
   * provider 侧回填这个标记，M1 阶段没有 provider，恒为 false。
   */
  autocompleteOpen = false;
  /**
   * 提示符着色：由控制器按 busy 状态换（busy 黄、空闲灰）。默认原样返回，
   * 测试与不着色场景下输出可读的纯文本。
   */
  promptStyle: (s: string) => string = (s) => s;
  /**
   * 空输入时显示的占位文案（返回空串表示不显示）。
   *
   * 定义成函数而不是字符串字段，与 `promptStyle` 同构：控制器绑一次、内部读 busy，
   * 不需要在每个状态切换点回写一遍（漏一处就出现文案与状态不符）。
   *
   * busy 态那句（「思考中…输入将加入发送队列」）是**行为说明**：此时打字会进
   * 发送队列而非立刻发出，不说用户不知道。
   */
  placeholderText: () => string = () => '';
  /** 占位文案着色，默认原样。 */
  placeholderStyle: (s: string) => string = (s) => s;
  /**
   * 输入框下方的一行瞬时提示（primed 态用）。返回空串表示不占行。
   *
   * 为什么不用转录区的 note：primed 是**瞬时状态**（5 秒自动过期），note 会永久留在
   * 历史里；下方瞬时提示跟着状态走，状态没了行也没了。
   */
  footerText: () => string = () => '';
  /** 下方提示行的着色，默认原样。 */
  footerStyle: (s: string) => string = (s) => s;

  constructor(tui: TUI, theme: EditorTheme, options?: EditorOptions) {
    // paddingX 固定 2：给提示符腾出 '› ' 的两列。选它而非渲染后整行拼前缀，是因为
    // paddingX 只给内容行加缩进，折行后的续行同样带这 2 列缩进，正好「续行对齐到提示符之后」。
    // 自己拼前缀则要同时改边框宽度与续行缩进，等于重复父类的折行逻辑。
    super(tui, theme, { ...options, paddingX: options?.paddingX ?? PROMPT_WIDTH });
  }

  /**
   * 在首个内容行画提示符。
   *
   * 光标是父类用**反显字符**（`\x1b[7m \x1b[0m`）画进行内容里的，不是终端真实光标定位
   * （实测确认），所以在行首覆盖字符不会让光标错位——这是能这么简单实现的前提。
   *
   * 覆盖而非插入：paddingX 已经在每个内容行前放了 PROMPT_WIDTH 个空格，这里只把首行
   * 那几个空格换成提示符，行宽与边框都不变。续行留空，形成缩进对齐。
   */
  override render(width: number): string[] {
    const lines = super.render(width);
    // 结构是「上边框 + ≥1 内容行 + 下边框」。少于 3 行说明父类结构变了，原样返回不猜。
    if (lines.length < 3) return lines;
    const first = lines[1]!;
    if (!first.startsWith(PROMPT_PAD)) return lines; // padding 被外部改过，不硬塞
    lines[1] = this.promptStyle(PROMPT_SYMBOL) + this.withPlaceholder(first, width).slice(PROMPT_PAD.length);
    // 提示行加在下边框之外而不是框内：primed 是瞬时态（5 秒过期），画在框内会让输入框
    // 高度抖一下再抖回来，差分渲染下整块重绘；框外多一行只影响它自己。
    const footer = this.footerText();
    if (footer !== '') lines.push(this.footerStyle(truncateToWidth(footer, Math.max(1, width))));
    return lines;
  }

  /**
   * 空输入时把占位文案画在光标之后。
   *
   * 依赖 pi-tui 用反显字符（`\x1b[7m \x1b[0m`）表示光标这一实现细节：找到那段序列，
   * 在它之后插入文案，再从行尾裁掉等显示宽度的空白，**行宽保持不变**——差分渲染按行
   * 比对，行宽变了会牵连边框对齐。
   *
   * 找不到光标序列（pi-tui 换了光标画法）时原样返回：宁可没有占位文案，也不要插错位置
   * 把输入行画坏。
   */
  private withPlaceholder(line: string, width: number): string {
    const ph = this.placeholderText();
    if (ph === '' || this.getText() !== '') return line;
    const at = line.indexOf(CURSOR_SEQ);
    if (at < 0) return line;
    const insertAt = at + CURSOR_SEQ.length;
    const head = line.slice(0, insertAt);
    const tail = line.slice(insertAt);
    // 可用宽度 = 总宽 - 提示符 - 光标 1 列；再留 1 列余量，避免正好顶到右边框
    const room = width - PROMPT_WIDTH - 1 - 1;
    if (room <= 0) return line;
    const text = truncateToWidth(ph, room, '…');
    const w = visibleWidth(text);
    // 尾部是父类补的空白，裁掉与文案等宽的部分即可保持行宽
    const trimmed = tail.length >= w ? tail.slice(w) : '';
    return head + this.placeholderStyle(text) + trimmed;
  }

  /**
   * PasteBurst 爆发窗口的截止时间戳。无 bracketed paste 的终端上，粘贴以高速击键流
   * 到达，其中的 \r 会被父类当成 Enter 提交——粘贴到一半就把半成品发出去。
   * 散装文本块（见 handleInput 第一分支）到达时开窗，窗口内单独到达的 \r 视为换行。
   */
  private burstEndsAt = 0;
  /** 含换行的散装文本块至少这么长才按粘贴处理（短段可能是正常多键序列）。 */
  private static readonly BURST_MIN_CHUNK = 8;
  /** 爆发窗口长度：覆盖粘贴尾块与最后一个 \r 分开到达的间隔。 */
  private static readonly BURST_WINDOW_MS = 150;

  override handleInput(data: string): void {
    // PasteBurst 兜底一：含换行的散装文本块（无转义序列）必是粘贴——键盘输入的
    // Enter 永远单独到达，不会夹在文本块里。按行拆开逐段喂给父类，换行符换成 '\n'
    // 走父类的换行分支（直接插原块会把 \r 原样塞进缓冲区）。
    if (
      data.length >= ChatEditor.BURST_MIN_CHUNK &&
      !data.includes('\x1b') &&
      /[\r\n]/.test(data)
    ) {
      this.burstEndsAt = Date.now() + ChatEditor.BURST_WINDOW_MS;
      const parts = data.split(/\r\n|[\r\n]/);
      parts.forEach((part, i) => {
        if (part !== '') super.handleInput(part);
        if (i < parts.length - 1) super.handleInput('\n');
      });
      return;
    }
    // PasteBurst 兜底二：爆发窗口内单独到达的 Enter 是粘贴流的一部分，换行而非提交。
    if (data === '\r' && Date.now() < this.burstEndsAt) {
      super.handleInput('\n');
      return;
    }
    // primed 态解除：除 Esc 与 Ctrl+C 外的任意按键都解除双击确认态。
    //
    // 放在所有分支之前、且不 return——这次按键仍要按下面的正常逻辑处理。两个 primed
    // 各自的触发键要放行（Esc 之于 backtrack、Ctrl+C 之于 exit），否则第二次按下时
    // 会先被这里解除，双击永远走不到执行分支。
    if (!matchesKey(data, 'escape') && !matchesKey(data, 'ctrl+c')) {
      this.onOtherKey?.();
    }
    if (matchesKey(data, 'escape')) {
      // 补全菜单开着时 Esc 归菜单，不中断回合
      if (!this.autocompleteOpen && this.onEscapeKey?.() === true) return;
    }
    if (matchesKey(data, 'ctrl+c')) {
      if (this.onCtrlC?.() === true) return;
    }
    if (matchesKey(data, 'ctrl+v')) {
      if (this.onCtrlV?.() === true) return;
    }
    // alt+v 放在 escape 判定之后：legacy 下二者的字节序列都以 \x1b 开头，但 pi-tui 只把
    // 单独到达的 \x1b 认作 escape，`\x1bv` 直接解析为 alt+v，两条判定互不干扰（有实测）。
    if (matchesKey(data, 'alt+v')) {
      if (this.onAltV?.() === true) return;
    }
    if (matchesKey(data, 'ctrl+b')) {
      if (this.onCtrlB?.() === true) return;
    }
    if (matchesKey(data, 'ctrl+o')) {
      if (this.onCtrlO?.() === true) return;
    }
    if (matchesKey(data, 'ctrl+g')) {
      if (this.onCtrlG?.() === true) return;
    }
    if (matchesKey(data, 'ctrl+s')) {
      if (this.onCtrlS?.() === true) return;
    }
    if (matchesKey(data, 'up')) {
      if (this.onUpArrow?.() === true) return;
    }
    super.handleInput(data);
  }
}
