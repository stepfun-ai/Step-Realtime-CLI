import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, win32 as pathWin32 } from 'node:path';

/**
 * 跨平台 shell 解析：为 bash 工具与 system prompt 提供统一的解释器选择。
 *
 * Windows 探测链（对齐主流 coding CLI，不回退 cmd.exe）：
 *   环境变量覆盖 → PATH 中的 bash（排除 WSL 启动器）→ 从 git 推断 Git Bash
 *   → 注册表推断 Git Bash → WSL → busybox-w32 → PowerShell。
 *   不回退 cmd.exe（cmd 不认 Unix 语法，兜底到它是「能跑但全错」）；
 *   皆无时 family='none'，由 bash 工具报错引导装 Git Bash。
 *
 * family 语义：
 *   - posix：Git Bash / MSYS bash / 原生 bash，标准 POSIX 语法
 *   - wsl：通过 wsl.exe 调用 Linux bash，需 /mnt 路径转换
 *   - busybox：busybox-w32 的 ash，仅基础 POSIX
 *   - powershell：cmdlet / PS 语法
 *   - none：未找到任何可用 shell（对齐业界，不回退 cmd.exe）；bash 工具据此报错引导装 Git Bash
 */
export type ShellFamily = 'posix' | 'wsl' | 'busybox' | 'powershell' | 'none';

export interface ResolvedShell {
  /** 解释器可执行文件路径或命令名。 */
  cmd: string;
  /** 由命令字符串构造 spawn 参数数组。 */
  args: (command: string) => string[];
  /** shell 家族，供路径转换与语法提示使用。 */
  family: ShellFamily;
}

/** 判断一个 bash 路径是否为 Windows 内置的 WSL 启动器（System32\bash.exe）。 */
function isWslLauncherPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.includes('windows\\system32\\bash') || lower.includes('windows\\syswow64\\bash');
}

