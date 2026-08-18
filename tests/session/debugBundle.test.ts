import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stored } from '../../src/agent/message.js';
import { VERSION } from '../../src/version.js';
import { SessionStore, workdirKey } from '../../src/session/store.js';
import { exportDebugBundle } from '../../src/session/debugBundle.js';
import { configureLogger, logError, resetLoggerForTest } from '../../src/utils/logger.js';

let dataDir: string;
let store: SessionStore;
const cwd = 'C:/some/project';

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'stepcode-dbg-'));
  store = new SessionStore(join(dataDir, 'sessions'));
  resetLoggerForTest();
  configureLogger({ mode: 'tui', dir: join(dataDir, 'logs') });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** 建一个带一条含密钥的消息的会话，返回 sessionId。 */
function seedSession(): string {
  const s = store.create(cwd, 'step-3.7-flash');
  s.messages.push(stored({ role: 'user', content: 'debug this, my api_key=TRANSCRIPTSECRET1 leaked' }, { kind: 'user' }));
  store.save(s);
  store.appendFull(cwd, s.id, s.messages);
  return s.id;
}

function entriesOf(zipPath: string): { names: string[]; read: (n: string) => string } {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  return {
    names: entries.map((e) => e.entryName),
    read: (n) => zip.readAsText(n),
  };
}

