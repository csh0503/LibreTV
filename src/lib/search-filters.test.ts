import { describe, expect, it } from 'vitest';
import type { AggregatedGroup } from './title-aliases';
import { applySearchFilters, DEFAULT_SEARCH_FILTERS, groupKind, groupRegion, groupStatus, kindOfType, regionOf } from './search-filters';

const g = (name: string, year: string | undefined, typeName: string, remarks = '', sources = 1): AggregatedGroup => ({
  key: name + year,
  name,
  year,
  typeName,
  items: Array.from({ length: sources }, (_, i) => ({ vodId: `${name}${i}`, name, typeName, year, remarks, sourceKey: `s${i}`, sourceName: `s${i}` })),
});

describe('搜索筛选', () => {
  it('分类名 → 类型 / 地区', () => {
    expect(kindOfType('日韩动漫')).toBe('anime');
    expect(kindOfType('动画片')).toBe('anime');
    expect(kindOfType('动作片')).toBe('movie');
    expect(kindOfType('国产剧')).toBe('tv');
    expect(kindOfType('短剧')).toBe('tv');
    expect(kindOfType('纪录片')).toBe('doc');
    expect(kindOfType('大陆综艺')).toBe('show');
    expect(regionOf('国产剧', undefined)).toBe('cn');
    expect(regionOf('日韩动漫', undefined)).toBe('jpkr');
    expect(regionOf('欧美剧', undefined)).toBe('west');
    expect(regionOf('动作片', '美国')).toBe('west');
  });

  it('默认先看相关度（片名就是搜索词 > 以它开头 > 包含它），同一档里年份新的在前', () => {
    const list = [
      g('航海王剧场版Z', '2012', '动画片'),
      g('航海王', '1999', '日韩动漫'),
      g('乐高航海王', '2026', '日韩动漫'),
      g('航海王', '2008', '动漫'),
      g('航海王(真人版)第二季', '2026', '欧美剧'),
      g('海贼王女', '2021', '日韩动漫'),
    ];
    expect(applySearchFilters(list, DEFAULT_SEARCH_FILTERS, 2026, '航海王').map((x) => `${x.name}${x.year}`)).toEqual([
      '航海王2008',
      '航海王1999',
      '航海王(真人版)第二季2026',
      '航海王剧场版Z2012',
      '乐高航海王2026',
      '海贼王女2021',
    ]);
  });

  it('按年份从新到旧，没年份的放最后', () => {
    const out = applySearchFilters([g('a', '1999', '日韩动漫'), g('b', undefined, '动作片'), g('c', '2026', '欧美剧'), g('d', '2019', '动作片')], { ...DEFAULT_SEARCH_FILTERS, sort: 'year-desc' }, 2026);
    expect(out.map((x) => x.name)).toEqual(['c', 'd', 'a', 'b']);
  });

  it('按类型、年份、状态筛；片源最多排序', () => {
    const list = [
      g('航海王', '1999', '日韩动漫', '更新至1180集', 22),
      g('航海王 真人版', '2026', '欧美剧', '第8集完结', 23),
      g('航海王剧场版Z', '2012', '动画片', 'HD', 19),
      g('乐高航海王', '2026', '日韩动漫', '全2集', 14),
    ];
    expect(applySearchFilters(list, { ...DEFAULT_SEARCH_FILTERS, kind: 'anime', sort: 'year-desc' }, 2026).map((x) => x.name)).toEqual(['乐高航海王', '航海王剧场版Z', '航海王']);
    expect(applySearchFilters(list, { ...DEFAULT_SEARCH_FILTERS, year: 'this', sort: 'year-desc' }, 2026).map((x) => x.name)).toEqual(['航海王 真人版', '乐高航海王']);
    expect(applySearchFilters(list, { ...DEFAULT_SEARCH_FILTERS, status: 'airing' }, 2026).map((x) => x.name)).toEqual(['航海王']);
    expect(applySearchFilters(list, { ...DEFAULT_SEARCH_FILTERS, sort: 'sources' }, 2026)[0].name).toBe('航海王 真人版');
    expect(groupKind(list[2])).toBe('anime');
    expect(groupRegion(list[1])).toBe('west');
    expect(groupStatus(list[3])).toBe('ended');
  });
});
