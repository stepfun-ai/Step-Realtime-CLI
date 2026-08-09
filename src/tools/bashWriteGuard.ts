/**
 * bashWriteGuard — 纯函数模块，对 bash 命令字符串做静态写入目标检查。
 *
 * 三档判定：
 *   A：可解析且越界 → 拒绝（tier: 'A'）
 *   B：有写入迹象但目标不可解析 → 拒绝（tier: 'B'）
 *   C：无写入迹象 → 放行
 *
 * 生效边界：allowRoot 为 undefined / 空串时一律放行。
 *
 * 不碰 fs / process，无 IO，纯内存计算。
 */

import { resolve, sep, normalize } from 'node:path';

/* ------------------------------------------------------------------ */
/*  类型定义                                                          */
/* ------------------------------------------------------------------ */

export type CheckResult =
  | { ok: true }
  | { ok: false; reason: string; tier: 'A' | 'B' };

/* ------------------------------------------------------------------ */
/*  工具函数                                                          */
/* ------------------------------------------------------------------ */

/**
 * 丢弃型特殊设备：写它们不产生任何文件，必须放行。
 *
 * 不加这条白名单的话，`cmd > /dev/null`（以及 `2>/dev/null`、`&>/dev/null`）会因为
 * /dev/null 被解析成绝对路径而判成 A 档越界。这是最常见的丢弃输出写法，误报会直接
 * 卡住正常命令——接线前实测 21 条 worker 典型命令，唯一被误拦的就是 `ls -la > /dev/null`。
 * /dev/fd/N 与 /proc/self/fd/N 一并放行：它们是文件描述符别名，不是文件路径。
 */
const DISCARD_DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', 'nul', 'NUL']);

function isDiscardDevice(rawToken: string): boolean {
  let t = rawToken.trim().replace(/\s+#.*$/, '').trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    t = t.slice(1, -1);
  }
  if (DISCARD_DEVICES.has(t)) return true;
  return /^\/dev\/fd\/\d+$/.test(t) || /^\/proc\/self\/fd\/\d+$/.test(t);
}

/** 判断 target 是否在 allowRoot 内（含 allowRoot 自身）。防兄弟前缀陷阱。 */
function isUnderAllowRoot(target: string, allowRoot: string): boolean {
  const normTarget = normalize(target);
  const normRoot   = normalize(allowRoot);
  if (normTarget === normRoot) return true;
  if (!normTarget.startsWith(normRoot + sep)) return false;
  const after = normTarget.slice(normRoot.length);
  return after.startsWith(sep) || after.length === 0;
}

/** 将原始 token 归一到绝对路径（支持 Windows 原生路径与 Git Bash 路径）。 */
function resolveTarget(cwd: string, rawToken: string): string | undefined {
  let token = rawToken.trim();
  // 剥离尾部内联注释
  token = token.replace(/\s+#.*$/, '').trim();
  // 剥离外层单引号 / 双引号
  if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) {
    token = token.slice(1, -1);
  }
  if (!token) return undefined;

  // Windows 原生绝对路径：C:\... 或 C:/...
  if (/^[A-Za-z]:[/\\]/.test(token)) {
    return resolve(token);
  }

  // Git Bash 风格绝对路径：/c/Users/... /d/... 等（单字母盘符）
  if (/^\/([A-Za-z])\//.test(token)) {
    const drive = token[1]!.toUpperCase();
    const rest  = token.slice(2).replace(/\//g, '\\');
    return resolve(`${drive}:\\${rest}`);
  }

  // POSIX / Git Bash 绝对路径（非单字母盘符，如 /home/user、/tmp）
  if (token.startsWith('/')) {
    return resolve(token);
  }

  // 相对路径 / ~ 展开
  if (token.startsWith('.') || token.startsWith('~') || !token.startsWith('-')) {
    return resolve(cwd, token);
  }

  return undefined;
}

/** 判断一段文本是否含有明确的重定向操作符（引号内的不算）。 */
function hasRedirectOp(seg: string): boolean {
  let inSq = false, inDq = false, escape = false;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && !inSq) { escape = true; continue; }
    if (ch === "'" && !inDq) { inSq = !inSq; continue; }
    if (ch === '"' && !inSq) { inDq = !inDq; continue; }
    if (inSq || inDq) continue;
    if (ch === '<' && i + 1 < seg.length && seg[i + 1] === '<') return true; // heredoc
    if (ch === '>') return true;
  }
  return false;
}

