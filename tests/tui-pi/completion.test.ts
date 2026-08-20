/**
 * 补全适配层的测试。
 *
 * 匹配语义本身由 `tests/tui/completions.test.ts` 钉住（那是共用的纯逻辑），
 * 这里只测适配部分：触发条件、i18n key 的查表、以及 applyCompletion 的文本替换
 * ——最后这条最容易错，写坏了表现为补全后输入框里出现半截命令。
 */
import { describe, expect, it } from 'vitest';
import { ChatAutocompleteProvider } from '../../src/tui-pi/completion.js';

function mk(): ChatAutocompleteProvider {
  return new ChatAutocompleteProvider({
    models: { step35: { model: 'step-3.5-flash', displayName: 'Step 3.5' } },
    thinkChoices: ['high', 'medium', 'low', 'off'],
    files: ['src/cli.ts', 'src/tui-pi/PiChat.ts'],
  });
}

describe('ChatAutocompleteProvider.getSuggestions', () => {
  it('/ 开头给命令候选，description 已从 i18n key 查成文案', async () => {
    const res = await mk().getSuggestions(['/mod'], 0, 4);
    expect(res).not.toBeNull();
    expect(res!.prefix).toBe('/mod');
    expect(res!.items[0]!.label).toBe('/model');
    expect(res!.items[0]!.value).toBe('/model ');
    // 不能是 'cmd.model' 这种 key 原样漏出去
    expect(res!.items[0]!.description).not.toContain('cmd.');
    expect(res!.items[0]!.description!.length).toBeGreaterThan(0);
  });

  it('/cmd <partial> 给参数候选', async () => {
    const res = await mk().getSuggestions(['/model step'], 0, 11);
    expect(res!.items[0]).toEqual({ value: '/model step35 ', label: 'step35', description: 'Step 3.5' });
  });

  it('@ 开头给文件候选', async () => {
    const res = await mk().getSuggestions(['@PiChat'], 0, 7);
    expect(res!.items.map((i) => i.label)).toEqual(['src/tui-pi/PiChat.ts']);
    expect(res!.items[0]!.value).toBe('@src/tui-pi/PiChat.ts ');
  });

  it('文件索引未回填时 @ 补全为空而不是报错', async () => {
    const p = new ChatAutocompleteProvider({});
    expect(await p.getSuggestions(['@x'], 0, 2)).toBeNull();
    p.setFiles(['a/b.ts']);
    expect((await p.getSuggestions(['@b'], 0, 2))!.items).toHaveLength(1);
  });

  it('普通文本与句中斜杠不触发', async () => {
    const p = mk();
    expect(await p.getSuggestions(['hello'], 0, 5)).toBeNull();
    expect(await p.getSuggestions(['看 src/cli.ts'], 0, 13)).toBeNull();
    expect(await p.getSuggestions(['日期 2026/08/14'], 0, 13)).toBeNull();
  });

  it('无命中时返回 null（Editor 据此不弹菜单）', async () => {
    expect(await mk().getSuggestions(['/zzzz'], 0, 5)).toBeNull();
  });
});

describe('ChatAutocompleteProvider.applyCompletion', () => {
  const p = mk();

  it('替换掉光标前的 prefix，保留行尾内容，光标落在插入文本之后', () => {
    const r = p.applyCompletion(['/mod'], 0, 4, { value: '/model ', label: '/model' }, '/mod');
    expect(r.lines).toEqual(['/model ']);
    expect(r.cursorCol).toBe(7);
  });

  it('光标不在行尾时只替换 prefix 段', () => {
    const r = p.applyCompletion(['/mod 备注'], 0, 4, { value: '/model ', label: '/model' }, '/mod');
    expect(r.lines).toEqual(['/model  备注']);
    expect(r.cursorCol).toBe(7);
  });

  it('多行输入只改光标所在行', () => {
    const r = p.applyCompletion(['第一行', '/mod'], 1, 4, { value: '/model ', label: '/model' }, '/mod');
    expect(r.lines).toEqual(['第一行', '/model ']);
    expect(r.cursorLine).toBe(1);
  });
});
