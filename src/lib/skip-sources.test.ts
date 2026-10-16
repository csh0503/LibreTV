import { describe, expect, it } from 'vitest';
import { biliEpisodeTimes, mergeSkipTimes, parseTmdbRef, pickBiliEpisode, theIntroDbTimes } from './skip-sources';
import { buildBangumiDataMap } from './skip-times';

describe('B站官方片头片尾', () => {
  const ep = (title: string, duration: number, op: [number, number], ed: [number, number]) => ({
    title,
    duration: duration * 1000,
    skip: { op: { start: op[0], end: op[1] }, ed: { start: ed[0], end: ed[1] } },
  });

  it('总时长对得上 → 准确；0–0 表示没标', () => {
    expect(biliEpisodeTimes(ep('2', 1425, [64, 152], [1297, 1385]), 1425)).toEqual({
      intro: { start: 64, end: 152, via: 'bilibili' },
      outro: { start: 1297, end: 1385, via: 'bilibili' },
    });
    expect(biliEpisodeTimes(ep('1', 1426, [0, 0], [1366, 1424]), 1426)).toEqual({
      outro: { start: 1366, end: 1424, via: 'bilibili' },
      missing: { intro: 'none' },
    });
  });

  it('总时长差 15~90 秒 → 约略；差更多 → 不用', () => {
    expect(biliEpisodeTimes(ep('1', 1460, [0, 90], [0, 0]), 1420).intro).toEqual({ start: 0, end: 90, via: 'bilibili', approx: true });
    expect(biliEpisodeTimes(ep('1', 1600, [0, 90], [0, 0]), 1420)).toEqual({ missing: { intro: 'other-version', outro: 'other-version' } });
  });

  it('按集数标题找，找不到按顺序', () => {
    const eps = [{ title: 'PV' }, { title: '1' }, { title: '2' }];
    expect(pickBiliEpisode(eps, 2)).toBe(eps[2]);
    expect(pickBiliEpisode([{ title: '第一话' }, { title: '第二话' }], 2)?.title).toBe('第二话');
  });
});

describe('TheIntroDB', () => {
  it('一律约略；片尾 end 为 null 到结尾；电影片头 start 为 null 从开头', () => {
    expect(theIntroDbTimes({ intro: [{ start_ms: 57642, end_ms: 147062 }], credits: [{ start_ms: 1290326, end_ms: null }] }, 1440)).toEqual({
      intro: { start: 57.642, end: 147.062, via: 'theintrodb', approx: true },
      outro: { start: 1290.326, end: 1440, via: 'theintrodb', approx: true },
    });
    expect(theIntroDbTimes({ intro: [{ start_ms: null, end_ms: 40000 }] }).intro).toEqual({ start: 0, end: 40, via: 'theintrodb', approx: true });
  });

  it('parseTmdbRef', () => {
    expect(parseTmdbRef('tv/85937')).toEqual({ kind: 'tv', id: 85937, season: undefined });
    expect(parseTmdbRef('tv/85937/season/2')).toEqual({ kind: 'tv', id: 85937, season: 2 });
    expect(parseTmdbRef('movie/820232')).toEqual({ kind: 'movie', id: 820232, season: undefined });
    expect(parseTmdbRef(undefined)).toBeUndefined();
  });
});

describe('mergeSkipTimes', () => {
  it('每段挑最可靠的：准确的优先，按来源顺序；都没有时「版本对不上」优先', () => {
    const bili = { outro: { start: 1366, end: 1424, via: 'bilibili' as const }, missing: { intro: 'none' as const } };
    const aniskip = { intro: { start: 5, end: 95, via: 'aniskip' as const }, outro: { start: 1360, end: 1420, via: 'aniskip' as const } };
    const tidb = { intro: { start: 0, end: 90, via: 'theintrodb' as const, approx: true } };
    expect(mergeSkipTimes([bili, aniskip, tidb])).toEqual({ intro: aniskip.intro, outro: bili.outro });
    expect(mergeSkipTimes([undefined, tidb])).toEqual({ intro: tidb.intro, missing: { outro: 'none' } });
    expect(mergeSkipTimes([{ missing: { intro: 'other-version' } }, { missing: { intro: 'none' } }]).missing?.intro).toBe('other-version');
  });
});

describe('bangumi-data 对照表', () => {
  it('Bangumi 编号 → MAL / B站 / TMDB', () => {
    const map = buildBangumiDataMap([
      { sites: [{ site: 'bangumi', id: '245665' }, { site: 'bilibili', id: '22718131' }, { site: 'mal', id: '38000' }, { site: 'tmdb', id: 'tv/85937' }] },
      { sites: [{ site: 'mal', id: '1' }] },
    ]);
    expect(map.get('245665')).toEqual({ mal: 38000, biliMedia: '22718131', tmdb: 'tv/85937' });
    expect(map.size).toBe(1);
  });
});