/** 检测段内是否有动态路径特征（变量、命令替换、eval）。 */
function hasDynamicPath(seg: string): boolean {
  const stripped = seg.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
  return /\$\w+/.test(stripped) || /\$\{/.test(stripped) || /\$\(/.test(stripped) || /\beval\b/.test(stripped);
}

/**
 * 该段是否有写入意图。用于给动态路径判定加门槛：
 * 只含变量而无写入迹象的只读命令（`ls $HOME`、`grep "$PAT" f`）必须放行，
 * 否则 worker 场景下大面积误拦，比漏拦更伤可用性。
 * eval 单独算写入迹象——它能执行任意内容，且其引号内的 `>` 不被 hasRedirectOp 识别。
 */
function hasWriteIntent(seg: string): boolean {
  return (
    hasRedirectOp(seg) ||
    /\b(?:tee|cp|mv|rm|truncate|install|dd)\b/.test(seg) ||
    (/\bsed\b/.test(seg) && /\s+-i\b/.test(seg)) ||
    /\beval\b/.test(seg)
  );
}

/** 检测内联解释器代码中的写入迹象。 */
function extractInlineCode(seg: string): string | undefined {
  // node 用 -e，python 用 -c，perl 两者皆可——三个都要认，漏一个就是漏一条绕过路径。
  const m = /(?:python3?|node|perl)\s+(?:-c|-e|--eval)\s+['"]?(.+?)['"]?\s*$/.exec(seg);
  return m?.[1];
}

function inlineHasWrite(code: string): boolean {
  const lower = code.toLowerCase();
  return (
    lower.includes('open(') ||
    lower.includes('writefilesync') ||
    lower.includes('writefile') ||
    lower.includes('fs.write') ||
    lower.includes('fs.append') ||
    /[^&]>/.test(lower) ||
    lower.includes('tee')
  );
}

/* ------------------------------------------------------------------ */
/*  命令分拆                                                          */
/* ------------------------------------------------------------------ */

interface Segment {
  text: string;
}

/** 按引号感知拆出命令段（分隔符：|, &&, ||, ;）。 */
function splitSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  let cur = '';
  let inSq = false, inDq = false, escape = false;

  const flush = () => {
    if (cur.trim()) segments.push({ text: cur });
    cur = '';
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escape) { cur += ch; escape = false; continue; }
    if (ch === '\\' && !inSq) { cur += ch; escape = true; continue; }
    if (ch === "'" && !inDq) { inSq = !inSq; cur += ch; continue; }
    if (ch === '"' && !inSq) { inDq = !inDq; cur += ch; continue; }
    if (!inSq && !inDq) {
      if (ch === '|' && (i === 0 || command[i - 1] !== '&')) { flush(); continue; }
      if ((ch === ';' || ch === '&') && i + 1 < command.length && command[i + 1] === ch) {
        flush(); i++; continue; // && / || 当作分隔符
      }
      if ((ch === ';' || ch === '&') && (i + 1 >= command.length || command[i + 1] !== ch)) {
        flush(); continue; // ; 或单个 & 当作分隔符
      }
    }
    cur += ch;
  }
  flush();
  return segments;
}

/* ------------------------------------------------------------------ */
/*  目标提取                                                          */
/* ------------------------------------------------------------------ */

/** 提取重定向目标（>、>>、n>）。heredoc 分隔符不算文件路径。 */
function extractRedirectTargets(seg: string): string[] {
  const targets: string[] = [];
  let inSq = false, inDq = false, escape = false;

  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && !inSq) { escape = true; continue; }
    if (ch === "'" && !inDq) { inSq = !inSq; continue; }
    if (ch === '"' && !inSq) { inDq = !inDq; continue; }
    if (inSq || inDq) continue;

    // heredoc << 分隔符不是文件路径，跳过
    if (ch === '<' && i + 1 < seg.length && seg[i + 1] === '<') {
      i++; // 跳过第二个 <，后续是 heredoc 标记
      continue;
    }

    if (ch === '>') {
      let j = i - 1;
      while (j >= 0 && /[\d&]/.test(seg[j])) j--;
      i++; // 跳过 >
      if (i < seg.length && seg[i] === '>') i++; // 跳过第二个 >（>>）
      while (i < seg.length && /\s/.test(seg[i])) i++;
      const start = i;
      if (i < seg.length && (seg[i] === "'" || seg[i] === '"')) {
        const quote = seg[i]; i++;
        while (i < seg.length && seg[i] !== quote) i++;
        if (i > start) targets.push(seg.slice(start, i));
      } else {
        while (i < seg.length && !/[\s;|&<]/.test(seg[i])) i++;
        if (i > start) targets.push(seg.slice(start, i));
      }
      i--; // 回退，让外层循环继续
    }
  }
  return targets;
}

