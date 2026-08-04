import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stored } from '../../src/agent/message.js';
import { SessionStore } from '../../src/session/store.js';
import { runExportDebugZip } from '../../src/session/debugCli.js';
import { configureLogger, resetLoggerForTest } from '../../src/utils/logger.js';

let dataDir: string;
let store: SessionStore;
const cwd = 'C:/some/project';

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'stepcode-dbgcli-'));
  store = new SessionStore(join(dataDir, 'sessions'));
  resetLoggerForTest();
  configureLogger({ mode: 'headless', dir: join(dataDir, 'logs') });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** 建一个会话并落盘，返回 id。 */
function seed(model = 'step-3.7-flash'): string {
  const s = store.create(cwd, model);
  s.messages.push(stored({ role: 'user', content: 'hi' }, { kind: 'user' }));
  store.save(s);
  store.appendFull(cwd, s.id, s.messages);
  return s.id;
}

describe('runExportDebugZip', () => {
  it('缺省选中该 cwd 下最近更新的会话并导出', async () => {
    const older = seed();
    await new Promise((r) => setTimeout(r, 5));
    const newer = seed();

    const res = await runExportDebugZip({ store, cwd, dataDir });
    expect(res.code).toBe(0);
    expect(res.stderr).toBeUndefined();
    // stdout = zip 路径 + 换行；文件名内含被选中的 session id
    const zipPath = res.stdout!.trimEnd();
    expect(existsSync(zipPath)).toBe(true);
    expect(basename(zipPath)).toContain(newer);
    expect(basename(zipPath)).not.toContain(older);
  });

  it('显式 sessionId 时用它，而非最近会话', async () => {
    const older = seed();
    await new Promise((r) => setTimeout(r, 5));
    seed(); // 更近的一个，不应被选中

    const res = await runExportDebugZip({ store, cwd, sessionId: older, dataDir });
    expect(res.code).toBe(0);
    expect(basename(res.stdout!.trimEnd())).toContain(older);
  });

  it('该 cwd 下无会话 → code 1 + No session found', async () => {
    const res = await runExportDebugZip({ store, cwd: 'E:/empty', dataDir });
    expect(res.code).toBe(1);
    expect(res.stdout).toBeUndefined();
    expect(res.stderr).toBe('No session found for current directory\n');
  });

  it('显式 sessionId 不存在 → code 1（不产出 zip）', async () => {
    seed();
    const res = await runExportDebugZip({ store, cwd, sessionId: 'nonexistent-id', dataDir });
    expect(res.code).toBe(1);
    expect(res.stdout).toBeUndefined();
  });
});
