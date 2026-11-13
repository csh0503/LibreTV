import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bayesRating,
  decodeCursor,
  encodeCursor,
  parseBiliUpdate,
  parseChineseCount,
  popAllScore,
  popRecentScore,
  sortDateOf,
  type CatalogRawItem,
} from './catalog-rank';
import { buildChannelWorks, mergeSignals } from './catalog-build';
import { closeCatalogDb, replaceChannelWorks, upsertSourceIndex, useCatalogDbForTest, type WorkRow } from './catalog-db';
import { queryCatalog, type CatalogPage } from './catalog-query';

const NOW = Date.parse('2026-11-14T04:00:00Z');
const DAY = 86_400_000;

describe('总热门：累计人气，不扣老剧的分', () => {
  it('同样的人气，1996 年的和 2025 年的同分；国民老番排在当季新番前面', () => {
    const conan = popAllScore({ doubanVotes: 198_000, bgmCollect: 9000, tmdbVotes: 1200 });
    const newShow = popAllScore({ doubanVotes: 16_000, bgmCollect: 4000, tmdbVotes: 40 });
    expect(conan).toBeGreaterThan(newShow);
    // 分数里没有年份
    expect(popAllScore({ doubanVotes: 50_000 })).toBe(popAllScore({ doubanVotes: 50_000 }));
  });

  it('几个站都有记录的比只有一个站的高一点', () => {
    expect(popAllScore({ doubanVotes: 50_000, biliPlays: 3e8 })).toBeGreaterThan(popAllScore({ doubanVotes: 50_000 }));
  });

  it('国产剧在 TMDB 上票很少也不被拖累：107 万人评的《狂飙》排在 25 万人评的美剧前面', () => {
    const kuangbiao = popAllScore({ doubanVotes: 1_075_000, tmdbVotes: 114 });
    const usShow = popAllScore({ doubanVotes: 251_000, tmdbVotes: 11_500 });
    expect(kuangbiao).toBeGreaterThan(usShow);
  });

  it('只在 B站有百亿播放的儿童动画，排不过各站公认的《名侦探柯南》', () => {
    const kids = popAllScore({ biliPlays: 12_500_000_000 });
    const conan = popAllScore({ doubanVotes: 198_000, bgmCollect: 9000, tmdbVotes: 1200 });
    expect(conan).toBeGreaterThan(kids);
  });
});

describe('近期热播', () => {
  it('在热榜上、最近有新集的在前；三天前的名次不算', () => {
    const hot = popRecentScore({ hotRank: 0, recentAt: NOW }, { lastDate: '2026-11-10' }, 0.3, NOW);
    const stale = popRecentScore({ hotRank: 0, recentAt: NOW - 5 * DAY }, { lastDate: '2026-11-10' }, 0.3, NOW);
    const oldClassic = popRecentScore({}, { firstDate: '1999-10-20' }, 0.9, NOW);
    expect(hot).toBeGreaterThan(stale);
    expect(hot).toBeGreaterThan(oldClassic);
  });

  it('合并线索：旧名次不借别的成员新的抓取时间冒充「近期」', () => {
    const merged = mergeSignals(
      [
        { doubanHotRank: 2, recentAt: NOW - 10 * DAY },
        { tmdbVotes: 300, recentAt: NOW },
      ],
      NOW,
    );
    expect(merged.doubanHotRank).toBeUndefined();
    expect(merged.tmdbVotes).toBe(300);
  });
});

describe('最新上线 / 最高评分', () => {
  it('有确切日期的按日期；只有年份的排在同年有日期的后面；还没播的不算', () => {
    const today = '2026-11-14';
    const a = sortDateOf({ firstDate: '2026-10-02', lastDate: '2026-11-12' }, today);
    const b = sortDateOf({ firstDate: '2026-01-05' }, today);
    const c = sortDateOf({ year: 2026 }, today);
    const d = sortDateOf({ firstDate: '2025-12-31' }, today);
    expect([d, c, a, b].sort().reverse()).toEqual([a, b, c, d]);
    expect(sortDateOf({ firstDate: '2026-12-01' }, today)).toBe('');
  });

  it('人少的高分往平均分拉：50 人 9.8 分排在 10 万人 9.0 分后面', () => {
    expect(bayesRating(9.8, 50)).toBeLessThan(bayesRating(9.0, 100_000));
    expect(bayesRating(undefined, 1000)).toBe(0);
  });
});

