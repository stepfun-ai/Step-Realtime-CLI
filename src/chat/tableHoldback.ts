/**
 * 流式表格扣留（table holdback）。
 *
 * 问题：流式渲染时 pipe-table 一边吐一边渲染，每来一行新行所有列宽都可能变，
 * 已显示的表格反复重排闪跳。成熟实现（Rust TUI agent）的做法是检测到表头+分隔行后
 * 把表格内容扣在可变尾部直到流结束；我们没有可变尾部区，故变体为「扣在文本层」：
 * 疑似表格起点（`|` 开头的完整行）之后的内容不进转录区，直到表格结束
 * （第一条非 `|` 开头的完整行/空行）或流被 flush。
 *
 * 误判代价：一个恰好以 `|` 开头的普通行会被扣到下一行到达才显示——瞬间延迟，可接受。
 * 半截行处理：未扣留时照常透传（不打断逐字流的感觉）；扣留期间半截行必须扣住
 * （行没吐完列宽未知）。
 */

/** 表格行（含分隔行）：允许前导空白，第一个非空白字符是 |。 */
const TABLE_ROW = /^\s*\|/;

export class TableHoldback {
  private buf = '';
  private holding = false;

  /** 喂入流式增量，返回可立即显示的部分（可能为空串）。 */
  feed(text: string): string {
    this.buf += text;
    return this.drain();
  }

  /** 流被打断/结束（工具调用、中断、回合收尾）：扣留内容全部放出。 */
  flush(): string {
    const out = this.buf;
    this.buf = '';
    this.holding = false;
    return out;
  }

  /** 是否正扣着内容（调用方判断有没有必要 flush）。 */
  get active(): boolean {
    return this.buf !== '';
  }

  private drain(): string {
    if (!this.holding) {
      const lines = this.buf.split('\n');
      const complete = lines.slice(0, -1);
      const tail = lines[lines.length - 1]!;
      // 疑似表格起点 = 完整行末尾连续的 | 行段的第一行。必须整段扣住：表格闪跳源于
      // 列宽随新行反复变化，只扣最后一行的话，先到的表头/分隔行已经显示、照样重排。
      let start = -1;
      for (let i = complete.length - 1; i >= 0; i--) {
        if (TABLE_ROW.test(complete[i]!)) start = i;
        else break;
      }
      if (start === -1) {
        // 无疑似表格：全部透传（含半截行，保持逐字流手感）
        const out = this.buf;
        this.buf = '';
        return out;
      }
      // 起点前的内容放行，起点起（含半截 tail）扣留
      const released = complete.slice(0, start).join('\n') + (start > 0 ? '\n' : '');
      this.buf = complete.slice(start).join('\n') + '\n' + tail;
      this.holding = true;
      return released;
    }
    // 扣留中：找第一条非表格完整行（含空行）作表格结束
    const lines = this.buf.split('\n');
    const complete = lines.slice(0, -1);
    const tail = lines[lines.length - 1]!;
    let end = -1;
    for (let i = 0; i < complete.length; i++) {
      if (!TABLE_ROW.test(complete[i]!)) {
        end = i;
        break;
      }
    }
    if (end === -1) return ''; // 还在表里（或表尾未到），全扣
    // 放行到表格结束行为止（含该行），剩余按未扣留重新走一遍（可能又撞见新表格）
    const released = complete.slice(0, end + 1).join('\n') + '\n';
    const rest = complete.slice(end + 1).join('\n') + (complete.length > end + 1 ? '\n' : '') + tail;
    this.buf = '';
    this.holding = false;
    if (rest === '') return released;
    this.buf = rest;
    return released + this.drain();
  }
}
