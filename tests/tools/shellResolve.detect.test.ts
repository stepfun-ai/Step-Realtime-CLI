import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 探测链 mock 覆盖：mock node:child_process.execFileSync 与 node:fs.existsSync，
 * 覆写 process.platform='win32'，逐场景验证 Git Bash → WSL → busybox → PowerShell → none
 * 的降级顺序。真实测试机永远命中 Git Bash 直接返回，这些分支只能靠 mock 覆盖。
 */

// 可变桩：测试内替换以编排不同环境。
let execImpl: (file: string, args: readonly string[]) => Buffer | string = () => {
  throw new Error('ENOENT');
};
let existsImpl: (p: string) => boolean = () => false;

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  return {
    ...orig,
    execFileSync: (file: string, args: readonly string[]) => execImpl(file, args),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  return {
    ...orig,
    existsSync: (p: string) => existsImpl(p),
  };
});

import { resolveShell, resetShellCache } from '../../src/tools/shellResolve.js';

const realPlatform = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  resetShellCache();
  setPlatform('win32');
  delete process.env['STEP_SHELL_PATH'];
  // 默认：所有外部命令失败、所有路径不存在
  execImpl = () => {
    throw new Error('ENOENT');
  };
  existsImpl = () => false;
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  resetShellCache();
  vi.clearAllMocks();
});

