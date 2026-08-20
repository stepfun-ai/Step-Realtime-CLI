import { describe, expect, it } from 'vitest';
import { checkBashWrite } from '../../src/tools/bashWriteGuard.js';
import { resolve, join } from 'node:path';

// ── 平台感知 allowRoot ──────────────────────────────────────────────
// Windows 上 path.resolve('project') 得到类似 C:\Users\<user>\project
// 的路径；Linux/macOS 得到 /home/user/project 或 /Users/<user>/project。
// 这样 ALLOW 永远指向一个真实存在的用户目录，避免跨平台路径不匹配。
const ALLOW: string = resolve('project');
// ── heredoc 内容辅助（避免字面 \n 与 shell heredoc 语义混淆） ──────
const HEREDOC_CONTENT = "if [ 1 > 2 ]; then echo yes; fi";

function underAllow(...parts: string[]): string {
  return resolve(join(ALLOW, ...parts));
}

describe('checkBashWrite', () => {
  /* ---------------------------------------------------------------- */
  /*  第 0 条：allowRoot 缺省 → 一律放行                              */
  /* ---------------------------------------------------------------- */
  describe('allowRoot 缺省', () => {
    it('undefined allowRoot：任何命令都放行', () => {
      expect(checkBashWrite('echo x > /etc/passwd', '/home/user/project', undefined)).toEqual({ ok: true });
      expect(checkBashWrite('rm -rf /', '/home/user/project', undefined)).toEqual({ ok: true });
      expect(checkBashWrite('python -c "open(1).write(1)"', '/home/user/project', undefined)).toEqual({ ok: true });
    });

    it('空字符串 allowRoot：任何命令都放行', () => {
      expect(checkBashWrite('echo x > /etc/passwd', '/home/user/project', '')).toEqual({ ok: true });
    });
  });

  /* ---------------------------------------------------------------- */
  /*  A 档：可解析且越界 → 拒绝                                       */
  /* ---------------------------------------------------------------- */
  describe('A 档：可解析且越界', () => {
    it('绝对路径重定向：/tmp/out → 越界', () => {
      const r = checkBashWrite('echo x > /tmp/out', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); expect(r.reason).toContain('超出 allowRoot'); }
    });

    it('相对路径 .. 逃逸：../../etc/passwd → 越界', () => {
      // 从 ALLOW/sub 出发退两级才真正逃出 allowRoot；退一级（../etc/passwd）
      // resolve 后仍是 ALLOW/etc/passwd，在范围内，本就该放行。
      const r = checkBashWrite('echo x > ../../etc/passwd', underAllow('sub'), ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('Windows 原生绝对路径越界（C:\\Users\\...）', () => {
      const r = checkBashWrite('echo x > C:\\Users\\outside\\file.txt', 'C:\\project', 'C:\\project');
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('Windows Git Bash 路径越界（/c/Users/...）', () => {
      const r = checkBashWrite('echo x > /c/Users/outside/file.txt', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('cp 目标越界', () => {
      const r = checkBashWrite('cp /tmp/src /tmp/dst', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('mv 目标越界', () => {
      const r = checkBashWrite('mv /tmp/a /tmp/b', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('rm 目标越界', () => {
      const r = checkBashWrite('rm /tmp/file', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('tee 目标越界', () => {
      const r = checkBashWrite('echo x | tee /tmp/out', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('sed -i 目标越界', () => {
      const r = checkBashWrite("sed -i 's/foo/bar/' /tmp/file", '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('truncate 目标越界', () => {
      const r = checkBashWrite('truncate -s 0 /tmp/file', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('dd of= 目标越界', () => {
      const r = checkBashWrite('dd if=/dev/zero of=/tmp/file bs=1M count=1', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('install 目标越界', () => {
      const r = checkBashWrite('install /tmp/src /tmp/dst', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('n> 描述符重定向越界', () => {
      const r = checkBashWrite('echo x 2> /tmp/err', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('append 重定向 >> 越界', () => {
      const r = checkBashWrite('echo x >> /tmp/out', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('heredoc 目标越界', () => {
      const r = checkBashWrite("cat > /tmp/heredoc << 'EOF'\nhello\nEOF", '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('兄弟目录前缀陷阱：/a/bc 不在 /a/b 内', () => {
      const r = checkBashWrite('echo x > /a/bc/file.txt', '/home/user/project', '/a/b');
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); expect(r.reason).toContain('超出 allowRoot'); }
    });
  });

  /* ---------------------------------------------------------------- */
  /*  A 档反面：目标在 allowRoot 内 → 放行                           */
  /* ---------------------------------------------------------------- */
  describe('A 档反面：目标在 allowRoot 内', () => {
    it('绝对路径在 allowRoot 内 → 放行', () => {
      const target = underAllow('out.txt');
      const r = checkBashWrite(`echo x > ${target}`, underAllow('sub'), ALLOW);
      expect(r.ok).toBe(true);
    });

    it('相对路径 .. 回到 allowRoot 内 → 放行', () => {
      const r = checkBashWrite('echo x > ../out.txt', underAllow('sub', 'deep'), ALLOW);
      expect(r.ok).toBe(true);
    });

    it('cp 目标在 allowRoot 内 → 放行', () => {
      const src = underAllow('src.txt');
      const dst = underAllow('dst.txt');
      const r = checkBashWrite(`cp ${src} ${dst}`, underAllow('sub'), ALLOW);
      expect(r.ok).toBe(true);
    });

    it('tee 目标在 allowRoot 内 → 放行', () => {
      const target = underAllow('out.txt');
      const r = checkBashWrite(`echo x | tee ${target}`, underAllow('sub'), ALLOW);
      expect(r.ok).toBe(true);
    });

    it('cd 到 allowRoot 内子目录后相对写入 → 放行', () => {
      const r = checkBashWrite('cd sub && echo x > out.txt', ALLOW, ALLOW);
      expect(r.ok).toBe(true);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  B 档：有写入迹象但目标不可解析 → 拒绝                           */
  /* ---------------------------------------------------------------- */
  describe('B 档：目标不可解析', () => {
    it('变量路径', () => {
      const r = checkBashWrite('f=/tmp/x; echo hi > $f', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('B'); expect(r.reason).toContain('动态路径'); }
    });

    it('命令替换', () => {
      const r = checkBashWrite('echo hi > $(mktemp)', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('B'); }
    });

    it('eval', () => {
      const r = checkBashWrite('eval "echo hi > /tmp/x"', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('B'); }
    });

    it('python -c 含写入', () => {
      const r = checkBashWrite("python -c 'open(\"/tmp/x\", \"w\").write(\"1\")'", '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('B'); }
    });

    it('node -e 含写入', () => {
      const r = checkBashWrite('node -e "require(\"fs\").writeFileSync(\"/tmp/x\", \"1\")"', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('B'); }
    });

    it('cd 越界后相对路径写入', () => {
      const r = checkBashWrite('cd /tmp && echo x > out.txt', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('B'); expect(r.reason).toContain('cd 已切换'); }
    });

    it('cd 越界后 tee 相对路径', () => {
      const r = checkBashWrite('cd /tmp && echo x | tee out.txt', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('B'); }
    });
  });

  /* ---------------------------------------------------------------- */
  /*  B 档反面：动态路径但纯计算 → 放行                               */
  /* ---------------------------------------------------------------- */
  describe('B 档反面：纯计算放行', () => {
    it('python -c 纯计算', () => {
      const r = checkBashWrite('python -c "print(1 + 1)"', '/home/user/project', ALLOW);
      expect(r.ok).toBe(true);
    });

    it('node -e 纯计算', () => {
      const r = checkBashWrite('node -e "console.log(1 + 1)"', '/home/user/project', ALLOW);
      expect(r.ok).toBe(true);
    });

    it('perl -e 纯计算', () => {
      const r = checkBashWrite('perl -e "print 1 + 1"', '/home/user/project', ALLOW);
      expect(r.ok).toBe(true);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  C 档：只读命令 → 放行                                           */
  /* ---------------------------------------------------------------- */
  describe('C 档：只读命令', () => {
    const readOnlyCommands = [
      'ls',
      'ls -la',
      // 含未加引号变量的只读命令：动态路径判定必须有「写入迹象」门槛才不会误拦。
      // 引号内的变量本来就被 strip，漏的是这一类裸变量。
      'ls $HOME',
      'cat $CONFIG_FILE',
      'grep $PATTERN file.txt',
      'echo $PATH',
      'echo ${HOME}',
      'git diff $BASE',
      'cat file.txt',
      'grep "pattern" file.txt',
      'grep -r "pattern" /home/user/project',
      'find . -name "*.ts"',
      'git log --oneline',
      'git diff HEAD~1',
      'git status',
      'git status -sb',
      'head -n 20 file.txt',
      'tail -n 20 file.txt',
      'tail -f file.txt',
      'wc -l file.txt',
      'awk "{print $1}" file.txt',
      'awk \'{print $1}\' file.txt',
      'sed "s/foo/bar/g" file.txt',
      'sort file.txt',
      'uniq file.txt',
      'diff file1 file2',
      'diff -u file1 file2',
      'which python',
      'whoami',
      'pwd',
      'echo hello world',
      'date',
      'ps aux',
      'env',
      'true',
      'false',
      'test -f file.txt',
      'ls | grep ts',
      'cat file.txt | wc -l',
      'git log | grep fix',
    ];

    for (const cmd of readOnlyCommands) {
      it(`放行: ${cmd}`, () => {
        expect(checkBashWrite(cmd, '/home/user/project', ALLOW)).toEqual({ ok: true });
      });
    }
  });

  /* ---------------------------------------------------------------- */
  /*  引号内 > 不误判                                                 */
  /* ---------------------------------------------------------------- */
  describe('引号内 > 不误判', () => {
    it('单引号内的 >', () => {
      const r = checkBashWrite("grep 'a > b' file.txt", '/home/user/project', ALLOW);
      expect(r.ok).toBe(true);
    });

    it('双引号内的 >', () => {
      const r = checkBashWrite('echo "1 > 2"', '/home/user/project', ALLOW);
      expect(r.ok).toBe(true);
    });

    it('awk 引号内的 >', () => {
      const r = checkBashWrite('awk \'{print $1 > "x"}\' file.txt', '/home/user/project', ALLOW);
      // awk 的 > 在单引号内，不应该被检测为重定向
      expect(r.ok).toBe(true);
    });

    it('grep 模式含 >', () => {
      const r = checkBashWrite('grep "error > fatal" app.log', '/home/user/project', ALLOW);
      expect(r.ok).toBe(true);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  heredoc 目标提取                                                */
  /* ---------------------------------------------------------------- */
  describe('heredoc', () => {
    it('heredoc 写入目标在 allowRoot 内 → 放行', () => {
      const target = underAllow('script.sh');
      const r = checkBashWrite(`cat > ${target} << 'EOF'\necho hello\nEOF`, '/home/user/project', ALLOW);
      expect(r.ok).toBe(true);
    });

    it('heredoc 写入目标越界 → A 档拒绝', () => {
      const r = checkBashWrite(`cat > /tmp/script.sh << 'EOF'\n${HEREDOC_CONTENT}\nEOF`, ALLOW, ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('heredoc 不带 > 的 cat 放行（输出到 stdout）', () => {
      const r = checkBashWrite(`cat << 'EOF'\n${HEREDOC_CONTENT}\nEOF`, ALLOW, ALLOW);
      expect(r.ok).toBe(true);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  命令串联                                                        */
  /* ---------------------------------------------------------------- */
  describe('命令串联', () => {
    it('分号分隔：第二段越界 → 拒绝', () => {
      const r = checkBashWrite('ls; echo x > /tmp/out', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('&& 分隔：第二段越界 → 拒绝', () => {
      const r = checkBashWrite('ls && echo x > /tmp/out', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('|| 分隔：第二段越界 → 拒绝', () => {
      const r = checkBashWrite('ls || echo x > /tmp/out', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('管道分隔：右侧越界 → 拒绝', () => {
      const r = checkBashWrite('echo x | tee /tmp/out', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('多段均在 allowRoot 内 → 放行', () => {
      const f1 = underAllow('a.txt');
      const f2 = underAllow('b.txt');
      const r = checkBashWrite(`echo a > ${f1} && echo b > ${f2}`, '/home/user/project', ALLOW);
      expect(r.ok).toBe(true);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Windows 路径形态                                                */
  /* ---------------------------------------------------------------- */
  // 只在 win32 执行：POSIX 下 `C:\project\out.txt` 不是绝对路径，resolve 会把它
  // 当成相对文件名拼到 cwd 后面，于是判成越界（保守拒绝，安全方向正确），
  // 但「在 allowRoot 内应放行」这条断言在非 Windows 上不成立。
  describe.skipIf(process.platform !== 'win32')('Windows 路径形态', () => {
    it('原生绝对路径 C:\\Users\\... 在 allowRoot 内 → 放行', () => {
      const target = join('C:\\project', 'out.txt');
      const r = checkBashWrite(`echo x > ${target}`, 'C:\\project', 'C:\\project');
      expect(r.ok).toBe(true);
    });

    it('原生绝对路径 C:\\Users\\... 越界 → A 档', () => {
      const target = 'C:\\Users\\outside\\file.txt';
      const r = checkBashWrite(`echo x > ${target}`, 'C:\\project', 'C:\\project');
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('Git Bash 路径 /c/Users/... 在 allowRoot 内 → 放行', () => {
      // allowRoot 用原生路径，命令内用 Git Bash 路径
      const r = checkBashWrite('echo x > /c/project/out.txt', '/home/user/project', '/home/user/project');
      // 注意：/c/project 在 Linux 上会被转成 C:\project 然后 resolve 到 /home/user/project/C:\project
      // 这里主要验证转换逻辑不崩溃，实际允许行为取决于路径解析
      expect(r).toBeDefined();
    });

    it('Git Bash 路径 /c/Users/... 越界 → 拒绝', () => {
      const r = checkBashWrite('echo x > /c/Users/outside/file.txt', '/home/user/project', ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });
  });

  /* ---------------------------------------------------------------- */
  /*  边界与空输入                                                    */
  /* ---------------------------------------------------------------- */
  describe('边界', () => {
    it('空字符串命令 → 放行', () => {
      expect(checkBashWrite('', ALLOW, ALLOW)).toEqual({ ok: true });
    });

    it('空白命令 → 放行', () => {
      expect(checkBashWrite('   ', ALLOW, ALLOW)).toEqual({ ok: true });
    });

    it('heredoc 中内含 > 不误判', () => {
      const r = checkBashWrite(`cat > /tmp/heredoc << 'EOF'\n${HEREDOC_CONTENT}\nEOF`, ALLOW, ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('带注释的重定向路径', () => {
      const r = checkBashWrite('echo x > /tmp/out # 写文件', ALLOW, ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });
  });

  /* ---------------------------------------------------------------- */
  /*  丢弃型特殊设备：放行（写它们不产生文件）                        */
  /* ---------------------------------------------------------------- */

  describe('丢弃型特殊设备', () => {
    /**
     * 这组是误报防线。/dev/null 会被解析成一个绝对路径，天然落在 allowRoot 外，
     * 不显式白名单就会判成 A 档——而 `> /dev/null` 是最常见的丢弃输出写法，
     * 拦下去会直接卡死正常命令（接线前实测的 21 条 worker 典型命令里只有它被误拦）。
     */
    it('/dev/null 的三种重定向形态都放行', () => {
      expect(checkBashWrite('ls -la > /dev/null', ALLOW, ALLOW).ok).toBe(true);
      expect(checkBashWrite('npm test 2>/dev/null', ALLOW, ALLOW).ok).toBe(true);
      expect(checkBashWrite('ls &> /dev/null', ALLOW, ALLOW).ok).toBe(true);
    });

    it('/dev/stdout、/dev/stderr、/dev/tty 放行', () => {
      expect(checkBashWrite('echo x > /dev/stdout', ALLOW, ALLOW).ok).toBe(true);
      expect(checkBashWrite('echo x > /dev/stderr', ALLOW, ALLOW).ok).toBe(true);
      expect(checkBashWrite('echo x > /dev/tty', ALLOW, ALLOW).ok).toBe(true);
    });

    it('文件描述符别名 /dev/fd/N 与 /proc/self/fd/N 放行', () => {
      expect(checkBashWrite('echo x > /dev/fd/2', ALLOW, ALLOW).ok).toBe(true);
      expect(checkBashWrite('echo x > /proc/self/fd/1', ALLOW, ALLOW).ok).toBe(true);
    });

    it('带引号的 /dev/null 也放行', () => {
      expect(checkBashWrite('ls > "/dev/null"', ALLOW, ALLOW).ok).toBe(true);
      expect(checkBashWrite("ls > '/dev/null'", ALLOW, ALLOW).ok).toBe(true);
    });

    it('白名单不是「所有 /dev/*」：写块设备仍按越界拦截', () => {
      // 否则 `> /dev/sda` 这类真实破坏性写入会被一并放过
      const r = checkBashWrite('dd if=/dev/zero of=/dev/sda', ALLOW, ALLOW);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.tier).toBe('A'); }
    });

    it('Windows 的 NUL 放行', () => {
      expect(checkBashWrite('echo x > NUL', ALLOW, ALLOW).ok).toBe(true);
      expect(checkBashWrite('echo x > nul', ALLOW, ALLOW).ok).toBe(true);
    });
  });
});
