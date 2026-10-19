import { describe, expect, it } from 'vitest';
import type { DoubanItem } from './types';
import { episodeCountOf, sameWork } from './work-identity';
import { fuseCatalogItems } from './douban';
import { fuseMultiSourceRankings } from './douban-weekly';

const item = (p: Partial<DoubanItem> & { id: string; title: string }): DoubanItem => ({ cover: `${p.id}.jpg`, isTv: true, ...p });

// 用户截图：分类片库「动漫 · 2026」里的《航海王》，封面是老番、简介是 TMDB 的乐高特别篇
const classicBili = item({ id: 'bili_idx_33415', title: '航海王', year: '2026', yearSoft: true, remarks: '更新至第1150话', area: '日本', genres: '动画' });
const legoTmdb = item({ id: 'tmdb_281234', title: '航海王', year: '2026', rating: '7.7', sourceLabel: 'TMDB' });
const classicDouban = item({ id: '1453238', title: '航海王', year: '1999', rating: '9.2' });

describe('同名不同作品不合并', () => {
  it('乐高特别篇（2026 开播）和播到 1150 话的老番不是同一部', () => {
    expect(sameWork(classicBili, legoTmdb, { nowYear: 2026 })).toBe(false);
    expect(sameWork(classicDouban, legoTmdb, { nowYear: 2026 })).toBe(false);
    expect(sameWork(classicBili, classicDouban, { nowYear: 2026 })).toBe(true);
  });

  it('分类片库：两部各一张卡，老番的封面不再配乐高的年份', () => {
    const fused = fuseCatalogItems([[classicDouban], [classicBili], [legoTmdb]], 10);
    expect(fused).toHaveLength(2);
    const classic = fused.find((i) => i.id === '1453238')!;
    expect(classic.year).toBe('1999');
    expect(classic.remarks).toBe('更新至第1150话');
    const lego = fused.find((i) => i.id === 'tmdb_281234')!;
    expect(lego.cover).toBe('tmdb_281234.jpg');
  });

  it('同一来源编号不同、电影 vs 剧集、年份差两年以上：都不合并', () => {
    expect(sameWork(item({ id: 'tmdb_1', title: 'x' }), item({ id: 'tmdb_2', title: 'x' }))).toBe(false);
    expect(sameWork(item({ id: '1', title: 'x', isTv: true }), item({ id: '2', title: 'x', isTv: false }))).toBe(false);
    expect(sameWork(item({ id: '1', title: 'x', year: '2019' }), item({ id: 'tmdb_2', title: 'x', year: '2024' }))).toBe(false);
    // 跨年开播、各站登记差一年：算同一部
    expect(sameWork(item({ id: '1', title: 'x', year: '2025' }), item({ id: 'tmdb_2', title: 'x', year: '2026' }))).toBe(true);
    // B站片库和 B站热播榜是同一套编号
    expect(sameWork(item({ id: 'bili_idx_7', title: 'x' }), item({ id: 'bili_7', title: 'x' }))).toBe(true);
  });

  it('按筛选年份填的年份让位给来源自己给的', () => {
    const fused = fuseCatalogItems([[item({ id: 'bili_idx_9', title: '某番', year: '2026', yearSoft: true })], [item({ id: 'tmdb_9', title: '某番', year: '2025' })]], 10);
    expect(fused).toHaveLength(1);
    expect(fused[0].year).toBe('2025');
    expect(fused[0].yearSoft).toBeUndefined();
  });

  it('排行榜：同一系列的不同季照样合并成一个坑位，同名的电影和剧集分开', () => {
    const ranked = fuseMultiSourceRankings(
      [
        { name: '豆瓣实时剧', items: [item({ id: 'a1', title: '某剧 第三季', year: '2026', status: 'airing' }), item({ id: 'm1', title: '同名', isTv: false })] },
        { name: 'B站番剧', items: [item({ id: 'bili_1', title: '某剧', year: '2020' }), item({ id: 'bili_2', title: '同名', isTv: true })] },
      ],
      { filterEvergreen: false },
    );
    expect(ranked.filter((i) => i.title.startsWith('某剧'))).toHaveLength(1);
    expect(ranked.filter((i) => i.title === '同名')).toHaveLength(2);
  });

  it('集数：「全24集」「更新至1150话」算，「更新至20251016期」不算', () => {
    expect(episodeCountOf('全24集')).toBe(24);
    expect(episodeCountOf('更新至第1150话')).toBe(1150);
    expect(episodeCountOf('更新至20251016期')).toBeUndefined();
  });
});
