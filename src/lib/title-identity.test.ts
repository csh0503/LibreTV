import { describe, expect, it } from 'vitest';
import { collectChineseNames, pickBestMatch, toSimplified } from './title-identity';

describe('toSimplified', () => {
  it('台湾 / 香港译名转简体', () => {
    expect(toSimplified('終極盜局', 'TW')).toBe('终极盗局');
    expect(toSimplified('鬼滅之刃', 'HK')).toBe('鬼灭之刃');
  });
});

describe('pickBestMatch', () => {
  const results = [
    { id: 1, media_type: 'person', name: '大师计划' },
    { id: 2, media_type: 'movie', title: '大师计划', release_date: '2026-03-01', popularity: 50 },
    { id: 3, media_type: 'tv', name: '大师计划', first_air_date: '2015-01-01', popularity: 80 },
    { id: 4, media_type: 'movie', title: '大师计划之外', release_date: '2026-01-01', popularity: 99 },
  ];

  it('片名一致、年份对得上的优先，人物条目跳过', () => {
    expect(pickBestMatch(results, { title: '大师计划', year: '2026' })).toEqual({ id: 2, kind: 'movie' });
  });

  it('年份差太多的不认', () => {
    expect(pickBestMatch(results, { title: '大师计划', year: '2020' })).toBeUndefined();
  });

  it('繁体片名也能对上', () => {
    expect(pickBestMatch([{ id: 9, media_type: 'movie', title: '終極盜局' }], { title: '终极盗局' })).toEqual({
      id: 9,
      kind: 'movie',
    });
  });

  it('没有年份时片名必须一致', () => {
    expect(pickBestMatch([{ id: 4, media_type: 'movie', title: '大师计划之外' }], { title: '大师计划' })).toBeUndefined();
  });
});

describe('collectChineseNames', () => {
  it('收集大陆、港、台译名，转简体去重，排除查询本身和日文', () => {
    const names = collectChineseNames(
      {
        title: '大师计划',
        original_title: 'The Master Plan',
        original_language: 'en',
        translations: {
          translations: [
            { iso_3166_1: 'TW', iso_639_1: 'zh', data: { title: '終極盜局' } },
            { iso_3166_1: 'CN', iso_639_1: 'zh', data: { title: '大师计划' } },
            { iso_3166_1: 'HK', iso_639_1: 'zh', data: { title: '盜天大計' } },
            { iso_3166_1: 'JP', iso_639_1: 'ja', data: { title: 'マスタープラン' } },
          ],
        },
        alternative_titles: { titles: [{ iso_3166_1: 'TW', title: '终极盗局' }, { iso_3166_1: 'US', title: 'Master Plan' }] },
      },
      '大师计划',
    );
    expect(names).toEqual(['盗天大计', '终极盗局']);
  });

  it('华语原名也算', () => {
    expect(
      collectChineseNames({ name: '漫长的季节', original_name: '漫長的季節', original_language: 'zh' }, '漫长的季节'),
    ).toEqual([]);
  });
});

describe('extractTitleInfo', () => {
  it('剧集：简介、集数、状态、主创、平台', async () => {
    const { extractTitleInfo } = await import('./title-identity');
    const info = extractTitleInfo(
      {
        overview: ' 一段简介 ',
        genres: [{ name: '动画' }, { name: '剧情' }],
        first_air_date: '2026-10-03',
        number_of_episodes: 24,
        number_of_seasons: 2,
        status: 'Returning Series',
        vote_average: 8.26,
        vote_count: 120,
        created_by: [{ name: '某导演' }],
        networks: [{ name: 'TOKYO MX' }],
        credits: { cast: [{ name: '甲' }, { name: '乙' }] },
      },
      'tv',
    );
    expect(info).toMatchObject({
      overview: '一段简介',
      genres: ['动画', '剧情'],
      date: '2026-10-03',
      episodes: 24,
      seasons: 2,
      status: '连载中',
      rating: 8.3,
      directors: ['某导演'],
      cast: ['甲', '乙'],
      networks: ['TOKYO MX'],
    });
  });

  it('电影：片长和导演，评分人数太少不显示评分', async () => {
    const { extractTitleInfo } = await import('./title-identity');
    const info = extractTitleInfo(
      { runtime: 118, vote_average: 9, vote_count: 3, credits: { crew: [{ name: '导演甲', job: 'Director' }, { name: '编剧', job: 'Writer' }] } },
      'movie',
    );
    expect(info.runtime).toBe(118);
    expect(info.directors).toEqual(['导演甲']);
    expect(info.rating).toBeUndefined();
  });
});
