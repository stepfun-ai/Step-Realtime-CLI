import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(repoRoot, p), 'utf8');
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * 这组测试守的是一个**静默失效**风险：`react` 与 `react-reconciler` 的 CJS 入口按 require
 * 那一刻的 `NODE_ENV` 分流成 production / development 两套构建，两者必须落在同一套。错配
 * （react dev + reconciler prod）时 reconciler 调度静默失效——ink 的 `render()` 正常返回、
 * 根组件从未被调用、终端零输出、无任何异常，表现为 TUI 启动即卡死在空白屏，而所有功能
 * 测试照常全绿。所以只能用静态断言守住加载结构。
 *
 * ## 为什么护栏的方向是「禁止在 cli.tsx 里设置」，而不是「要求它设置」
 *
 * 直觉会认为多设一层兜底更安全，实测相反（2026-08-03，外部一律 `env -u NODE_ENV`，用
 * require hook 记录各包实际加载的构建）：
 *
 * | 被测路径 | react | reconciler | stdout | 结果 |
 * |---|---|---|---|---|
 * | `node dist/cli.js`（cli 曾有 `import './env.js'`） | dev | prod | **0 字节** | 空白屏 |
 * | `node dist/main.js`（引导入口） | prod | prod | 2000+ | 正常 |
 * | `node dist-bundle/step.mjs`（esbuild define 折叠） | 折叠 | 折叠 | 2000+ | 正常 |
 * | `tsx src/cli.tsx`（cli 曾有 `import './env.js'`） | dev | prod | **0 字节** | 空白屏 |
 * | `tsx src/main.ts`（`pnpm dev`） | prod | prod | 2000+ | 正常 |
 * | `NODE_ENV=development tsx src/cli.tsx`（两包一致） | dev | dev | 2000+ | 正常 |
 *
 * 原因：tsc 的 JSX transform 在 `dist/cli.js` 顶部注入 `import 'react/jsx-runtime'`，排在
 * 所有源码 import 之前，而它内部 `require('react')` 让 **react 主包**在那一刻就分流完毕。
 * 在 `cli.tsx` 里设 `NODE_ENV` 只够得到随后由 ink 拉起的 reconciler，够不到已经分流的
 * react——那道「兜底」因此不是没用，而是**主动制造错配**：把最后一行（两包一致走 dev、
 * 完全可用）变成第一行（错配、静默卡死）。它在 bin 与 bundle 路径上又都只是 no-op。
 *
 * 当前结构：bin → `main.ts`（不含 JSX、无静态 import，先设 `NODE_ENV` 再 `await import`）；
 * bundle → esbuild `define` 静态折叠；`cli.tsx` → **不设，交由上游决定**。
 */
describe('NODE_ENV 分流的加载结构约束', () => {
  it('bin 入口 main.ts 先设 NODE_ENV、再动态加载 cli.js', () => {
    const src = read('src/main.ts');
    const envIdx = src.indexOf("process.env.NODE_ENV ??= 'production'");
    const loadIdx = src.indexOf("await import('./cli.js')");
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(loadIdx).toBeGreaterThanOrEqual(0);
    expect(envIdx).toBeLessThan(loadIdx);
  });

  it('main.ts 没有任何静态 import（含 JSX 注入），react 不可能先于赋值求值', () => {
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

  it('package.json 的 dev 脚本走引导入口而非 cli.tsx', () => {
    // pnpm dev 若直接跑 cli.tsx，开发者会撞上「两包一致走 dev」以外的分流组合，
    // 且与分发形态的行为不一致。
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['dev']).toContain('src/main.ts');
    expect(pkg.scripts['dev']).not.toContain('cli.tsx');
  });

  it('cli.tsx 不设置 NODE_ENV（设了会制造 react/reconciler 错配 → 空白屏）', () => {
    const codeOnly = stripComments(read('src/cli.tsx'));
    expect(codeOnly).not.toMatch(/process\.env\.NODE_ENV\s*(\?\?=|=[^=])/);
  });

  it('cli.tsx 不 import 任何设置 NODE_ENV 的兜底模块', () => {
    const codeOnly = stripComments(read('src/cli.tsx'));
    expect(codeOnly).not.toMatch(/import\s+['"]\.\/env\.js['"]/);
  });

  it('src/env.ts 不存在（该兜底已实测证明净有害，不得加回）', () => {
    expect(existsSync(join(repoRoot, 'src/env.ts'))).toBe(false);
  });

  it('bundle 构建脚本用 define 把 NODE_ENV 静态折叠为 production', () => {
    // bundle 不经 main.ts 引导，靠编译期折叠保证两包同套。
    const src = read('scripts/build-bundle.mjs');
    expect(src).toMatch(/define\s*:/);
    expect(src).toMatch(/process\.env\.NODE_ENV/);
    expect(src).toMatch(/"production"|'production'/);
  });
});
