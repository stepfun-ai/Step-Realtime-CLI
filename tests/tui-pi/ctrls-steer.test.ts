/**
 * Ctrl+S 主动插队（⑪）的决策逻辑测试。
 *
 * 覆盖两部分：
 * 1. computeCtrlSSteer 的分流规则——用户草稿与输入框文本插队，系统注入留队列；
 * 2. PiChat 接线防漂移——onCtrlS 必须真接到 handleCtrlS、handleCtrlS 必须走
 *    computeCtrlSSteer 与 activeSteer（与 wiring.test.ts 同款读源码断言，
 *    因为 PiChat 本体无法实例化，原因见 wiring.test.ts 头注）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeCtrlSSteer } from '../../src/tui-pi/steer.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const piChat = readFileSync(join(repoRoot, 'src', 'tui-pi', 'PiChat.ts'), 'utf8');
const chatEditor = readFileSync(join(repoRoot, 'src', 'tui-pi', 'ChatEditor.ts'), 'utf8');

describe('computeCtrlSSteer 分流', () => {
  it('用户草稿 + 输入框文本进 steer，系统注入留队列', () => {
    const prepared = new Set(['sys-inject']);
    const r = computeCtrlSSteer(['draft-a', 'sys-inject', 'draft-b'], prepared, '  editor text ');
    expect(r.steer).toEqual(['draft-a', 'draft-b', 'editor text']);
    expect(r.rest).toEqual(['sys-inject']);
    expect(r.clearEditor).toBe(true);
  });

  it('输入框只有空白时不算一条、不清空标志为 false', () => {
    const r = computeCtrlSSteer(['draft-a'], new Set(), '   ');
    expect(r.steer).toEqual(['draft-a']);
    expect(r.clearEditor).toBe(false);
  });

  it('队列空、输入框空：无可插队内容', () => {
    const r = computeCtrlSSteer([], new Set(), '');
    expect(r.steer).toEqual([]);
    expect(r.rest).toEqual([]);
    expect(r.clearEditor).toBe(false);
  });

  it('全是系统注入时不插队', () => {
    const prepared = new Set(['a', 'b']);
    const r = computeCtrlSSteer(['a', 'b'], prepared, '');
    expect(r.steer).toEqual([]);
    expect(r.rest).toEqual(['a', 'b']);
  });
});

describe('PiChat Ctrl+S 接线', () => {
  it('ChatEditor 声明 onCtrlS 回调', () => {
    expect(chatEditor).toContain('onCtrlS?: () => boolean');
  });

  it('PiChat 把 editor.onCtrlS 接到 handleCtrlS', () => {
    expect(piChat).toMatch(/this\.editor\.onCtrlS = \(\) => this\.handleCtrlS\(\)/);
  });

  it('handleCtrlS 走 computeCtrlSSteer 并写入 activeSteer', () => {
    const start = piChat.indexOf('private handleCtrlS');
    expect(start).toBeGreaterThan(-1);
    const body = piChat.slice(start, start + 1500);
    expect(body).toContain('computeCtrlSSteer');
    expect(body).toContain('this.activeSteer.push(...steer)');
    expect(body).toContain("t('input.ctrlS.steered'");
    expect(body).toContain("t('input.ctrlS.nothing')");
  });
});
