/**
 * ChatEditor：pi-tui Editor 的子类，把 Esc 与 Ctrl+C 的判定权交回控制器。
 *
 * 为什么要子类而不是全局 addInputListener（实测结论第一、三条）：
 * 全局钩子确实先于焦点组件执行，但 Esc 的语义依赖状态（busy 中断 / 空闲取回队列 /
 * 补全菜单关闭），写进全局钩子等于把状态机搬到输入层。Editor 内部对 escape 唯一的用途是
 * 关闭自动补全菜单（键位 tui.select.cancel 默认绑定 escape 与 ctrl+c），所以在子类里先问
 * 控制器、控制器不处理再交给父类，两边语义都不破坏。
 *
 * Ctrl+C 同理：父类对它的处理就是 `return`（交给父级），我们在这里接住。
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
 * 输入提示符。用 `›`（U+203A）与 Ink 版 `PromptInput` 一致——它比 `>` 窄一格的视觉重量，
 * 不会跟正文里的引用块（`>`）或 diff 标记混淆。
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
   * 终端里的 Ctrl+V 通常不是「粘贴」——粘贴由终端软件自己处理并以 bracketed paste
   * 的形式送进来，Ctrl+V 这个按键本身会原样到达应用。Ink 版据此把它用作贴图入口，
   * 这里沿用同一约定。
   */
  onCtrlV?: () => boolean;
  /**
   * Alt+V：读剪贴板图片，与 `onCtrlV` 同一动作、两个入口。
   *
   * Ink 版主仓的贴图键位其实是 **Alt+V**（`App.tsx` 的 `meta.meta && key === 'v'`），
   * 迁移时只接了 Ctrl+V，于是照肌肉记忆按 Alt+V 的人得到「贴图功能不存在」的结论。
   * 两个都留：Alt+V 对齐 Ink 版习惯，Ctrl+V 保留给 Alt 被终端/窗口管理器吃掉的场景
   * （macOS 的 Option 默认作为组字键、部分 Linux 桌面把 Alt 拿去拖窗口）。
   *
   * 键位识别实测（`parseKey`，2026-08-16）：legacy 模式下 Alt+V 送的是 `ESC` + `v`，
   * pi-tui 解析为 `alt+v` 且**不会**误判成 `escape`（`\x1b` 单独到达才是 escape）；
   * kitty 协议激活时送 `\x1b[118;3u`，同样解析为 `alt+v`。所以 Esc 的中断语义不受影响。
   * 另有一条局限：Alt+Shift+V（`ESC` + `V`）两种模式下都解析为 undefined，不接。
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
   * 自动补全菜单是否打开。Editor 的补全状态是私有字段，外部读不到；M4 接补全时由
   * provider 侧回填这个标记，M1 阶段没有 provider，恒为 false。
   */
  autocompleteOpen = false;
  /**
   * 提示符着色：由控制器按 busy 状态换（Ink 版 busy 黄、空闲灰）。默认原样返回，
   * 测试与不着色场景下输出可读的纯文本。
   */
  promptStyle: (s: string) => string = (s) => s;
  /**
   * 空输入时显示的占位文案（返回空串表示不显示）。
   *
   * 定义成函数而不是字符串字段，与 `promptStyle` 同构：控制器绑一次、内部读 busy，
   * 不需要在每个状态切换点回写一遍（漏一处就出现文案与状态不符）。
   *
   * busy 态那句（「思考中…输入将加入发送队列」）是**行为说明**而非装饰：此时打字会进
   * 发送队列而不是立刻发出，不说用户不知道。Ink 版一直有这两句文案，pi 版迁移时没接。
   */
  placeholderText: () => string = () => '';
  /** 占位文案着色，默认原样。 */
  placeholderStyle: (s: string) => string = (s) => s;

  constructor(tui: TUI, theme: EditorTheme, options?: EditorOptions) {
    // paddingX 固定 2：给提示符腾出 '› ' 的两列。选它而不是「渲染后整行拼前缀」的理由是
    // 实测（2026-08-16）——paddingX 只给**内容行**加缩进，边框行宽度不动，且折行后的
    // 续行同样带这 2 列缩进（宽字符也算对），正好复刻 Ink 版「续行对齐到提示符之后」。
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

  override handleInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      // 补全菜单开着时 Esc 归菜单（与 Ink 版「输入框是斜杠命令时 Esc 关菜单、不中断回合」同义）
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
    super.handleInput(data);
  }
}
