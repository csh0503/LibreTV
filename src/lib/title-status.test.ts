import { describe, expect, it } from 'vitest';
import { judgeStatus } from './title-status';

const NOW = Date.parse('2026-10-16T12:00:00+08:00');

describe('judgeStatus：连载 / 完结的唯一判定', () => {
  it('电影不分连载完结；放送表里的一律在播；来源的完结标记最可信', () => {
    expect(judgeStatus({ isTv: false, text: '更新至HD' }, NOW)).toBeUndefined();
    expect(judgeStatus({ fromCalendar: true, text: '全12集' }, NOW)).toBe('airing');
    expect(judgeStatus({ finished: true, text: '更新至3集' }, NOW)).toBe('ended');
    expect(judgeStatus({ finished: false }, NOW)).toBe('airing');
  });

  it('更新说明：各种完结写法，以及多年没改的「更新至」', () => {
    expect(judgeStatus({ text: '全24话' }, NOW)).toBe('ended');
    expect(judgeStatus({ text: '47集全' }, NOW)).toBe('ended');
    expect(judgeStatus({ text: '已完结' }, NOW)).toBe('ended');
    expect(judgeStatus({ text: '更新至第3话' }, NOW)).toBe('airing');
    expect(judgeStatus({ text: '更新至14集', year: '2023' }, NOW)).toBe('ended');
    expect(judgeStatus({ text: '更新至1150集', year: '1999' }, NOW)).toBe('airing');
  });

  it('动漫频道有放送表可对照：去年的「更新至」不在表上 → 已完结；今年的仍算在播', () => {
    expect(judgeStatus({ text: '更新至12集', year: '2025', absentFromCalendar: true }, NOW)).toBe('ended');
    expect(judgeStatus({ text: '更新至12集', year: '2026', absentFromCalendar: true }, NOW)).toBe('airing');
  });

  it('只有首播日期：当季（120 天内）算在播', () => {
    expect(judgeStatus({ airDate: '2026-10-03' }, NOW)).toBe('airing');
    expect(judgeStatus({ airDate: '2026-04-05', inferFromYear: true, hasRating: true }, NOW)).toBe('ended');
  });

  it('热榜不按年份推断（没写更新说明不代表完结），片库才推断', () => {
    expect(judgeStatus({ year: '2020' }, NOW)).toBeUndefined();
    expect(judgeStatus({ year: '2020', inferFromYear: true }, NOW)).toBe('ended');
    expect(judgeStatus({ year: '2026', inferFromYear: true, hasRating: false }, NOW)).toBeUndefined();
  });
});
