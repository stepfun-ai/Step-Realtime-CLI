import { describe, expect, it } from 'vitest';
import {
  resolveShell,
  resetShellCache,
  winPathToWsl,
  rewriteNulRedirect,
  shellPromptHint,
  type ShellFamily,
} from '../../src/tools/shellResolve.js';

describe('winPathToWsl', () => {
  it('C 盘路径转 /mnt/c', () => {
    expect(winPathToWsl('C:\\foo\\bar')).toBe('/mnt/c/foo/bar');
  });

  it('正斜杠输入也能转', () => {
    expect(winPathToWsl('D:/a/b')).toBe('/mnt/d/a/b');
  });

  it('盘符根目录', () => {
    expect(winPathToWsl('C:\\')).toBe('/mnt/c');
  });

  it('小写盘符归一化为小写', () => {
    expect(winPathToWsl('e:\\x')).toBe('/mnt/e/x');
  });

  it('非 Windows 绝对路径返回 undefined', () => {
    expect(winPathToWsl('/home/user')).toBeUndefined();
    expect(winPathToWsl('relative/path')).toBeUndefined();
  });

  it('UNC 路径不识别（返回 undefined，非本函数职责）', () => {
    expect(winPathToWsl('\\\\server\\share')).toBeUndefined();
  });

  it('无盘符分隔符的畸形路径不匹配', () => {
    expect(winPathToWsl('C:foo')).toBeUndefined();
  });

  it('含空格与混合分隔符的路径正常转换', () => {
    expect(winPathToWsl('C:\\Program Files\\Git')).toBe('/mnt/c/Program Files/Git');
    expect(winPathToWsl('C:/a\\b')).toBe('/mnt/c/a/b');
  });
});

describe('rewriteNulRedirect', () => {
  it('>NUL 2>&1 改写为 /dev/null', () => {
    expect(rewriteNulRedirect('echo x >NUL 2>&1')).toBe('echo x >/dev/null 2>&1');
  });

  it('2>NUL 改写', () => {
    expect(rewriteNulRedirect('cmd 2>NUL')).toBe('cmd 2>/dev/null');
  });

  it('大小写不敏感', () => {
    expect(rewriteNulRedirect('cmd >nul')).toBe('cmd >/dev/null');
    expect(rewriteNulRedirect('cmd >Nul')).toBe('cmd >/dev/null');
  });

  it('不误伤普通单词 NULL/nullable', () => {
    expect(rewriteNulRedirect('echo NULL')).toBe('echo NULL');
    expect(rewriteNulRedirect('grep nullable file')).toBe('grep nullable file');
  });

  it('保留重定向前缀空白与操作符', () => {
    expect(rewriteNulRedirect('cmd > NUL')).toBe('cmd > /dev/null');
  });

  it('覆盖 >> / 1> / &> 及一行多处', () => {
    expect(rewriteNulRedirect('cmd >>NUL')).toBe('cmd >>/dev/null');
    expect(rewriteNulRedirect('cmd 1>NUL')).toBe('cmd 1>/dev/null');
    expect(rewriteNulRedirect('a >NUL; b 2>NUL')).toBe('a >/dev/null; b 2>/dev/null');
  });

  it('管道 / 分号 / 右括号后的 NUL 也改写', () => {
    expect(rewriteNulRedirect('cmd >NUL | tail')).toBe('cmd >/dev/null | tail');
    expect(rewriteNulRedirect('(cmd >NUL)')).toBe('(cmd >/dev/null)');
  });

  it('设备名 NUL: 形式改写', () => {
    expect(rewriteNulRedirect('cmd >NUL:')).toBe('cmd >/dev/null');
    expect(rewriteNulRedirect('cmd 2>NUL: rest')).toBe('cmd 2>/dev/null rest');
  });

  it('引号包裹 "NUL" / "NUL:" 改写', () => {
    expect(rewriteNulRedirect('cmd >"NUL"')).toBe('cmd >/dev/null');
    expect(rewriteNulRedirect('cmd 2>"NUL:"')).toBe('cmd 2>/dev/null');
  });

  it('不误伤 NUL:foo（非标准空设备写法）与普通词', () => {
    expect(rewriteNulRedirect('cmd >NUL:foo')).toBe('cmd >NUL:foo');
    expect(rewriteNulRedirect('echo NULL')).toBe('echo NULL');
    expect(rewriteNulRedirect('grep nullable f')).toBe('grep nullable f');
  });
});

describe('shellPromptHint', () => {
  const families: ShellFamily[] = ['posix', 'wsl', 'busybox', 'powershell', 'none'];

  it('每个 family 都返回非空提示且以 - 开头', () => {
    for (const f of families) {
      const hint = shellPromptHint(f);
      expect(hint.length).toBeGreaterThan(0);
      expect(hint.startsWith('- ')).toBe(true);
    }
  });

  it('powershell 提示明确不要写 Unix 语法', () => {
    expect(shellPromptHint('powershell')).toContain('Unix 语法');
  });

  it('none 提示引导安装 Git for Windows', () => {
    expect(shellPromptHint('none')).toContain('Git for Windows');
  });

  it('wsl 提示提到 /mnt 挂载', () => {
    expect(shellPromptHint('wsl')).toContain('/mnt/');
  });
});

describe('resolveShell', () => {
  it('返回可用的解释器与合法 family（不含 cmd 兜底）', () => {
    resetShellCache();
    const shell = resolveShell();
    expect(['posix', 'wsl', 'busybox', 'powershell', 'none']).toContain(shell.family);
    // args 是纯函数，能把命令拼进参数数组
    const argv = shell.args('echo hi');
    expect(argv[argv.length - 1]).toBe('echo hi');
  });

  it('缓存：连续两次返回同一对象', () => {
    resetShellCache();
    const a = resolveShell();
    const b = resolveShell();
    expect(a).toBe(b);
  });

  it('非 Windows 平台走 posix 分支', () => {
    if (process.platform === 'win32') return; // 该断言只在 POSIX 有意义
    resetShellCache();
    const shell = resolveShell();
    expect(shell.family).toBe('posix');
    expect(shell.args('ls')).toEqual(['-c', 'ls']);
  });
});
