import { describe, expect, it } from 'vitest';
import { shelfDedupeKey, SHELF_DEFS, isShelfId } from './shelf-defs';
import { interleave } from './shelves';
import type { DoubanItem } from './types';

const it_ = (title: string): DoubanItem => ({ id: title, title, cover: 'c' });

describe('shelfDedupeKey', () => {
  it('不同季度归为同一部', () => {
    expect(shelfDedupeKey('咒术回战 第三季')).toBe(shelfDedupeKey('咒术回战'));
    expect(shelfDedupeKey('药屋少女的呢喃 第三季')).toBe(shelfDedupeKey('药屋少女的呢喃'));
    expect(shelfDedupeKey('Re:Zero Season 2')).toBe(shelfDedupeKey('re:zero'));
  });

  it('忽略空格和标点，但不同作品不混', () => {
    expect(shelfDedupeKey('赛博朋克：边缘行者')).toBe(shelfDedupeKey('赛博朋克: 边缘行者'));
    expect(shelfDedupeKey('鲸口脱险')).not.toBe(shelfDedupeKey('希望'));
  });
});

describe('interleave', () => {
  it('按名次交错并去重同名条目', () => {
    const out = interleave([[it_('A'), it_('B'), it_('C')], [it_('X'), it_('A'), it_('Y')]]);
    expect(out.map((i) => i.title)).toEqual(['A', 'X', 'B', 'C', 'Y']);
  });
  it('空列表安全', () => {
    expect(interleave([])).toEqual([]);
    expect(interleave([[], []])).toEqual([]);
  });
});

describe('货架目录', () => {
  it('id 唯一且可识别', () => {
    const ids = SHELF_DEFS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(isShelfId('hot-movies')).toBe(true);
    expect(isShelfId('nope')).toBe(false);
  });
});
