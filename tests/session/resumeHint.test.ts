import { describe, expect, it } from 'vitest';
import { resumeCommand, resumeHintMeta, resumeHintText } from '../../src/session/resumeHint.js';
import { setLocale } from '../../src/i18n.js';

describe('resumeHint', () => {
  it('命令与 -r/--resume 参数对应', () => {
    expect(resumeCommand('abc123')).toBe('step -r abc123');
  });

  it('文本提示随界面语言本地化，命令独占一行', () => {
    setLocale('zh');
    expect(resumeHintText('abc123')).toBe('恢复本会话：\nstep -r abc123');
    setLocale('en');
    expect(resumeHintText('abc123')).toBe('To resume this session:\nstep -r abc123');
    setLocale('zh');
  });

  it('提示末行只有命令本身（便于终端整行选中复制）', () => {
    for (const locale of ['zh', 'en'] as const) {
      setLocale(locale);
      const lines = resumeHintText('abc123').split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toBe('step -r abc123');
    }
    setLocale('zh');
  });

  it('stream-json meta 结构包含 session resume hint', () => {
    const meta = resumeHintMeta('abc123');
    expect(meta.type).toBe('session.resume_hint');
    expect(meta.session_id).toBe('abc123');
    expect(meta.command).toBe('step -r abc123');
    expect(meta.content).toBe('To resume this session: step -r abc123');
    // 只按 type 判别：不再携带 role 字段
    expect('role' in meta).toBe(false);
    // 可 JSON 序列化为单行
    expect(JSON.stringify(meta)).not.toContain('\n');
  });
});
