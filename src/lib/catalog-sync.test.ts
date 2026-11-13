import { describe, expect, it } from 'vitest';
import { bgmToRaw, biliToRaw, rawKeyOf, tmdbRowToRaw } from './catalog-sync';

const NOW = Date.parse('2026-11-14T04:00:00Z');

describe('各来源条目 → 本地片库原始条目', () => {
  it('TMDB：动画剧集进动漫、纪录片进纪录片、真人秀进综艺；没有中文译名的不收', () => {
    const base = { id: 1, poster_path: '/p.jpg', vote_count: 4800, vote_average: 8.7, popularity: 120, first_air_date: '1999-10-20' };
    expect(tmdbRowToRaw({ ...base, name: '航海王', genre_ids: [16, 10759], origin_country: ['JP'] }, 'tv', NOW)?.channel).toBe('anime');
    expect(tmdbRowToRaw({ ...base, name: '地球脉动', genre_ids: [99] }, 'tv', NOW)?.channel).toBe('doc');
    expect(tmdbRowToRaw({ ...base, name: '奔跑吧', genre_ids: [10764] }, 'tv', NOW)?.channel).toBe('show');
    expect(tmdbRowToRaw({ ...base, title: '星际穿越', genre_ids: [878], release_date: '2014-11-05' }, 'movie', NOW)?.channel).toBe('movie');
    expect(tmdbRowToRaw({ ...base, name: 'One Piece', genre_ids: [16] }, 'tv', NOW)).toBeUndefined();
    const op = tmdbRowToRaw({ ...base, name: '航海王', genre_ids: [16] }, 'tv', NOW)!;
    expect(op.sig).toMatchObject({ tmdbVotes: 4800, tmdbPopularity: 120, firstDate: '1999-10-20' });
  });

  it('TMDB 同一个编号的剧集和电影（tmdb_1429：进击的巨人 / 第25小时）存成两条，不互相覆盖', () => {
    const tv = tmdbRowToRaw({ id: 1429, name: '进击的巨人', poster_path: '/a.jpg', genre_ids: [16], first_air_date: '2013-04-07' }, 'tv', NOW)!;
    const movie = tmdbRowToRaw({ id: 1429, title: '第25小时', poster_path: '/b.jpg', genre_ids: [80], release_date: '2002-12-19' }, 'movie', NOW)!;
    expect(tv.id).toBe(movie.id);
    expect(rawKeyOf(tv)).not.toBe(rawKeyOf(movie));
  });

  it('Bangumi：剧场版进电影；还没播的、评分人数太少的不收', () => {
    const base = { id: 975, name: 'ONE PIECE', name_cn: '海贼王', date: '1999-10-20', images: { large: 'x.jpg' }, rating: { score: 8.0, total: 14950 }, collection: { collect: 11629, doing: 3000 } };
    const tv = bgmToRaw({ ...base, platform: 'TV' }, NOW)!;
    expect(tv.channel).toBe('anime');
    expect(tv.sig).toMatchObject({ bgmCollect: 14629, bgmVotes: 14950, firstDate: '1999-10-20' });
    expect(bgmToRaw({ ...base, platform: '剧场版' }, NOW)?.channel).toBe('movie');
    expect(bgmToRaw({ ...base, date: '2027-01-01' }, NOW)).toBeUndefined();
    expect(bgmToRaw({ ...base, rating: { score: 6, total: 3 } }, NOW)).toBeUndefined();
  });

  it('B站：总播放、最近更新日期；中配版不收', () => {
    const type = { st: 1, channel: 'anime' as const, isTv: true, area: '日本', genres: '动画' };
    const plays = biliToRaw({ season_id: 1, title: '全职猎人', cover: 'http://i0.hdslb.com/a.jpg', score: '9.8', index_show: '全92话', is_finish: 1, order: '1.6亿次播放' }, type, 'plays', 0, NOW)!;
    expect(plays.sig.biliPlays).toBe(160_000_000);
    expect(plays.cover.startsWith('https://')).toBe(true);
    expect(plays.status).toBe('ended');
    const recent = biliToRaw({ season_id: 2, title: '某新番', cover: 'https://x.jpg', index_show: '更新至第6话', is_finish: 0, order: '11月12日更新' }, type, 'recent', 3, NOW)!;
    expect(recent.sig).toMatchObject({ biliRecentRank: 3, lastDate: '2026-11-12', recentAt: NOW });
    expect(biliToRaw({ season_id: 3, title: '某番（中配）', cover: 'https://x.jpg' }, type, 'plays', 0, NOW)).toBeUndefined();
  });
});
