import { describe, expect, it } from 'vitest';
import { resumeCommand, resumeHintMeta, resumeHintText } from '../../src/session/resumeHint.js';
import { setLocale } from '../../src/i18n.js';

describe('resumeHint', () => {
  it('命令与 -r/--resume 参数对应', () => {
    expect(resumeCommand('abc123')).toBe('step -r abc123');
  });

  it('文本提示随界面语言本地化', () => {
    setLocale('zh');
    expect(resumeHintText('abc123')).toBe('恢复本会话：step -r abc123');
    setLocale('en');
    expect(resumeHintText('abc123')).toBe('To resume this session: step -r abc123');
    setLocale('zh');
  });

  it('stream-json meta 结构包含 session resume hint', () => {
    const meta = resumeHintMeta('abc123');
    expect(meta.role).toBe('meta');
    expect(meta.type).toBe('session.resume_hint');
    expect(meta.session_id).toBe('abc123');
    expect(meta.command).toBe('step -r abc123');
    expect(meta.content).toBe('To resume this session: step -r abc123');
    // 可 JSON 序列化为单行
    expect(JSON.stringify(meta)).not.toContain('\n');
  });
});