/** 从段中提取 cp/mv/install 的目标文件路径（最后一个非 flag token）。 */
function extractCommandTarget(seg: string, commandWord: string): string | undefined {
  const idx = seg.indexOf(commandWord);
  if (idx < 0) return undefined;
  const after = seg.slice(idx + commandWord.length);
  const tokens = after.trim().split(/\s+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (!tokens[i]!.startsWith('-')) return tokens[i];
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  cd 基准偏移分析                                                    */
/* ------------------------------------------------------------------ */

interface CdAnalysis {
  effectiveCwd: string;
  escaped: boolean;
}

function analyzeCdPrefix(command: string, baseCwd: string): CdAnalysis {
  let cwd = baseCwd;
  let escaped = false;

  let inSq = false, inDq = false, escape = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (escape) { escape = false; i++; continue; }
    if (ch === '\\' && !inSq) { escape = true; i++; continue; }
    if (ch === "'" && !inDq) { inSq = !inSq; i++; continue; }
    if (ch === '"' && !inSq) { inDq = !inDq; i++; continue; }

    if (!inSq && !inDq && command.slice(i, i + 3) === 'cd ') {
      i += 3;
      while (i < command.length && /\s/.test(command[i])) i++;
      let pathStart = i;
      if (i < command.length && (command[i] === "'" || command[i] === '"')) {
        const quote = command[i]; i++;
        while (i < command.length && command[i] !== quote) i++;
      } else {
        while (i < command.length && !/[\s;|&]/.test(command[i])) i++;
      }
      const cdTarget = command.slice(pathStart, i).trim();
      if (cdTarget) {
        const resolved = resolve(cwd, cdTarget);
        if (!isUnderAllowRoot(resolved, baseCwd)) {
          escaped = true;
          break;
        }
        cwd = resolved;
      }
      continue;
    }
    i++;
  }

  return { effectiveCwd: cwd, escaped };
}

/* ------------------------------------------------------------------ */
/*  主函数：checkBashWrite                                             */
/* ------------------------------------------------------------------ */

/**
 * 检查 bash 命令字符串的写入目标是否在 allowRoot 内。
 */
export function checkBashWrite(
  command: string,
  cwd: string,
  allowRoot: string | undefined,
): CheckResult {
  /* ---- 第 0 条：allowRoot 缺省 → 一律放行 ---- */
  if (!allowRoot || allowRoot.trim() === '') {
    return { ok: true };
  }

  const trimmed = command.trim();
  if (!trimmed) return { ok: true };

  /* ---- 分析 cd 前缀 ---- */
  const cdResult = analyzeCdPrefix(trimmed, cwd);
  const effectiveCwd = cdResult.effectiveCwd;
  const cdEscaped    = cdResult.escaped;

  /* ---- 拆段 ---- */
  const segments = splitSegments(trimmed);

  const writeTargets: string[] = [];
  let dynamicDetected = false;
  let inlineWriteDetected = false;
  let cdEscapedRelativeWrite = false;

  for (const seg of segments) {
    const segText = seg.text.trim();
    if (!segText) continue;

    /* ---- B 档：动态路径（变量 / 命令替换 / eval），仅在该段确有写入迹象时 ---- */
    if (hasDynamicPath(segText) && hasWriteIntent(segText)) {
      dynamicDetected = true;
    }

    /* ---- 内联解释器写入检测 ---- */
    const inlineCode = extractInlineCode(segText);
    if (inlineCode) {
      if (inlineHasWrite(inlineCode)) {
        inlineWriteDetected = true;
      }
      continue; // 内联解释器不提取其他目标
    }

    /* ---- cd 越界后的相对路径写入 → B 档 ---- */
    if (cdEscaped) {
      const hasWriteHere =
        hasRedirectOp(segText) ||
        /\b(?:tee|cp|mv|rm|truncate|install)\b/.test(segText) ||
        (/\bsed\b/.test(segText) && /\s+-i\b/.test(segText)) ||
        (/\bdd\b/.test(segText) && /\bof=/.test(segText));
      if (hasWriteHere) {
        const absMatch = segText.match(/(?:>|<<)\s+([A-Za-z]:[/\\][^\s;|&]+|\/[^\s;|&]+)/);
        if (!absMatch) {
          cdEscapedRelativeWrite = true;
        }
      }
    }

    /* ---- 提取重定向目标 ---- */
    writeTargets.push(...extractRedirectTargets(segText));

    /* ---- 提取 cp / mv / install 目标 ---- */
    for (const cmd of ['cp', 'mv', 'install']) {
      if (new RegExp(`\\b${cmd}\\b`).test(segText)) {
        const t = extractCommandTarget(segText, cmd);
        if (t) writeTargets.push(t);
      }
    }

    /* ---- 提取 dd of= 目标 ---- */
    const ddOfMatch = segText.match(/\bof=([^\s;|&]+)/);
    if (ddOfMatch) writeTargets.push(ddOfMatch[1]!);

    /* ---- 提取 truncate 目标 ---- */
    const truncMatch = segText.match(/\btruncate\s+(?:-s\s+\S+\s+)?([^\s;|&]+)/);
    if (truncMatch) writeTargets.push(truncMatch[1]!);

    /* ---- 提取 rm 目标（所有非 flag 参数） ---- */
    if (/\brm\b/.test(segText)) {
      const rmArgs = segText.replace(/\brm\s+/, '');
      const rmTokens = rmArgs.split(/\s+/).filter(Boolean);
      for (const t of rmTokens) {
        if (!t.startsWith('-')) writeTargets.push(t);
      }
    }

    /* ---- 提取 sed -i 目标（最后一个非 flag token） ---- */
    if (/\bsed\b/.test(segText) && /\s+-i\b/.test(segText)) {
      const sedParts = segText.split(/\s+/);
      for (let i = sedParts.length - 1; i >= 0; i--) {
        if (!sedParts[i]!.startsWith('-') && sedParts[i] !== 'sed') {
          writeTargets.push(sedParts[i]!);
          break;
        }
      }
    }

    /* ---- 提取 tee 目标（最后一个非 flag token） ---- */
    if (/\btee\b/.test(segText)) {
      const teeParts = segText.split(/\s+/);
      for (let i = teeParts.length - 1; i >= 0; i--) {
        if (!teeParts[i]!.startsWith('-') && teeParts[i] !== 'tee') {
          writeTargets.push(teeParts[i]!);
          break;
        }
      }
    }
  }

  /* ---- B 档优先返回 ---- */
  if (dynamicDetected) {
    return {
      ok: false,
      reason: '写入目标含动态路径（变量、命令替换或 eval），无法静态校验。请改写成 allowRoot 内的显式路径。',
      tier: 'B',
    };
  }
  if (inlineWriteDetected) {
    return {
      ok: false,
      reason: '内联解释器代码（python/node/perl）含写入操作，无法静态校验。请改写成 allowRoot 内的显式路径或移除写入。',
      tier: 'B',
    };
  }
  if (cdEscapedRelativeWrite) {
    return {
      ok: false,
      reason: 'cd 已切换到 allowRoot 外的目录，后续相对路径写入无法静态校验。请使用 allowRoot 内的显式绝对路径，或在 cd 前完成写入。',
      tier: 'B',
    };
  }

  /* ---- 无目标 → C 档放行 ---- */
  if (writeTargets.length === 0) return { ok: true };

  /* ---- A 档判定 ---- */
  for (const raw of writeTargets) {
    // 丢弃型特殊设备先放行：写它们不产生文件。
    if (isDiscardDevice(raw)) continue;
    const abs = resolveTarget(effectiveCwd, raw);
    if (!abs) {
      return {
        ok: false,
        reason: `写入目标 "${raw}" 无法静态解析为路径。请改写成 allowRoot 内的显式绝对路径。`,
        tier: 'B',
      };
    }
    if (!isUnderAllowRoot(abs, allowRoot)) {
      return {
        ok: false,
        reason: `写入目标 ${abs} 超出 allowRoot ${allowRoot} 的允许范围。`,
        tier: 'A',
      };
    }
  }

  return { ok: true };
}