describe('B站文字', () => {
  it('更新时间和播放量', () => {
    expect(parseBiliUpdate('8月14日更新', NOW)).toBe('2026-08-14');
    expect(parseBiliUpdate('25年5月更新', NOW)).toBe('2025-05-01');
    expect(parseBiliUpdate('12月30日更新', Date.parse('2027-01-03T00:00:00Z'))).toBe('2026-12-30');
    expect(parseChineseCount('1.6亿次播放')).toBe(160_000_000);
    expect(parseChineseCount('9800.7万次播放')).toBe(98_007_000);
  });

  it('游标编码', () => {
    const c = { v: 0.8123, id: 'tmdb_37854' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor('不是游标')).toBeUndefined();
  });
});

const raw = (over: Partial<CatalogRawItem>): CatalogRawItem => ({
  id: 'x',
  title: 'x',
  cover: 'https://img/x.jpg',
  isTv: true,
  channel: 'anime',
  sig: {},
  ...over,
});

describe('融合：同一部作品各来源合成一行（沿用 work-identity / 别名表）', () => {
  it('豆瓣「航海王」+ Bangumi「海贼王」+ B站同名 → 一部；评分校正、线索合并', async () => {
    const rows = await buildChannelWorks(
      'anime',
      [
        raw({ id: '1', origin: 'douban', title: '航海王', year: '1999', rating: '9.6', genres: '动画 冒险', sig: { doubanVotes: 120_000 } }),
        raw({ id: 'bgm_975', origin: 'bangumi', title: '海贼王', originalTitle: 'ONE PIECE', year: '1999', rating: '8.0', genres: '动画', sig: { bgmCollect: 11_600, firstDate: '1999-10-20' } }),
        raw({ id: 'tmdb_37854', origin: 'tmdb', title: '航海王', year: '1999', rating: '8.7', genres: '动画', sig: { tmdbVotes: 4800, lastDate: '2026-11-09' } }),
        raw({ id: 'bili_idx_9', origin: 'bili', title: '间谍过家家', rating: '9.6', genres: '动画', sig: { biliPlays: 3e8 } }),
      ],
      NOW,
    );
    expect(rows).toHaveLength(2);
    const op = rows.find((r) => r.title === '航海王')!;
    expect(op.first_date).toBe('1999-10-20');
    expect(op.last_date).toBe('2026-11-09');
    expect(op.sort_date).toBe('2026-11-09');
    expect(JSON.parse(op.ids_json)).toMatchObject({ douban: '1', bangumi: 'bgm_975', tmdb: 'tmdb_37854' });
    // 豆瓣 9.6 / Bangumi 8.0(+0.5) / TMDB 8.7(-0.1) 加权
    expect(op.rating).toBeGreaterThan(8.6);
    expect(op.rating).toBeLessThan(9.2);
    expect(op.pop_all).toBeGreaterThan(0.6);
  });

  it('同名不同作品（2026 年乐高特别篇 vs 1999 年老番）不合并；还没播出的不进库', async () => {
    const rows = await buildChannelWorks(
      'anime',
      [
        raw({ id: 'tmdb_1', origin: 'tmdb', title: '航海王', year: '1999', sig: { firstDate: '1999-10-20' } }),
        raw({ id: 'tmdb_2', origin: 'tmdb', title: '航海王', year: '2026', remarks: '全2集', sig: { firstDate: '2026-03-01' } }),
        raw({ id: 'tmdb_3', origin: 'tmdb', title: '还没播', year: '2027', sig: { firstDate: '2027-01-10' } }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.id).sort()).toEqual(['anime:tmdb_1', 'anime:tmdb_2']);
  });

  it('长篇分季：《银魂》三季的人气合起来算，整个系列排在单季新番前面', async () => {
    const rows = await buildChannelWorks(
      'anime',
      [
        raw({ id: '10', origin: 'douban', title: '银魂', year: '2006', genres: '动画', sig: { doubanVotes: 146_000 } }),
        raw({ id: '11', origin: 'douban', title: '银魂 第二季', year: '2011', genres: '动画', sig: { doubanVotes: 60_000 } }),
        raw({ id: '12', origin: 'douban', title: '银魂 第三季', year: '2015', genres: '动画', sig: { doubanVotes: 30_000 } }),
        raw({ id: '20', origin: 'douban', title: '某当季新番', year: '2026', genres: '动画', sig: { doubanVotes: 170_000 } }),
      ],
      NOW,
    );
    const by = (t: string) => rows.find((r) => r.title === t)!;
    expect(by('银魂').pop_all).toBeGreaterThan(by('某当季新番').pop_all);
    // 系列里仍按各季自己的人气排
    expect(by('银魂').pop_all).toBeGreaterThan(by('银魂 第三季').pop_all);
  });
});

function workRow(i: number, over: Partial<WorkRow> = {}): WorkRow {
  return {
    id: `w${String(i).padStart(4, '0')}`,
    channel: 'anime',
    title: `作品${i}`,
    title_key: `作品${i}`,
    series_key: `作品${i}`,
    original_title: null,
    is_tv: 1,
    year: 2000 + (i % 27),
    first_date: null,
    last_date: null,
    area: i % 2 ? '日本' : '中国大陆',
    genres: i % 3 ? '动画 冒险' : '动画 恋爱',
    cover: 'https://img/x.jpg',
    backdrop: null,
    status: i % 4 ? 'ended' : 'airing',
    status_guessed: 0,
    remarks: null,
    rating: 6 + (i % 40) / 10,
    ratings_json: null,
    votes: i * 10,
    // 故意让很多分数相同：游标要靠编号分出先后
    pop_all: Math.floor(i / 5) / 100,
    pop_recent: (i % 7) / 10,
    sort_rate: 6 + (i % 13) / 10,
    sort_date: i % 5 ? `20${String(10 + (i % 16)).padStart(2, '0')}-0${1 + (i % 9)}-15` : `${2000 + (i % 27)}-00-00`,
    ids_json: '{}',
    signals_json: '{}',
    updated_at: NOW,
    ...over,
  };
}

describe('片库查询：游标翻页（SQLite）', () => {
  beforeAll(() => {
    expect(useCatalogDbForTest(':memory:')).not.toBeNull();
    replaceChannelWorks('anime', Array.from({ length: 503 }, (_, i) => workRow(i)));
    upsertSourceIndex([{ sourceKey: 'env_0', vodId: '1', titleKey: '作品7', name: '作品7', remarks: '更新至12集' }]);
  });
  afterAll(() => closeCatalogDb());

  for (const sort of ['hot', 'recent', 'date', 'rate'] as const) {
    it(`${sort}：一页一页往后接，不重不漏、顺序和一次查完一样`, () => {
      const all = queryCatalog({ channel: 'anime', sort, limit: 60, cursor: null });
      expect(all?.total).toBeGreaterThan(0);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 100; guard++) {
        const page: CatalogPage = queryCatalog({ channel: 'anime', sort, limit: 17, cursor })!;
        seen.push(...page.items.map((x) => x.workId));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBe(all!.total);
      expect(seen.slice(0, 60)).toEqual(all!.items.map((x) => x.workId));
    });
  }

  it('最新：按 YYYY-MM-DD 由新到旧，只有年份的（YYYY-00-00）排在同一年有日期的后面', () => {
    const rows = Array.from({ length: 503 }, (_, i) => workRow(i));
    const expected = [...rows]
      .sort((a, b) => (a.sort_date === b.sort_date ? a.id.localeCompare(b.id) : a.sort_date < b.sort_date ? 1 : -1))
      .slice(0, 60)
      .map((r) => r.id);
    expect(queryCatalog({ channel: 'anime', sort: 'date', limit: 60 })!.items.map((x) => x.workId)).toEqual(expected);
    expect('2015-00-00' < '2015-01-15').toBe(true);
  });

  it('筛选：题材 / 地区 / 年份 / 状态 / 评分；收录了的标出片源数', () => {
    const page = queryCatalog({ channel: 'anime', sort: 'hot', genre: '恋爱', area: '日本', year: '2020', status: 'ended', minScore: 7, limit: 60 })!;
    for (const item of page.items) {
      expect(item.genres).toContain('恋爱');
      expect(item.area).toContain('日本');
      expect(item.year).toBe('2020');
      expect(item.status).toBe('ended');
      expect(parseFloat(item.rating!)).toBeGreaterThanOrEqual(7);
    }
    const seven = queryCatalog({ channel: 'anime', sort: 'hot', limit: 60, year: '2007' })!.items.find((x) => x.title === '作品7');
    expect(seven?.available).toBe(1);
  });
});
