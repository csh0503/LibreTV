import { describe, expect, it } from 'vitest';
import { dedupeSeasons, shelfDedupeKey, SHELF_DEFS, isShelfId, parseShelfIds } from './shelf-defs';
import { interleave } from './shelves';
import type { DoubanItem } from './types';

const it_ = (title: string): DoubanItem => ({ id: title, title, cover: 'c' });

describe('shelfDedupeKey', () => {
  it('不同季度归为同一部', () => {
    expect(shelfDedupeKey('咒术回战 第三季')).toBe(shelfDedupeKey('咒术回战'));
    expect(shelfDedupeKey('药屋少女的呢喃 第三季')).toBe(shelfDedupeKey('药屋少女的呢喃'));
    expect(shelfDedupeKey('Re:Zero Season 2')).toBe(shelfDedupeKey('re:zero'));
    expect(shelfDedupeKey('进击的巨人 第三季 Part 2')).toBe(shelfDedupeKey('进击的巨人'));
  });

  it('剧集结尾数字算季数，电影续集不算', () => {
    expect(shelfDedupeKey('守护解放西5', true)).toBe(shelfDedupeKey('守护解放西4', true));
    expect(shelfDedupeKey('疯狂动物城2')).not.toBe(shelfDedupeKey('疯狂动物城'));
    expect(shelfDedupeKey('请回答1988', true)).toBe('请回答1988');
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

describe('parseShelfIds', () => {
  it('一批最多三行，未知的或空的不要', () => {
    expect(parseShelfIds('hot-movies,cn-tv,anime-airing')).toEqual(['hot-movies', 'cn-tv', 'anime-airing']);
    expect(parseShelfIds('hot-movies,hot-movies')).toEqual(['hot-movies']);
    expect(parseShelfIds('hot-movies,nope')).toBeNull();
    expect(parseShelfIds('hot-movies,cn-tv,anime-airing,guoman')).toBeNull();
    expect(parseShelfIds('')).toBeNull();
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

describe('dedupeSeasons', () => {
  it('同一系列只留第一张', () => {
    const rows = [
      { title: '进击的巨人 第三季', isTv: true },
      { title: '全职猎人', isTv: true },
      { title: '进击的巨人 第二季', isTv: true },
    ];
    expect(dedupeSeasons(rows).map((r) => r.title)).toEqual(['进击的巨人 第三季', '全职猎人']);
  });
});
