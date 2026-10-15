import { describe, expect, it } from 'vitest';
import {
  areaMatches,
  buildDoubanRequest,
  deriveStatus,
  filterHallItems,
  mergeAiringCalendar,
  rexxarToItem,
  sortHallItems,
} from './recommend';
import type { DoubanItem } from './types';

const base = {
  channel: 'movie' as const,
  genre: '全部',
  area: '全部',
  year: '全部',
  sort: 'hot' as const,
  score: 'all' as const,
  status: 'all' as const,
};

describe('buildDoubanRequest', () => {
  it('电影的题材、地区、年份和评分拼进同一次请求', () => {
    expect(buildDoubanRequest({ ...base, genre: '科幻', area: '日本', year: '2020', sort: 'rate', score: '8' })).toEqual({
      kind: 'movie',
      tags: ['科幻', '日本', '2020'],
      sort: 'S',
      score: '8,10',
      yearRange: [2020, 2020],
      minScore: 8,
    });
  });

  it('没有筛选时电影用「电影」，区间年份先取年代再留给客户端裁剪', () => {
    expect(buildDoubanRequest(base)?.tags).toEqual(['电影']);
    expect(buildDoubanRequest({ ...base, channel: 'tv', year: '2015-2018' })).toMatchObject({
      kind: 'tv',
      tags: ['电视剧', '2010年代'],
      yearRange: [2015, 2018],
    });
  });

  it('综艺和纪录片带上自己的基础标签，成人频道不请求豆瓣', () => {
    expect(buildDoubanRequest({ ...base, channel: 'show', genre: '音乐' })?.tags).toEqual(['综艺', '音乐']);
    expect(buildDoubanRequest({ ...base, channel: 'doc' })).toMatchObject({ kind: 'movie', tags: ['纪录片'] });
    expect(buildDoubanRequest({ ...base, channel: 'anime', genre: '热血' })?.tags).toEqual(['动画', '热血']);
    expect(buildDoubanRequest({ ...base, channel: 'anime', genre: '机战' })?.tags).toEqual(['动画', '机甲']);
    expect(buildDoubanRequest({ ...base, channel: 'adult' })).toBeNull();
  });
});

describe('rexxarToItem / deriveStatus', () => {
  const raw = {
    id: 1,
    title: '信号',
    year: '2016',
    card_subtitle: '2016 / 韩国 / 剧情 悬疑 / 金湲锡',
    episodes_info: '',
    pic: { large: 'https://img/a.jpg' },
    rating: { value: 9.1 },
  };

  it('剧集按上映年判断完结，更新说明优先', () => {
    expect(rexxarToItem(raw, true, 2026)).toMatchObject({
      title: '信号',
      year: '2016',
      area: '韩国',
      genres: '剧情 悬疑',
      rating: '9.1',
      status: 'ended',
    });
    expect(rexxarToItem({ ...raw, episodes_info: '更新至18集', year: '2024' }, true, 2026)?.status).toBe('airing');
    expect(rexxarToItem(raw, false, 2026)?.status).toBeUndefined();
    expect(deriveStatus({ episodesInfo: '全12集', year: '2026' }, 2026)).toBe('ended');
    expect(deriveStatus({ episodesInfo: '47集全', year: '2026' }, 2026)).toBe('ended');
    expect(deriveStatus({ fromCalendar: true, year: '2020' }, 2026)).toBe('airing');
    expect(deriveStatus({ year: '2026' }, 2026)).toBe('ended');
    expect(deriveStatus({ episodesInfo: '更新至12集', year: '2026' }, 2026)).toBe('airing');
    expect(deriveStatus({ year: '2016' }, 2026)).toBe('ended');
  });
});

describe('filterHallItems', () => {
  const items: DoubanItem[] = [
    { id: '1', title: '旧科幻', cover: 'c', year: '2012', area: '日本', genres: '科幻', rating: '8.2', isTv: true, status: 'ended' },
    { id: '2', title: '新科幻', cover: 'c', year: '2016', area: '美国', genres: '科幻', rating: '7.1', isTv: true, status: 'ended' },
    { id: '3', title: '日本无码特辑', cover: 'c', year: '2016', area: '日本', genres: '科幻', rating: '9.4', isTv: true, status: 'ended' },
  ];
  const filter = {
    genre: '全部',
    area: '全部',
    yearRange: [2015, 2018] as [number, number],
    status: 'all' as const,
    applyStatus: true,
    minScore: null,
    hideAdult: true,
  };

  it('年份区间、地区、评分和成人片名一起生效', () => {
    expect(filterHallItems(items, filter).map((item) => item.id)).toEqual(['2']);
    expect(filterHallItems(items, { ...filter, area: '日本', hideAdult: false, minScore: 9 }).map((item) => item.id)).toEqual(['3']);
    const airing = filterHallItems(
      [
        { id: 'new', title: '新番', cover: 'c', year: '2026', status: 'airing' },
        { id: 'old', title: '旧番', cover: 'c', year: '2016', status: 'ended' },
      ],
      { ...filter, yearRange: null, status: 'airing', hideAdult: false }
    );
    expect(airing.map((item) => item.id)).toEqual(['new']);
    const endedThisYear = filterHallItems(
      [{ id: 'film', title: '今年完结', cover: 'c', year: '2026', status: 'ended', rating: '9.1' }],
      { ...filter, yearRange: [2026, 2026], status: 'ended', hideAdult: false }
    );
    expect(endedThisYear.map((item) => item.id)).toEqual(['film']);
  });

  it('评分和日期可以升序、降序，没有分数的排在最后', () => {
    const rows = [
      { title: '乙', rating: '7', year: '2020' },
      { title: '甲', rating: '9', year: '2024' },
      { title: '丙' },
    ];
    expect(sortHallItems(rows, 'rate', 'desc').map((item) => item.title)).toEqual(['甲', '乙', '丙']);
    expect(sortHallItems(rows, 'rate', 'asc').map((item) => item.title)).toEqual(['乙', '甲', '丙']);
    expect(sortHallItems(rows, 'date', 'asc').map((item) => item.title)).toEqual(['乙', '甲', '丙']);
    expect(sortHallItems(rows, 'title', 'asc').map((item) => item.title)).toEqual(['丙', '甲', '乙']);
    expect(sortHallItems(rows, 'hot', 'desc').map((item) => item.title)).toEqual(['乙', '甲', '丙']);
    expect(sortHallItems(rows, 'hot', 'asc').map((item) => item.title)).toEqual(['丙', '甲', '乙']);
    expect(areaMatches('华语', '中国大陆')).toBe(true);
    expect(areaMatches('中国台湾', '中国大陆')).toBe(false);
  });

  it('副标题没写「热血」也保留，题材已经交给豆瓣标签', () => {
    const kept = filterHallItems(
      [{ id: '1', title: '咒术回战', cover: 'c', genres: '动作 动画 奇幻', year: '2026' }],
      { ...filter, genre: '热血', yearRange: null, hideAdult: false }
    );
    expect(kept.map((item) => item.id)).toEqual(['1']);
  });

  it('本周放送去重后排在前面，并标成今年连载', () => {
    const calendar: DoubanItem[] = [
      { id: 'b', title: '新科幻', cover: 'c' },
      { id: 'c', title: '本周新番', cover: 'c', rating: '6' },
    ];
    const merged = mergeAiringCalendar([items[1]], calendar, 2026);
    expect(merged.map((item) => item.title)).toEqual(['本周新番', '新科幻']);
    expect(merged[0]).toMatchObject({ status: 'airing', year: '2026', area: '日本' });
  });
});
