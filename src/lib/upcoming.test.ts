import { describe, expect, it } from 'vitest';
import { cnDateString, lookupChinese, normalizeNative } from './upcoming';

describe('即将播出：日文原名 → 中文名映射', () => {
  const map = new Map([
    [normalizeNative('葬送のフリーレン 第2期'), { title: '葬送的芙莉莲 第二季' }],
    [normalizeNative('チェンソーマン'), { title: '电锯人' }],
  ]);

  it('忽略空格与标点精确命中', () => {
    expect(lookupChinese(map, '葬送のフリーレン　第２期'.replace('２', '2'))?.title).toBe('葬送的芙莉莲 第二季');
    expect(lookupChinese(map, 'チェンソーマン')?.title).toBe('电锯人');
  });

  it('前缀命中（AniList 多带副标题时）且不误命中', () => {
    expect(lookupChinese(map, 'チェンソーマン レゼ篇')?.title).toBe('电锯人');
    expect(lookupChinese(map, 'まったく別の作品')).toBeUndefined();
  });

  it('按北京时间取日期', () => {
    // 2026-10-16 17:00 UTC = 2026-10-17 01:00 北京时间
    expect(cnDateString(Date.UTC(2026, 9, 16, 17, 0))).toBe('2026-10-17');
  });
});
