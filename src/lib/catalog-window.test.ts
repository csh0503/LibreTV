import { describe, expect, it } from 'vitest';
import { isCurrentCatalogItem } from './catalog-window';
import { fuseCatalogItems } from './douban';
import type { DoubanItem } from './types';

const NOW = Date.UTC(2026, 9, 25);

const item = (partial: Partial<DoubanItem> & { id: string; title: string }): DoubanItem => ({
  cover: 'c',
  isTv: true,
  ...partial,
});

describe('默认片库只留现在能看的', () => {
  it('近两年的新番留下，停更的老番不留；长篇近 60 天有新集仍留', () => {
    expect(isCurrentCatalogItem(item({ id: '1', title: '今季', year: '2026' }), 'anime', NOW)).toBe(true);
    expect(isCurrentCatalogItem(item({ id: '2', title: '去年', year: '2025' }), 'anime', NOW)).toBe(true);
    expect(isCurrentCatalogItem(item({ id: '3', title: 'EVA', year: '1995' }), 'anime', NOW)).toBe(false);
    expect(
      isCurrentCatalogItem(
        item({ id: '4', title: '航海王', year: '1999', lastAired: '2026-10-10' }),
        'anime',
        NOW,
      ),
    ).toBe(true);
  });

  it('电影留近三年，剧集留近三年或还在更新的', () => {
    expect(isCurrentCatalogItem(item({ id: 'm', title: '新片', year: '2024', isTv: false }), 'movie', NOW)).toBe(true);
    expect(isCurrentCatalogItem(item({ id: 'o', title: '老片', year: '1994', isTv: false }), 'movie', NOW)).toBe(false);
    expect(isCurrentCatalogItem(item({ id: 't', title: '旧剧', year: '2016' }), 'series', NOW)).toBe(false);
    expect(
      isCurrentCatalogItem(item({ id: 'u', title: '还在播的老剧', year: '2011', lastAired: '2026-09-01' }), 'series', NOW),
    ).toBe(true);
  });

  it('热度融合时，豆瓣上的老经典不会因为也在榜上就混进默认片库', () => {
    const now = NOW;
    const fused = fuseCatalogItems(
      [
        [
          item({ id: 'new', title: '今季新番', year: '2026', rating: '7.2' }),
          item({ id: 'old', title: '命运石之门', year: '2011', rating: '9.2' }),
        ],
      ],
      10,
      { sort: 'U', anyYear: true, currentOnly: true, lane: 'anime', now },
    );
    expect(fused.map((row) => row.title)).toEqual(['今季新番']);
  });
});