describe('detectShell 降级链（Windows mock）', () => {
  it('所有 shell 都探测不到 → family=none，cmd 为空', () => {
    const r = resolveShell();
    expect(r.family).toBe('none');
    expect(r.cmd).toBe('');
  });

  it('STEP_SHELL_PATH 命中 → posix，直接用指定 bash', () => {
    const p = 'D:\\portable\\git\\bin\\bash.exe';
    process.env['STEP_SHELL_PATH'] = p;
    existsImpl = (x) => x === p;
    const r = resolveShell();
    expect(r.family).toBe('posix');
    expect(r.cmd).toBe(p);
    expect(r.args('echo hi')).toEqual(['-c', 'echo hi']);
  });

  it('固定候选路径存在 Git Bash → posix', () => {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    // where/reg/git 全失败，但固定候选路径 existsSync 命中
    existsImpl = (x) => x === gitBash;
    const r = resolveShell();
    expect(r.family).toBe('posix');
    expect(r.cmd).toBe(gitBash);
  });

  it('无 Git Bash，但 WSL 有发行版 → wsl', () => {
    execImpl = (file, args) => {
      // which('wsl') → where wsl 命中
      if (file === 'where' && args[0] === 'wsl') return 'C:\\Windows\\System32\\wsl.exe\r\n';
      // wsl --list --quiet 返回 UTF-16LE 的发行版名
      if (String(file).toLowerCase().includes('wsl') && args.includes('--list')) {
        return Buffer.from('Ubuntu\r\n', 'utf16le');
      }
      throw new Error('ENOENT');
    };
    existsImpl = (x) => x.toLowerCase().includes('wsl.exe');
    const r = resolveShell();
    expect(r.family).toBe('wsl');
    expect(r.args('ls')).toEqual(['bash', '-c', 'ls']);
  });

  it('WSL 存在但无发行版（--list 输出空）→ 不误判为 wsl', () => {
    execImpl = (file, args) => {
      if (file === 'where' && args[0] === 'wsl') return 'C:\\Windows\\System32\\wsl.exe\r\n';
      if (String(file).toLowerCase().includes('wsl') && args.includes('--list')) {
        return Buffer.from('', 'utf16le'); // 无发行版
      }
      throw new Error('ENOENT');
    };
    existsImpl = (x) => x.toLowerCase().includes('wsl.exe');
    const r = resolveShell();
    expect(r.family).not.toBe('wsl'); // 应继续降级
    expect(r.family).toBe('none');
  });

  it('只有 busybox → busybox', () => {
    execImpl = (file, args) => {
      if (file === 'where' && args[0] === 'busybox') return 'C:\\tools\\busybox.exe\r\n';
      throw new Error('ENOENT');
    };
    existsImpl = (x) => x.toLowerCase().includes('busybox');
    const r = resolveShell();
    expect(r.family).toBe('busybox');
    expect(r.args('ls')).toEqual(['sh', '-c', 'ls']);
  });

  it('只有 PowerShell（pwsh）→ powershell', () => {
    execImpl = (file, args) => {
      if (file === 'where' && args[0] === 'pwsh') return 'C:\\Program Files\\PowerShell\\7\\pwsh.exe\r\n';
      throw new Error('ENOENT');
    };
    existsImpl = (x) => x.toLowerCase().includes('pwsh');
    const r = resolveShell();
    expect(r.family).toBe('powershell');
    expect(r.args('gci')).toEqual(['-NoProfile', '-Command', 'gci']);
  });

  it('none 节流：窗口内复用 none，窗口后（重探）装了 Git Bash 能生效', () => {
    // 第一次：全无 → none
    expect(resolveShell().family).toBe('none');
    // 中途"装上"固定候选路径的 Git Bash
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    existsImpl = (x) => x === gitBash;
    // 30s 节流窗口内：直接复用 none，不重探（避免每次 bash 调用全量探测阻塞）
    expect(resolveShell().family).toBe('none');
    // 模拟窗口过后重探（resetShellCache 清掉节流时间戳）：能探到新装的 Git Bash
    resetShellCache();
    expect(resolveShell().family).toBe('posix');
  });

  it('git --exec-path 返回 MSYS 风格路径 /d/... → 正确重建盘符推断 Git Bash', () => {
    // git.exe 在 PATH 的 shim 目录，其上两级推不出 Git 根；Git 装在非标准位置（D 盘），
    // 不在固定候选路径列表里，只能靠 --exec-path 的 MSYS 风格输出重建得到。
    const gitExe = 'C:\\Users\\me\\scoop\\shims\\git.exe';
    const bash = 'D:\\Tools\\Git\\bin\\bash.exe';
    execImpl = (file, args) => {
      if (file === 'where' && args[0] === 'git') return `${gitExe}\r\n`;
      if (file === gitExe && args[0] === '--exec-path') {
        // MSYS 风格：前导 / + 单字母盘符，split 后会丢盘符冒号，靠重建逻辑还原
        return '/d/Tools/Git/mingw64/libexec/git-core';
      }
      throw new Error('ENOENT');
    };
    // 只有 gitExe 和重建出的 bash 存在（大小写不敏感，模拟 Windows 真实 existsSync；
    // 重建产生的盘符可能是小写 d:\）
    const lc = (s: string): string => s.toLowerCase();
    existsImpl = (x) => lc(x) === lc(gitExe) || lc(x) === lc(bash);
    const r = resolveShell();
    expect(r.family).toBe('posix');
    expect(lc(r.cmd)).toBe(lc(bash));
  });

  it('MSYS exec-path 含连续分隔符 → 重建不产生双反斜杠', () => {
    const gitExe = 'C:\\Users\\me\\scoop\\shims\\git.exe';
    const bash = 'D:\\Tools\\Git\\bin\\bash.exe';
    execImpl = (file, args) => {
      if (file === 'where' && args[0] === 'git') return `${gitExe}\r\n`;
      if (file === gitExe && args[0] === '--exec-path') {
        // 连续分隔符：/d//Tools/Git/... 若不 filter 空段会拼出 D:\\Tools 双反斜杠
        return '/d//Tools/Git/mingw64/libexec/git-core';
      }
      throw new Error('ENOENT');
    };
    const lc = (s: string): string => s.toLowerCase();
    // 只认规范化后的单反斜杠路径存在（双反斜杠视为不存在，逼出 filter 正确性）
    existsImpl = (x) => lc(x) === lc(gitExe) || (lc(x) === lc(bash) && !x.includes('\\\\'));
    const r = resolveShell();
    expect(r.family).toBe('posix');
    expect(r.cmd).not.toContain('\\\\'); // 无双反斜杠
    expect(lc(r.cmd)).toBe(lc(bash));
  });
});
