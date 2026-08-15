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
import { Editor, type EditorOptions, type EditorTheme, matchesKey, type TUI } from '@earendil-works/pi-tui';

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

  constructor(tui: TUI, theme: EditorTheme, options?: EditorOptions) {
    super(tui, theme, options);
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
    if (matchesKey(data, 'ctrl+b')) {
      if (this.onCtrlB?.() === true) return;
    }
    if (matchesKey(data, 'ctrl+o')) {
      if (this.onCtrlO?.() === true) return;
    }
    super.handleInput(data);
  }
}