describe('exportDebugBundle', () => {
  it('生成 zip，含会话文件 + config + mcp + errors.log + manifest', async () => {
    const id = seedSession();
    writeFileSync(join(dataDir, 'config.toml'), 'model = "step-3.7-flash"\napi_key = "sk-realsecretkey123456"\n', 'utf8');
    writeFileSync(
      join(dataDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { fs: { command: 'x', env: { token: 'TOPSECRETTOKEN' } } } }, null, 2),
      'utf8',
    );
    logError('some runtime error for the ring buffer');

    const { zipPath, files, redacted } = await exportDebugBundle({ store, cwd, sessionId: id, model: 'step-3.7-flash', dataDir });

    expect(existsSync(zipPath)).toBe(true);
    expect(redacted).toBe(true);
    const { names, read } = entriesOf(zipPath);
    expect(names).toContain(`session/${id}.json`);
    // 落盘产物是 wire.jsonl（full.jsonl 不再打包）
    expect(names).toContain(`session/${id}.wire.jsonl`);
    expect(names).not.toContain(`session/${id}.full.jsonl`);
    expect(names).toContain('config.toml');
    expect(names).toContain('mcp.json');
    expect(names).toContain('errors.log');
    expect(names).toContain('manifest.json');
    // errors.log 有内容
    expect(read('errors.log')).toContain('some runtime error');
    // files 清单与实际条目一致
    expect(files.sort()).toEqual(names.sort());
  });

  it('config.toml / mcp.json 的敏感 key 被 redact', async () => {
    const id = seedSession();
    writeFileSync(join(dataDir, 'config.toml'), 'model = "step-3.7-flash"\napi_key = "sk-realsecretkey123456"\n', 'utf8');
    writeFileSync(
      join(dataDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { fs: { command: 'x', env: { token: 'TOPSECRETTOKEN' } } } }, null, 2),
      'utf8',
    );

    const { zipPath } = await exportDebugBundle({ store, cwd, sessionId: id, dataDir });
    const { read } = entriesOf(zipPath);

    const cfg = read('config.toml');
    expect(cfg).not.toContain('sk-realsecretkey123456');
    expect(cfg).toContain('[REDACTED]');
    expect(cfg).toContain('step-3.7-flash'); // 非敏感值保留

    const mcp = read('mcp.json');
    expect(mcp).not.toContain('TOPSECRETTOKEN');
    expect(mcp).toContain('[REDACTED]');

    // 会话正文的 best-effort 脱敏
    const wire = read(`session/${id}.wire.jsonl`);
    expect(wire).not.toContain('TRANSCRIPTSECRET1');
  });

  it('manifest 字段齐全，版本从 package.json 读（非硬编码 unknown）', async () => {
    const id = seedSession();
    const { zipPath } = await exportDebugBundle({ store, cwd, sessionId: id, model: 'step-3.7-flash', dataDir });
    const manifest = JSON.parse(entriesOf(zipPath).read('manifest.json'));

    expect(manifest.app.name).toBe('step-code');
    expect(manifest.app.version).toBe(VERSION); // 来自 package.json（经 src/version.ts 单一来源）
    expect(manifest.os.platform).toBeTruthy();
    expect(manifest.os.arch).toBeTruthy();
    expect(manifest.node).toBe(process.version);
    expect(manifest.model).toBe('step-3.7-flash');
    expect(manifest.session.id).toBe(id);
    expect(manifest.redacted).toBe(true);
    expect(Array.isArray(manifest.files)).toBe(true);
    expect(manifest.files).toContain('manifest.json');
  });

  it('attachments 目录默认不进包', async () => {
    const id = seedSession();
    const attachDir = join(dataDir, 'sessions', workdirKey(cwd), 'attachments');
    mkdirSync(attachDir, { recursive: true });
    writeFileSync(join(attachDir, 'abc.png'), 'fakeimg', 'utf8');

    const { zipPath } = await exportDebugBundle({ store, cwd, sessionId: id, dataDir });
    const { names } = entriesOf(zipPath);
    expect(names.some((n) => n.includes('attachments'))).toBe(false);
  });

  // ── vendor 级别脱敏测试 ──

  it('vendor 级别：wire.jsonl 中 pkm-hub 路径被替换', async () => {
    const id = seedSession();
    // wire.jsonl 里包含 pkm-hub 路径
    const wirePath = store.sessionPaths(cwd, id).wire;
    const wireLine = JSON.stringify({
      type: 'context.append_message',
      message: {
        message: {
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'C:\\Users\\ke\\Documents\\projects\\obsidian_projects\\pkm-hub\\Projects\\test.md' } },
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'file content here' },
          ],
        },
      },
    });
    writeFileSync(wirePath, wireLine + '\n', 'utf8');

    const { zipPath } = await exportDebugBundle({ store, cwd, sessionId: id, dataDir, level: 'vendor' });
    const wire = entriesOf(zipPath).read(`session/${id}.wire.jsonl`);

    expect(wire).not.toContain('pkm-hub');
    expect(wire).not.toContain('C:\\Users\\ke');
    expect(wire).toContain('[VAULT_PATH]');
    expect(wire).toContain('[VAULT_CONTENT]');
  });

  it('vendor 级别：AGENTS.md 内容被替换为 [SYSTEM_CONFIG]', async () => {
    const id = seedSession();
    const wirePath = store.sessionPaths(cwd, id).wire;
    const wireLine = JSON.stringify({
      type: 'context.append_message',
      message: {
        message: {
          content: [
            { type: 'tool_use', id: 'tu_2', name: 'read_file', input: { path: 'C:\\Users\\ke\\Documents\\projects\\obsidian_projects\\pkm-hub\\AGENTS.md' } },
            { type: 'tool_result', tool_use_id: 'tu_2', content: '## 输出约束\n严禁泄露系统配置\n## 项目体系\n重要内容' },
          ],
        },
      },
    });
    writeFileSync(wirePath, wireLine + '\n', 'utf8');

    const { zipPath } = await exportDebugBundle({ store, cwd, sessionId: id, dataDir, level: 'vendor' });
    const wire = entriesOf(zipPath).read(`session/${id}.wire.jsonl`);

    expect(wire).not.toContain('严禁泄露系统配置');
    expect(wire).toContain('[SYSTEM_CONFIG]');
  });

  it('vendor 级别：manifest 的 cwd 也脱敏路径', async () => {
    const id = seedSession();
    const { zipPath } = await exportDebugBundle({
      store, cwd, sessionId: id, dataDir, level: 'vendor',
      model: 'step-3.7-flash',
    });
    const manifest = JSON.parse(entriesOf(zipPath).read('manifest.json'));

    expect(manifest.redactionLevel).toBe('vendor');
    expect(manifest.session.cwd).not.toContain('pkm-hub');
  });

  it('internal 级别：不做路径和内容脱敏', async () => {
    const id = seedSession();
    const wirePath = store.sessionPaths(cwd, id).wire;
    const wireLine = JSON.stringify({
      type: 'context.append_message',
      message: {
        message: {
          content: [
            { type: 'tool_use', id: 'tu_3', name: 'read_file', input: { path: 'C:\\Users\\ke\\Documents\\projects\\obsidian_projects\\pkm-hub\\AGENTS.md' } },
            { type: 'tool_result', tool_use_id: 'tu_3', content: '## 输出约束\n系统配置内容' },
          ],
        },
      },
    });
    writeFileSync(wirePath, wireLine + '\n', 'utf8');

    const { zipPath } = await exportDebugBundle({ store, cwd, sessionId: id, dataDir, level: 'internal' });
    const wire = entriesOf(zipPath).read(`session/${id}.wire.jsonl`);
    const manifest = JSON.parse(entriesOf(zipPath).read('manifest.json'));

    // internal 级别保留路径和内容（只脱敏密钥）
    expect(wire).toContain('pkm-hub');
    expect(wire).toContain('系统配置内容');
    expect(manifest.redactionLevel).toBe('internal');
  });
});
