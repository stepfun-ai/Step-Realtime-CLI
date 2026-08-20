import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildNotificationSequence, supportsTerminalNotification, emitTerminalNotification } from '../../../src/agent/background/terminal-notify';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const OSC9_PREFIX = String.fromCharCode(27) + ']9;';
const TMUX_PREFIX = String.fromCharCode(27) + 'Ptmux;';
const TMUX_SUFFIX = String.fromCharCode(27) + '\\';

describe('terminal-notify', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('supportsTerminalNotification', () => {
    it('detects Windows Terminal', () => {
      expect(supportsTerminalNotification({ WT_SESSION: 'abc' })).toBe(true);
    });

    it('detects modern terminals', () => {
      expect(supportsTerminalNotification({ TERM_PROGRAM: 'iTerm.app' })).toBe(true);
      expect(supportsTerminalNotification({ TERM_PROGRAM: 'WezTerm' })).toBe(true);
      expect(supportsTerminalNotification({ TERM_PROGRAM: 'ghostty' })).toBe(true);
      expect(supportsTerminalNotification({ TERM_PROGRAM: 'WarpTerminal' })).toBe(true);
      expect(supportsTerminalNotification({ TERM: 'xterm-kitty' })).toBe(true);
      expect(supportsTerminalNotification({ TERM: 'xterm-ghostty' })).toBe(true);
    });

    it('returns false for unknown terminals', () => {
      expect(supportsTerminalNotification({ TERM: 'xterm-256color' })).toBe(false);
      expect(supportsTerminalNotification({})).toBe(false);
    });
  });

  describe('buildNotificationSequence', () => {
    it('returns empty for blank text', () => {
      expect(buildNotificationSequence('')).toEqual([]);
      expect(buildNotificationSequence('   ')).toEqual([]);
    });

    it('falls back to BEL when OSC 9 not supported', () => {
      const orig = process.env;
      process.env = {};
      const seq = buildNotificationSequence('done');
      expect(seq).toEqual([BEL]);
      process.env = orig;
    });

    it('emits OSC 9 for supported terminals', () => {
      const orig = process.env;
      process.env = { WT_SESSION: 'test' };
      const seq = buildNotificationSequence('后台任务完成');
      expect(seq.length).toBeGreaterThanOrEqual(1);
      expect(seq[0]).toContain(OSC9_PREFIX);
      expect(seq[0]).toContain(BEL);
      process.env = orig;
    });

    it('wraps OSC 9 in tmux DCS passthrough', () => {
      const orig = process.env;
      process.env = { WT_SESSION: 'test', TMUX: 'abc' };
      const seq = buildNotificationSequence('done');
      expect(seq.length).toBe(1);
      expect(seq[0]).toContain(TMUX_PREFIX);
      expect(seq[0]).toContain(TMUX_SUFFIX);
      process.env = orig;
    });

    it('strips control characters from message', () => {
      const orig = process.env;
      process.env = { WT_SESSION: 'test' };
      const seq = buildNotificationSequence('line1\nline2\r\n');
      expect(seq[0]).not.toContain('\n');
      expect(seq[0]).not.toContain('\r');
      process.env = orig;
    });
  });

  describe('emitTerminalNotification', () => {
    it('writes notification to stdout', () => {
      // 隔离终端环境变量：宿主跑在 Windows Terminal 等支持 OSC 9 的终端时，
      // 该用例断言的是 BEL 回退分支，必须先把环境清空。
      const orig = process.env;
      process.env = {};
      const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      emitTerminalNotification('test');
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0][0]).toBe(BEL);
      process.env = orig;
    });

    it('writes OSC 9 sequence under Windows Terminal', () => {
      const orig = process.env;
      process.env = { WT_SESSION: 'test' };
      const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      emitTerminalNotification('test');
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0][0]).toContain(OSC9_PREFIX);
      expect(write.mock.calls[0][0]).toContain(BEL);
      process.env = orig;
    });
  });
});
