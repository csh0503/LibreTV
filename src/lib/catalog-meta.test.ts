import { describe, expect, it } from 'vitest';
import { mergeGenres, mergeWorkMeta, normalizeArea, pickYear, unifiedRating } from './catalog-meta';
import { mergeSameWorks, similarTitles } from './work-identity';
import type { DoubanItem } from './types';

const item = (p: Partial<DoubanItem> & { id: string; title: string }): DoubanItem => ({ cover: 'c', isTv: true, ...p });

describe('统一评分', () => {
  it('各站按偏差校正后加权平均：B站偏高打折、Bangumi 偏低补回', () => {
    expect(unifiedRating({ douban: 8.5 })).toBe('8.5');
    expect(unifiedRating({ bili: 9.9 })).toBe('9.2');
    expect(unifiedRating({ bangumi: 7.5 })).toBe('8.0');
    // 豆瓣权重最大：两边差很多时靠近豆瓣
    expect(unifiedRating({ douban: 9.0, bili: 9.9 })).toBe('9.1');
    expect(unifiedRating({})).toBeUndefined();
  });
});

describe('年份交叉核对', () => {
  it('多数来源说了算，筛选填的年份不算', () => {
    expect(pickYear([
      { year: '2025', source: 'bili' },
      { year: '2026', source: 'douban' },
      { year: '2026', source: 'tmdb' },
    ]).year).toBe('2026');
    expect(pickYear([{ year: '2026', soft: true, source: 'bili' }, { year: '2011', source: 'bangumi' }]).year).toBe('2011');
    expect(pickYear([{ year: '2026', soft: true, source: 'bili' }])).toEqual({ year: '2026', soft: true });
  });
});

describe('题材与地区统一', () => {
  it('TMDB 的合并题材拆开，几个来源都说的排前面，动画放第一', () => {
    expect(mergeGenres(['剧情 爱情', '动画 恋爱 校园', '动作冒险 动画'])?.split(' ').slice(0, 3)).toEqual(['动画', '爱情', '剧情']);
    expect(mergeGenres(['科幻奇幻'])).toBe('科幻 奇幻');
  });
  it('地区写法统一', () => {
    expect(normalizeArea('大陆')).toBe('中国大陆');
    expect(normalizeArea('美国 加拿大 英国')).toBe('美国 加拿大');
  });
});

describe('合成一份资料', () => {
  it('评分明细、年份、题材都来自全部来源', () => {
    const merged = mergeWorkMeta(item({ id: '1', title: '甲', rating: '8.8', year: '2026', genres: '动画 奇幻' }), [
      item({ id: '1', title: '甲', rating: '8.8', year: '2026', genres: '动画 奇幻' }),
      item({ id: 'bgm_1', title: '甲', rating: '8.0', year: '2026', genres: '异世界 奇幻' }),
      item({ id: 'bili_idx_1', title: '甲', rating: '9.7', year: '2026', yearSoft: true }),
    ]);
    expect(merged.ratings).toEqual({ douban: 8.8, bangumi: 8, bili: 9.7 });
    expect(merged.genres?.startsWith('动画 奇幻')).toBe(true);
    expect(merged.year).toBe('2026');
  });
});

describe('译名不同的同一部', () => {
  it('字大多重合、同年、同为剧集才认', () => {
    const a = item({ id: '37441858', title: '躲在超市后门抽烟的两人', year: '2026' });
    const b = item({ id: 'bgm_571784', title: '在超市后门吸烟的二人', year: '2026' });
    expect(similarTitles(a, b)).toBe(true);
    expect(mergeSameWorks([a, b])).toHaveLength(1);
  });
  it('续作、不同年份、长短差很多的不认', () => {
    expect(similarTitles(item({ id: '1', title: '凡人修仙传', year: '2026' }), item({ id: '2', title: '凡人修仙传 年番4', year: '2026' }))).toBe(false);
    expect(similarTitles(item({ id: '1', title: '相反的你和我', year: '2026' }), item({ id: '2', title: '正相反的你与我', year: '2025' }))).toBe(false);
    expect(similarTitles(item({ id: '1', title: '咒术回战 第二季', year: '2023' }), item({ id: '2', title: '咒术回战 第三季', year: '2023' }))).toBe(false);
    expect(similarTitles(item({ id: '1', title: '名侦探柯南 2', year: '2023' }), item({ id: '2', title: '名侦探柯南 3', year: '2023' }))).toBe(false);
  });
});
