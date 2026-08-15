import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(repoRoot, p), 'utf8');
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * 这组测试守的是「NODE_ENV 只在 bin 引导里设置一次」这个加载结构。
 *
 * ## 约束的由来（Ink 时代的空白屏事故）
 *
 * `react` 与 `react-reconciler` 的 CJS 入口按 require 那一刻的 `NODE_ENV` 分流成
 * production / development 两套构建，两者必须落在同一套。错配（react dev + reconciler
 * prod）时 reconciler 调度静默失效——`render()` 正常返回、根组件从未被调用、终端零输出、
 * 无任何异常，而所有功能测试照常全绿。2026-08-03 实测（外部一律 `env -u NODE_ENV`）：
 * 在 `cli.tsx` 里加那道「兜底」→ stdout **0 字节**；走 `main.ts` 引导 → 2000+ 字节。
 * 根因是 tsc 的 JSX transform 在产物顶部注入 `import 'react/jsx-runtime'`，让 react 主包
 * 在源码 import 之前就分流完毕，`cli.tsx` 里的赋值只够得到随后由 ink 拉起的 reconciler。
 *
 * ## M5 之后为什么还留着
 *
 * Ink、react 与 JSX 都已随 M5 删除（`cli.tsx` → `cli.ts`），那个具体故障不再可能。保留的
 * 是结构约束本身，它服务两件仍然成立的事：一是 `NODE_ENV` 的设置点唯一（引导文件），
 * 不会出现两处赋值互相打脸；二是引导文件不含静态 import，保证赋值发生在任何模块求值之前，
 * 依赖里按 NODE_ENV 分支的代码（开发期告警、额外校验）在分发形态下拿到的是 production。
 *
 * 判据仍是静态断言：这类失效不抛异常、功能测试测不出来。
 */
/**
 * 「给 NODE_ENV 赋值」的两种成员访问写法。
 *
 * `process.env.NODE_ENV`（点号）与 `process.env['NODE_ENV']`（方括号）在语义上等价，
 * 但对 esbuild 的 `define` 不等价——只有点号形式会被匹配。`src/main.ts` 因此刻意用
 * 方括号（见该处注释）。防御类断言必须**同时封住两种**：否则方括号就成了绕过通道，
 * 有人在 `cli.ts` 里用它设 NODE_ENV 会重新制造空白屏事故而测试全绿。
 */
const NODE_ENV_ASSIGN = /process\.env\s*(?:\.NODE_ENV|\[\s*['"]NODE_ENV['"]\s*\])\s*(?:\?\?=|=[^=])/;

describe('NODE_ENV 分流的加载结构约束', () => {
  it('bin 入口 main.ts 先设 NODE_ENV、再动态加载 cli.js', () => {
    const src = read('src/main.ts');
    // 同时接受点号与方括号写法：当前用方括号以避开 esbuild 的 assign-to-define 警告
    // （理由见 src/main.ts 该行注释），但本用例守的是「先设置、后加载」的顺序，
    // 不该绑定具体成员访问语法。
    const envIdx = src.search(NODE_ENV_ASSIGN);
    // 匹配 `import('./cli.js')`（不论顶层 await 还是 .then 形式）：本用例守的是
    // 「先设置 NODE_ENV、后加载」的顺序，不绑定是否顶层 await。
    const loadIdx = src.indexOf("import('./cli.js')");
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(loadIdx).toBeGreaterThanOrEqual(0);
    expect(envIdx).toBeLessThan(loadIdx);
  });

  it('main.ts 没有任何静态 import，任何模块都不可能先于赋值求值', () => {
    const codeOnly = stripComments(read('src/main.ts'));
    // 只允许动态 import()；静态 import 声明一律禁止
    expect(codeOnly).not.toMatch(/^\s*import\s/m);
    expect(codeOnly).not.toMatch(/\brequire\s*\(/);
  });

  it('main.ts 用 ??= 赋值，不覆盖用户显式设置的 NODE_ENV', () => {
    // 断言源码形态而非运行时：本进程的 NODE_ENV 已被 vitest 设为 test，
    // 直接 import 既改不动也测不出差别。
    expect(read('src/main.ts')).toContain('??=');
  });

  it('package.json 的 bin 指向引导产物 dist/main.js', () => {
    const pkg = JSON.parse(read('package.json')) as { bin: Record<string, string> };
    expect(pkg.bin['step']).toBe('dist/main.js');
  });

  it('package.json 的 dev 脚本走引导入口而非 cli.ts', () => {
    // pnpm dev 若直接跑 cli.ts，开发者会撞上「两包一致走 dev」以外的分流组合，
    // 且与分发形态的行为不一致。
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['dev']).toContain('src/main.ts');
    expect(pkg.scripts['dev']).not.toContain('cli.ts');
  });

  it('cli.ts 不设置 NODE_ENV（设置点唯一：只在 bin 引导 main.ts）', () => {
    const codeOnly = stripComments(read('src/cli.ts'));
    // 用共享正则同时封住点号与方括号两种写法，见 NODE_ENV_ASSIGN 的注释
    expect(codeOnly).not.toMatch(NODE_ENV_ASSIGN);
  });

  it('cli.ts 不 import 任何设置 NODE_ENV 的兜底模块', () => {
    const codeOnly = stripComments(read('src/cli.ts'));
    expect(codeOnly).not.toMatch(/import\s+['"]\.\/env\.js['"]/);
  });

  it('src/env.ts 不存在（该兜底已实测证明净有害，不得加回）', () => {
    expect(existsSync(join(repoRoot, 'src/env.ts'))).toBe(false);
  });

  it('bundle 构建脚本用 define 把 NODE_ENV 静态折叠为 production', () => {
    // bundle 不经 main.ts 引导，靠编译期折叠取得与引导路径一致的 production 默认。
    const src = read('scripts/build-bundle.mjs');
    expect(src).toMatch(/define\s*:/);
    expect(src).toMatch(/process\.env\.NODE_ENV/);
    expect(src).toMatch(/"production"|'production'/);
  });

  it('bundle 构建脚本静音 assign-to-define，且写明了理由', () => {
    // define 与 main.ts 的运行时赋值分工服务两条分发路径，esbuild 视之为冲突并报警。
    // 静音是刻意的，但必须留下理由——否则后人只会看到一个被压掉的警告。
    const src = read('scripts/build-bundle.mjs');
    expect(src).toMatch(/logOverride/);
    expect(src).toMatch(/'assign-to-define':\s*'silent'/);
    expect(src).toContain('唯一预期来源');
  });

  // 这条守的是静音换来的那个风险：esbuild 目前只警告、不改写赋值左值，但该行为没有
  // 稳定性承诺。若将来真的改写，产物里会出现 `"production" ??= "production"`——非法左值，
  // 运行时直接 SyntaxError，而 build 阶段一声不响（是它自己生成的）。
  //
  // 用 skipIf 而不是「产物不存在就静默 return」：后者会把「没检查」伪装成「检查通过」。
  it.skipIf(!existsSync(join(repoRoot, 'dist-bundle/step.mjs')))(
    'bundle 产物里 NODE_ENV 赋值仍是合法左值（守 esbuild define 行为变化）',
    () => {
      const src = readFileSync(join(repoRoot, 'dist-bundle/step.mjs'), 'utf8');
      // 赋值语句必须还在，且左侧仍是成员表达式而非被折叠的字符串字面量
      expect(src).toMatch(/process\.env\.NODE_ENV\s*\?\?=/);
      expect(src).not.toMatch(/["']production["']\s*\?\?=/);
    },
  );
});
