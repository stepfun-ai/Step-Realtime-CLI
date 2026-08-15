/**
 * 逐行 diff 计算与聚类渲染，供 edit_file 的结果预览使用。
 *
 * 用 LCS（最长公共子序列）动态规划求出旧/新文本的行级差异，产出 context/add/delete
 * 三类带行号的 DiffLine；再按「改动 + 少量上下文」聚类，簇间用「… N unchanged lines …」
 * 省略，超过 maxLines 时截断并附「… N more changes hidden」。
 *
 * 输出为纯文本行（不含 ANSI）：上色由渲染层（ToolCall）按行首标记处理，
 * 这样非 TTY / 管道场景不会被 ANSI 污染，diff 文本也可直接进 tool_result 回灌模型。
 */

export type DiffLineKind = 'context' | 'add' | 'delete';

export interface DiffLine {
  kind: DiffLineKind;
  /** 行号：add/context 用新文件行号，delete 用旧文件行号。 */
  lineNum: number;
  code: string;
}

/** LCS 逐行 diff。返回按新文件顺序排列的 DiffLine 序列。 */
export function computeDiffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const m = oldLines.length;
  const n = newLines.length;

  // dp[i][j] = oldLines[0..i) 与 newLines[0..j) 的 LCS 长度
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1]![j - 1]! + 1
          : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }

  // 回溯：从右下角走到左上角，逆序收集
  const reversed: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      reversed.push({ kind: 'context', lineNum: j, code: newLines[j - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      reversed.push({ kind: 'add', lineNum: j, code: newLines[j - 1]! });
      j--;
    } else {
      reversed.push({ kind: 'delete', lineNum: i, code: oldLines[i - 1]! });
      i--;
    }
  }

  return reversed.reverse();
}

export interface DiffRenderOptions {
  /** 每簇改动前后保留的上下文行数，默认 3。 */
  contextLines?: number;
  /** diff 主体最多输出多少行，超出截断。undefined = 不限制。 */
  maxLines?: number;
  /** 展开提示里的按键名，默认 Ctrl+O。 */
  expandKeyHint?: string;
  /** 调用方接收截断元信息：是否发生截断、被隐藏的改动行数（供替换提示文案）。 */
  result?: { truncated: boolean; hidden: number };
}

interface Cluster {
  start: number;
  end: number;
}

/** 把改动行按上下文距离聚类：相邻改动（间隔 ≤ 2×contextLines）并成一簇。 */
function buildClusters(diffLines: DiffLine[], contextLines: number): Cluster[] {
  const changeIdx: number[] = [];
  diffLines.forEach((l, idx) => {
    if (l.kind !== 'context') changeIdx.push(idx);
  });
  if (changeIdx.length === 0) return [];

  const clusters: Cluster[] = [];
  const mergeGap = 2 * contextLines;
  let groupStart = changeIdx[0]!;
  let groupEnd = changeIdx[0]!;
  for (let k = 1; k < changeIdx.length; k++) {
    const idx = changeIdx[k]!;
    if (idx - groupEnd <= mergeGap) {
      groupEnd = idx;
    } else {
      clusters.push({
        start: Math.max(0, groupStart - contextLines),
        end: Math.min(diffLines.length - 1, groupEnd + contextLines),
      });
      groupStart = idx;
      groupEnd = idx;
    }
  }
  clusters.push({
    start: Math.max(0, groupStart - contextLines),
    end: Math.min(diffLines.length - 1, groupEnd + contextLines),
  });
  return clusters;
}

function formatRow(line: DiffLine): string {
  const gutter = String(line.lineNum).padStart(4) + ' ';
  if (line.kind === 'add') return `${gutter}+ ${line.code}`;
  if (line.kind === 'delete') return `${gutter}- ${line.code}`;
  return `${gutter}  ${line.code}`;
}

/**
 * 渲染带上下文的聚类 diff。首行是摘要 `+N -M path`，随后是各改动簇
 * （簇内含上下文行），簇间以「… N unchanged lines …」省略，
 * 超过 maxLines 时在簇边界或簇内截断并附「… N more changes hidden」。
 */
export function renderDiffClustered(
  oldText: string,
  newText: string,
  path: string,
  opts: DiffRenderOptions = {},
): string[] {
  const contextLines = opts.contextLines ?? 3;
  const maxLines = opts.maxLines;
  const hint = opts.expandKeyHint ?? 'Ctrl+O';

  const diffLines = computeDiffLines(oldText, newText);
  const clusters = buildClusters(diffLines, contextLines);
  const changedCount = diffLines.filter((l) => l.kind !== 'context').length;
  const addedCount = diffLines.filter((l) => l.kind === 'add').length;
  const removedCount = diffLines.filter((l) => l.kind === 'delete').length;

  const out: string[] = [];
  let header = '';
  if (addedCount > 0) header += `+${addedCount} `;
  if (removedCount > 0) header += `-${removedCount} `;
  header += path;
  out.push(header);

  if (clusters.length === 0) return out; // 无改动（理论上 edit 成功不会出现）

  const cap = maxLines !== undefined && maxLines >= 0 ? maxLines : Number.POSITIVE_INFINITY;
  let body = 0;
  let prevEnd = -1;
  let truncated = false;
  let shownChanges = 0;

  outer: for (const cluster of clusters) {
    if (body >= cap) {
      truncated = true;
      break;
    }
    if (prevEnd >= 0) {
      const gap = cluster.start - prevEnd - 1;
      if (gap > 0) {
        if (body + 1 > cap) {
          truncated = true;
          break;
        }
        out.push(`     … ${gap} unchanged line${gap > 1 ? 's' : ''} …`);
        body++;
      }
    }
    for (let idx = cluster.start; idx <= cluster.end; idx++) {
      if (body >= cap) {
        truncated = true;
        break outer;
      }
      const line = diffLines[idx]!;
      out.push(formatRow(line));
      body++;
      if (line.kind !== 'context') shownChanges++;
      prevEnd = idx;
    }
  }

  if (truncated) {
    const hidden = changedCount - shownChanges;
    if (opts.result) {
      opts.result.truncated = true;
      opts.result.hidden = hidden;
    }
    if (hidden > 0) {
      out.push(`     … ${hidden} more change${hidden > 1 ? 's' : ''} hidden (${hint} to expand)`);
    }
  }

  return out;
}
