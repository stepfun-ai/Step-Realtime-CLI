import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 命名脚本条目：名字 + 首行 `// description:` 注释解析出的描述（无则 undefined）。 */
export interface ScriptInfo {
  name: string;
  description?: string;
}

/** 首行描述注释前缀（save_as 写入、list 解析共用同一约定）。 */
const DESCRIPTION_RE = /^\/\/\s*description:\s*(.+?)\s*$/;

/**
 * 命名脚本存储：`<cwd>/.step-code/workflows/<name>.js`（.step-code/ 已在 gitignore）。
 * 结构化重复性任务的可复用工件层：dynamic_workflow 的 save_as 写入，name 按名加载执行。
 */
export class ScriptStore {
  /** 脚本名合法字符：字母（含中文）/ 数字 / 下划线 / 连字符；拒绝路径分隔符防穿越。 */
  private static readonly NAME_RE = /^[\p{L}\p{N}_-]+$/u;

  static dir(cwd: string): string {
    return path.join(cwd, '.step-code', 'workflows');
  }

  static isValidName(name: string): boolean {
    return ScriptStore.NAME_RE.test(name);
  }

  static filePathFor(cwd: string, name: string): string {
    return path.join(ScriptStore.dir(cwd), `${name}.js`);
  }

  /** 解析脚本首行的 `// description:` 注释（无则 undefined）。 */
  static parseDescription(script: string): string | undefined {
    const nl = script.indexOf('\n');
    const firstLine = nl === -1 ? script : script.slice(0, nl);
    return DESCRIPTION_RE.exec(firstLine)?.[1];
  }

  /** 保存命名脚本（同名覆盖更新）；返回落盘路径。名字非法时抛错。description 非空且脚本无首行描述注释时写入首行注释。 */
  static async save(cwd: string, name: string, script: string, description?: string): Promise<string> {
    if (!ScriptStore.isValidName(name)) {
      throw new Error(`非法脚本名「${name}」：只允许字母（含中文）、数字、下划线、连字符。`);
    }
    await mkdir(ScriptStore.dir(cwd), { recursive: true });
    const filePath = ScriptStore.filePathFor(cwd, name);
    const desc = description?.trim().replace(/\s+/g, ' ');
    const body =
      desc !== undefined && desc !== '' && ScriptStore.parseDescription(script) === undefined
        ? `// description: ${desc}\n${script}`
        : script;
    await writeFile(filePath, body, 'utf-8');
    return filePath;
  }

  /** 按名加载脚本；未命中（或名字非法）返回 undefined。 */
  static async load(cwd: string, name: string): Promise<string | undefined> {
    if (!ScriptStore.isValidName(name)) return undefined;
    try {
      return await readFile(ScriptStore.filePathFor(cwd, name), 'utf-8');
    } catch {
      return undefined;
    }
  }

  /** 列出全部可用脚本（名字 + 首行描述，按名字字典序）；目录不存在返回空表。 */
  static async list(cwd: string): Promise<ScriptInfo[]> {
    let entries: string[];
    try {
      entries = await readdir(ScriptStore.dir(cwd));
    } catch {
      return [];
    }
    const names = entries
      .filter((e) => e.endsWith('.js'))
      .map((e) => e.slice(0, -'.js'.length))
      .sort();
    return Promise.all(
      names.map(async (name): Promise<ScriptInfo> => {
        try {
          const text = await readFile(ScriptStore.filePathFor(cwd, name), 'utf-8');
          return { name, description: ScriptStore.parseDescription(text) };
        } catch {
          return { name };
        }
      }),
    );
  }
}
