import { describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
vi.mock('./tmdb', () => ({
  tmdbGet: vi.fn(async (path: string, params: Record<string, string>) => {
    calls.push(`${path}${params.query ? `?q=${params.query}` : ''}`);
    if (path === '/search/multi') {
      return { results: [{ id: 7, media_type: 'tv', name: '药屋少女的呢喃', first_air_date: '2023-10-22', popularity: 50 }] };
    }
    if (path === '/tv/7') {
      return { name: '药屋少女的呢喃', overview: '整部剧的简介', number_of_episodes: 48, number_of_seasons: 3, status: 'Returning Series' };
    }
    if (path === '/tv/7/season/3') {
      return { air_date: '2026-10-09', overview: '第三季的简介', episodes: new Array(24).fill({}) };
    }
    return undefined;
  }),
}));

describe('带季数的片名', () => {
  it('去掉季数认出整部剧（不卡年份），资讯换成这一季的', async () => {
    const { resolveTitleIdentity } = await import('./title-identity');
    const identity = await resolveTitleIdentity({ title: '药屋少女的呢喃 第三季', year: '2026', kind: 'tv' });
    expect(calls[0]).toBe('/search/multi?q=药屋少女的呢喃');
    expect(identity?.tmdbId).toBe(7);
    expect(identity?.info).toMatchObject({ season: 3, date: '2026-10-09', episodes: 24, overview: '第三季的简介', seasons: 3 });
  });
});