/** 在 PATH 中查找可执行文件，返回绝对路径或 undefined。 */
function which(name: string): string | undefined {
  try {
    if (process.platform === 'win32') {
      // where 可能返回多行；取第一个真实存在的路径（首行可能是已卸载残留）。
      const out = execFileSync('where', [name], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).toString();
      return out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0 && existsSync(l));
    }
    // POSIX：command 是 shell 内建，必须在 shell 里跑，不能当可执行文件 execFile。
    const out = execFileSync('/bin/sh', ['-c', `command -v ${name}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).toString();
    const first = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    return first || undefined;
  } catch {
    return undefined;
  }
}

/** 从 Windows 注册表读取 Git for Windows 安装路径，拼出 bash.exe。 */
function gitBashFromRegistry(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const keys = [
    'HKLM\\SOFTWARE\\GitForWindows',
    'HKCU\\SOFTWARE\\GitForWindows',
  ];
  for (const key of keys) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', 'InstallPath'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).toString();
      // 形如：    InstallPath    REG_SZ    C:\Program Files\Git
      const m = out.match(/^\s*InstallPath\s+REG_\w+\s+(.+)$/m);
      const installPath = m?.[1]?.trim();
      if (installPath) {
        for (const sub of ['bin', join('usr', 'bin')]) {
          const cand = join(installPath, sub, 'bash.exe');
          if (existsSync(cand)) return cand;
        }
      }
    } catch {
      // 该键不存在或 reg 不可用，继续下一个
    }
  }
  return undefined;
}

/** 从 git.exe 位置与 `git --exec-path` 推断同装的 Git Bash。 */
function gitBashFromGitExe(): string | undefined {
  const gitExe = which('git');
  if (!gitExe) return undefined;

  // git.exe 通常在 <root>\cmd\git.exe 或 <root>\bin\git.exe
  // 此处逻辑只在 Windows 语义下跑，但单测会 mock process.platform='win32' 后跨平台运行，
  // 所以必须用 Windows 路径 join，避免在 POSIX 上把反斜杠当成普通字符拼出混合分隔符。
  const parent = pathWin32.join(gitExe, '..', '..');
  for (const sub of ['bin', pathWin32.join('usr', 'bin')]) {
    const cand = pathWin32.join(parent, sub, 'bash.exe');
    if (existsSync(cand)) return cand;
  }

  // 通过 git --exec-path 推断：形如 C:\Program Files\Git\mingw64\libexec\git-core
  // 也可能是 MSYS 风格 /c/Program Files/Git/mingw64/...（split+join 会丢盘符冒号与前导分隔符）。
  try {
    const execPath = execFileSync(gitExe, ['--exec-path'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
      .toString()
      .trim();
    const parts = execPath.split(/[/\\]/);
    const idx = parts.findIndex((p) => p.toLowerCase() === 'mingw32' || p.toLowerCase() === 'mingw64');
    if (idx > 0) {
      const head = parts.slice(0, idx);
      // MSYS 风格 /c/... → 前导空串 + 单字母盘符，重建为 C:\ 形式；否则原样 join。
      // filter(Boolean) 去掉连续分隔符产生的空段，避免拼出 C:\\dir 双分隔符。
      let root: string;
      if (head[0] === '' && head[1] !== undefined && /^[A-Za-z]$/.test(head[1])) {
        root = `${head[1].toUpperCase()}:\\${head.slice(2).filter(Boolean).join('\\')}`;
      } else {
        root = head.filter(Boolean).join('\\');
      }
      for (const sub of ['bin', pathWin32.join('usr', 'bin')]) {
        const cand = pathWin32.join(root, sub, 'bash.exe');
        if (existsSync(cand)) return cand;
      }
    }
  } catch {
    // git --exec-path 失败，忽略
  }
  return undefined;
}

/** 在 Windows 上定位非 WSL 的 bash（Git Bash / MSYS2），逐级探测。 */
function findGitBash(): string | undefined {
  // 1. 环境变量覆盖（显式指定，最高优先）
  const override = (process.env['STEP_SHELL_PATH'] ?? '').trim();
  if (override && existsSync(override)) return override;

  // 2. PATH 中的 bash（排除 WSL 启动器）
  const inPath = which('bash');
  if (inPath && !isWslLauncherPath(inPath)) return inPath;

  // 3. 从 git.exe / git --exec-path 推断
  const fromGit = gitBashFromGitExe();
  if (fromGit) return fromGit;

  // 4. 注册表推断
  const fromReg = gitBashFromRegistry();
  if (fromReg) return fromReg;

  // 5. 固定候选路径
  const localAppData = process.env['LOCALAPPDATA'] ?? '';
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
    localAppData ? join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe') : '',
    localAppData ? join(localAppData, 'Programs', 'Git', 'usr', 'bin', 'bash.exe') : '',
  ].filter((p) => p.length > 0);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

/** 定位可用的 WSL：找到 wsl.exe 并能列出发行版才算可用。 */
function findWslBash(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const wslExe = which('wsl');
  if (!wslExe) return undefined;
  try {
    // wsl --list --quiet 输出为 UTF-16LE。用 buffer 显式按 utf16le 解码，
    // 再剥除 BOM / 控制字符，判断是否有真实发行版名（含字母或数字的非空行）。
    // 无发行版时输出为空或仅本地化提示（--quiet 下通常为空），非 0 退出会抛进 catch。
    const buf = execFileSync(wslExe, ['--list', '--quiet'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const text = buf.toString('utf16le').replace(/^\uFEFF/, '');
    const hasDistro = text
      .split(/\r?\n/)
      .map((l) => l.replace(/[\u0000-\u001f\uFFFD]/g, '').trim())
      .some((l) => /[A-Za-z0-9]/.test(l));
    return hasDistro ? wslExe : undefined;
  } catch {
    return undefined;
  }
}

/** 定位 busybox-w32（PATH 中）。 */
function findBusybox(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  return which('busybox');
}

/** 定位 PowerShell：优先 pwsh（7+），回退 powershell.exe（5.1）。 */
function findPowerShell(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  return which('pwsh') ?? which('powershell');
}

/**
 * 解析当前平台应使用的 shell 解释器。
 *
 * Windows：Git Bash → WSL → busybox → PowerShell。对齐主流 coding CLI，
 *   不回退 cmd.exe（cmd 不认 Unix 语法，"能跑"反而让模型命令全崩、更难排查）；
 *   四者皆无时返回 family='none'，由 bash 工具报错引导用户装 Git Bash。
 * POSIX：$SHELL 或 /bin/bash。
 */
function detectShell(): ResolvedShell {
  if (process.platform !== 'win32') {
    return {
      cmd: process.env['SHELL'] ?? '/bin/bash',
      args: (command) => ['-c', command],
      family: 'posix',
    };
  }

  const gitBash = findGitBash();
  if (gitBash) {
    return { cmd: gitBash, args: (command) => ['-c', command], family: 'posix' };
  }

  const wsl = findWslBash();
  if (wsl) {
    // wsl.exe bash -c <command>
    return { cmd: wsl, args: (command) => ['bash', '-c', command], family: 'wsl' };
  }

  const busybox = findBusybox();
  if (busybox) {
    return { cmd: busybox, args: (command) => ['sh', '-c', command], family: 'busybox' };
  }

  const ps = findPowerShell();
  if (ps) {
    return { cmd: ps, args: (command) => ['-NoProfile', '-Command', command], family: 'powershell' };
  }

  // 未找到任何可用 shell。不回退 cmd.exe（对齐主流工具）。
  // 保留占位 cmd 便于类型统一，但 family='none' 会让 bash 工具直接报错。
  return { cmd: '', args: (command) => [command], family: 'none' };
}

let cached: ResolvedShell | undefined;
/** 上次探测到 none 的时间戳（节流用，避免真无 shell 时每次调用都全量重探）。 */
let noneProbedAt = 0;
/** none 结果的重探节流窗口（ms）：窗口内直接复用 none，窗口后允许重探（中途装了 Git Bash 能生效）。 */
const NONE_REPROBE_MS = 30_000;

/**
 * 解析 shell（模块级缓存，进程内命中真实 shell 后只探测一次）。
 * 例外：family='none'（未找到任何 shell）不长期缓存——长驻会话中途装了 Git Bash 后能重新探测生效，
 * 无需重启进程。但探测链含多个带 5s 超时的子进程，为避免真无 shell 时每次 bash 调用都全量重探造成
 * 长时间阻塞，对 none 结果做 30s 节流：窗口内直接返回 none，窗口后才允许再探。
 */
export function resolveShell(): ResolvedShell {
  if (cached !== undefined) return cached;
  const now = Date.now();
  if (now - noneProbedAt < NONE_REPROBE_MS) {
    return { cmd: '', args: (command) => [command], family: 'none' };
  }
  const resolved = detectShell();
  if (resolved.family === 'none') {
    noneProbedAt = now; // 记录探测时刻，窗口内不再重探
    return resolved;
  }
  cached = resolved;
  return cached;
}

/** 测试用：清空探测缓存（含 none 节流时间戳）。 */
export function resetShellCache(): void {
  cached = undefined;
  noneProbedAt = 0;
}

/**
 * 把 Windows 绝对路径转成 WSL 挂载路径。
 * C:\foo\bar -> /mnt/c/foo/bar；无法识别时返回 undefined。
 */
export function winPathToWsl(path: string): string | undefined {
  const m = /^([A-Za-z]):[/\\](.*)$/.exec(path);
  if (!m) return undefined;
  const drive = m[1]!.toLowerCase();
  const rest = m[2]!.replace(/\\/g, '/');
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
}

/**
 * 把 Windows 风格的 NUL 重定向改写成 POSIX 的 /dev/null。
 * `echo x >NUL 2>&1` -> `echo x > /dev/null 2>&1`。
 * Git Bash / WSL / busybox 都认 /dev/null，不认 Windows 的 NUL。
 * 覆盖裸 `NUL`、设备名 `NUL:`、以及带引号的 `"NUL"`；不误伤 `NULL`/`nullable` 等普通词。
 */
export function rewriteNulRedirect(command: string): string {
  return command
    // 引号包裹：>"NUL" / 2>"NUL"（引号内允许尾随冒号）
    .replace(/(\d?&?>+\s*)"[Nn][Uu][Ll]:?"/g, '$1/dev/null')
    // 裸形式：>NUL / 2>NUL / >NUL:（设备名冒号可选），后接空白/结尾/管道等边界
    .replace(/(\d?&?>+\s*)[Nn][Uu][Ll]:?(?=\s|$|[|&;)\n])/g, '$1/dev/null');
}

/**
 * 生成 system prompt 里 bash 工具的 shell 语法提示行，按实际生效的 family 定制。
 * 这样即便回退到 PowerShell，也不会误导模型写 Unix 命令。
 */
export function shellPromptHint(family: ShellFamily): string {
  switch (family) {
    case 'posix':
      return process.platform === 'win32'
        ? '- bash 工具在 Windows 上通过 Git Bash 运行，用 Unix 语法与正斜杠路径（`ls`、`2>/dev/null`、`&&`）。'
        : '- bash 工具用 Unix 语法（bash/sh），正斜杠路径。';
    case 'wsl':
      return '- bash 工具通过 WSL（Linux bash）运行，用 Unix 语法；访问 Windows 文件走 `/mnt/c/` 挂载路径。';
    case 'busybox':
      return '- bash 工具通过 busybox-w32（ash）运行，仅支持基础 POSIX 命令，避免 GNU bash 扩展（数组、`[[ ]]` 等）。';
    case 'powershell':
      return '- 未检测到 POSIX shell，bash 工具回退到 PowerShell：用 cmdlet/PS 语法（`Get-ChildItem`、`2>$null`、反斜杠路径），不要写 Unix 语法（`ls`、`2>/dev/null` 会失败）。';
    case 'none':
      return '- 未检测到任何可用 shell（Git Bash / WSL / busybox / PowerShell 都没有），bash 工具将无法执行命令。请先安装 Git for Windows（提供 Git Bash）。';
    default: {
      // 穷尽检查：新增 family 成员而漏改此处会在编译期报错。
      const _exhaustive: never = family;
      return _exhaustive;
    }
  }
}

