import { describe, expect, it } from 'vitest';

import { CAPABILITY_GATED_TOOLS, filterToolsByCapabilities } from '../../src/tools/capabilities.js';

describe('filterToolsByCapabilities（能力门控工具卸载）', () => {
  const ALL = ['read_file', 'read_media', 'bash', 'edit_file'] as const;

  it('有 image_in 时 read_media 保留', () => {
    expect(filterToolsByCapabilities(ALL, ['image_in'])).toEqual(ALL);
  });

  it('无 image_in 时 read_media 被卸载，其余工具不受影响', () => {
    expect(filterToolsByCapabilities(ALL, ['thinking'])).toEqual(['read_file', 'bash', 'edit_file']);
  });

  it('capabilities 为 undefined（裸模型/未命中别名）时不卸载任何工具，保留门控工具', () => {
    expect(filterToolsByCapabilities(ALL, undefined)).toEqual(ALL);
  });

  it('capabilities 为空数组时门控工具卸载（明确声明但未包含所需能力）', () => {
    expect(filterToolsByCapabilities(ALL, [])).toEqual(['read_file', 'bash', 'edit_file']);
  });

  it('门控映射登记点：read_media 需要 image_in', () => {
    expect(CAPABILITY_GATED_TOOLS['read_media']).toBe('image_in');
  });

  it('不修改入参数组（纯函数）', () => {
    const input = [...ALL];
    filterToolsByCapabilities(input, []);
    expect(input).toEqual(ALL);
  });
});
